// Owner analytics dashboard: server-side data connector.
//
// The browser never sees the Vercel token. The page at /stats calls this
// function with the owner's private key; this function checks the key,
// asks the Vercel Web Analytics API for the numbers, and returns a small,
// already-summarised JSON payload.
//
// Vercel API used (documented):
//   GET https://api.vercel.com/v1/query/web-analytics/visits/count
//   GET https://api.vercel.com/v1/query/web-analytics/visits/aggregate

import crypto from 'node:crypto';
import config from './_analytics-config.js';

const API = 'https://api.vercel.com/v1/query/web-analytics/visits';
const DAY = 24 * 60 * 60 * 1000;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function vercel(endpoint, params, token) {
  const qs = new URLSearchParams();
  Object.keys(params).forEach(function (k) {
    const v = params[k];
    if (v === undefined || v === null || v === '') return;
    if (Array.isArray(v)) v.forEach(function (item) { qs.append(k, item); });
    else qs.append(k, String(v));
  });
  const res = await fetch(API + '/' + endpoint + '?' + qs.toString(), {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) {
    const err = new Error('Vercel API ' + endpoint + ' returned ' + res.status);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  const expected = process.env.DASHBOARD_KEY;
  const token = process.env.VERCEL_ANALYTICS_TOKEN;
  if (!expected || !token) {
    return res.status(503).json({ ok: false, error: 'setup', message: 'The dashboard is not switched on yet (missing DASHBOARD_KEY or VERCEL_ANALYTICS_TOKEN).' });
  }

  const given = req.headers['x-dashboard-key'] || (req.query && req.query.key) || '';
  if (!given || !safeEqual(given, expected)) {
    return res.status(401).json({ ok: false, error: 'key', message: 'That dashboard key is not right.' });
  }

  // Whole UTC days: today plus the 6 / 29 days before it.
  const now = new Date();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const until = new Date(todayStart + DAY).toISOString(); // end of today
  const since7 = new Date(todayStart - 6 * DAY).toISOString();
  const since30 = new Date(todayStart - 29 * DAY).toISOString();
  const base = { projectId: config.projectId, teamId: config.teamId };

  try {
    const results = await Promise.all([
      vercel('count', Object.assign({ since: since7, until: until }, base), token),
      vercel('count', Object.assign({ since: since30, until: until }, base), token),
      vercel('aggregate', Object.assign({ by: ['day'], since: since30, until: until }, base), token),
      vercel('aggregate', Object.assign({ by: ['requestPath'], since: since30, until: until, limit: 100 }, base), token),
      vercel('aggregate', Object.assign({ by: ['deviceType'], since: since30, until: until, limit: 10 }, base), token)
        .catch(function () { return null; }), // optional: the page hides the device chart if this fails
    ]);
    const c7 = results[0], c30 = results[1], daily = results[2], paths = results[3], devs = results[4];

    // Daily visitors for the last 30 days, filling any missing day with 0.
    const byDay = {};
    ((daily && daily.data) || []).forEach(function (row) {
      if (row && row.timestamp) byDay[String(row.timestamp).slice(0, 10)] = num(row.visitors);
    });
    const trend30 = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(todayStart - i * DAY).toISOString().slice(0, 10);
      trend30.push({ date: d, visitors: byDay[d] || 0 });
    }
    const trend = trend30.slice(-7);

    const pathRows = ((paths && paths.data) || [])
      .filter(function (r) { return r && r.requestPath && r.requestPath !== 'Others'; })
      .map(function (r) { return { path: r.requestPath, visitors: num(r.visitors), pageviews: num(r.pageviews) }; });

    const topPages = pathRows
      .slice()
      .sort(function (a, b) { return b.visitors - a.visitors || b.pageviews - a.pageviews; })
      .slice(0, 5)
      .map(function (r) { return { path: r.path, visitors: r.visitors }; });

    const words = config.keyPageWords;
    const keyPages = pathRows
      .filter(function (r) {
        const p = r.path.toLowerCase();
        return words.some(function (w) { return p.indexOf(w) !== -1; });
      })
      .map(function (r) { return { path: r.path, hits: r.pageviews }; })
      .filter(function (r) { return r.hits > 0; })
      .sort(function (a, b) { return b.hits - a.hits; });

    const devices = ((devs && devs.data) || [])
      .filter(function (r) { return r && r.deviceType && r.deviceType !== 'Others' && num(r.visitors) > 0; })
      .map(function (r) { return { type: String(r.deviceType).toLowerCase(), visitors: num(r.visitors) }; })
      .sort(function (a, b) { return b.visitors - a.visitors; });

    return res.status(200).json({
      ok: true,
      site: config.siteName,
      generatedAt: now.toISOString(),
      visitors: {
        last7: num(c7 && c7.data && c7.data.visitors),
        last30: num(c30 && c30.data && c30.data.visitors),
        trend: trend,
        trend30: trend30,
        devices: devices,
      },
      topPages: { period: '30 days', rows: topPages },
      keyPages: {
        period: '30 days',
        words: words,
        total: keyPages.reduce(function (s, r) { return s + r.hits; }, 0),
        rows: keyPages,
      },
    });
  } catch (e) {
    const status = e && e.status;
    const message = status === 401 || status === 403
      ? 'Vercel refused the request. The access token may be wrong or expired.'
      : status === 402
        ? 'Web Analytics is not available on this Vercel plan or project.'
        : 'Could not reach Vercel Web Analytics right now. Try again in a minute.';
    return res.status(502).json({ ok: false, error: 'upstream', message: message });
  }
}
