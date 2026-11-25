// Site health checks for www.mjmovingco.com. Zero dependencies (Node 20+).
// Usage: node scripts/site-health.mjs [uptime|links]
//   uptime : sitemap + every sitemap page returns 200, no noindex, key content still present
//   links  : also follows every internal link found on those pages and checks it resolves
// Emails a report to REPORT_TO_EMAIL via Resend ONLY when something fails
// (or always with ALWAYS_EMAIL=1). Never sends anywhere but that one address.
const BASE = (process.env.SITE_URL || 'https://www.mjmovingco.com').replace(/\/$/, '');
const mode = process.argv[2] || 'uptime';
const REQUIRED_HOME = ['8403736', 'What customers say']; // USDOT number and reviews banner on the home page
const problems = [];
const notes = [];

async function get(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'mj-site-health/1.0' } });
  const body = res.headers.get('content-type')?.includes('text') || /xml|html/.test(res.headers.get('content-type') || '') ? await res.text() : '';
  return { res, body };
}

const sm = await get(`${BASE}/sitemap.xml`).catch((e) => ({ err: e }));
if (sm.err || !sm.res.ok) {
  problems.push(`sitemap.xml unreachable (${sm.err ? sm.err.message : sm.res.status})`);
}
const urls = sm.body ? [...sm.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim()) : [];
if (sm.body && urls.length === 0) problems.push('sitemap.xml lists no URLs');
notes.push(`Checked ${urls.length} sitemap URLs on ${BASE}`);

const internal = new Set();
for (const url of urls) {
  try {
    const { res, body } = await get(url);
    if (res.status !== 200) { problems.push(`${url} returned ${res.status}`); continue; }
    if (/noindex/i.test(res.headers.get('x-robots-tag') || '')) problems.push(`${url} has a noindex header`);
    if (/<meta[^>]+name=["']robots["'][^>]+noindex/i.test(body)) problems.push(`${url} has a noindex meta tag`);
    if (!/<title>[^<]+<\/title>/i.test(body)) problems.push(`${url} has no title`);
    if (url === `${BASE}/` || url === BASE) {
      for (const t of REQUIRED_HOME) if (!body.includes(t)) problems.push(`Home page is missing expected text: "${t}"`);
    }
    if (mode === 'links') {
      for (const m of body.matchAll(/href=["']([^"'#]+)(?:#[^"']*)?["']/g)) {
        let h = m[1];
        if (/^(mailto:|tel:|sms:|javascript:)/i.test(h) || /[${}]/.test(h)) continue; // skip script template strings
        try { h = new URL(h, url).href; } catch { continue; }
        if (h.startsWith(BASE)) internal.add(h);
      }
    }
  } catch (e) {
    problems.push(`${url} failed: ${e.message}`);
  }
}

if (mode === 'links') {
  for (const link of internal) {
    try {
      const { res } = await get(link);
      if (res.status >= 400) problems.push(`Broken link: ${link} returned ${res.status}`);
    } catch (e) {
      problems.push(`Broken link: ${link} failed: ${e.message}`);
    }
  }
  notes.push(`Followed ${internal.size} internal links`);
}

const when = new Date().toISOString();
const report = [`MJ Moving site ${mode} check, ${when}`, ...notes, problems.length ? `${problems.length} problem(s):` : 'No problems found.', ...problems.map((p) => `- ${p}`)].join('\n');
console.log(report);

if ((problems.length || process.env.ALWAYS_EMAIL === '1') && process.env.RESEND_API_KEY && process.env.REPORT_TO_EMAIL) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: process.env.REPORT_FROM_EMAIL,
      to: [process.env.REPORT_TO_EMAIL],
      subject: `${problems.length ? 'PROBLEM: ' : ''}MJ Moving site ${mode} check`,
      text: report,
    }),
  });
  console.log('Email status', r.status, r.ok ? '' : (await r.text()).slice(0, 300));
  if (!r.ok) process.exitCode = 1;
}
if (problems.length) process.exitCode = 1;
