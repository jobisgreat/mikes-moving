// Search Console reports for www.mjmovingco.com. Zero dependencies (Node 20+).
// Usage: node scripts/search-console-report.mjs indexed|performance
//   indexed     : URL Inspection API for every sitemap URL (what Google says about each page)
//   performance : Search Analytics for the last full calendar month (clicks, impressions, top queries and pages)
// Auth: Google service account key in GOOGLE_SERVICE_ACCOUNT_JSON (read-only scope).
// Emails the report to REPORT_TO_EMAIL only (Resend). Never sends anywhere else.
import { createSign } from 'node:crypto';
const mode = process.argv[2] || 'indexed';
const SITE = process.env.GSC_SITE_URL || 'https://www.mjmovingco.com/';
let key = {};
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

async function token() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const claim = b64({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/webmasters.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = createSign('RSA-SHA256').update(`${head}.${claim}`).sign(key.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(`Google sign-in failed: ${JSON.stringify(j)}`);
  return j.access_token;
}

let lines = [];
let failed = false;
try {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').replace(/^\uFEFF/, '').replace(/[\u201C\u201D]/g, '"').trim();
  try { key = JSON.parse(raw); } catch {
    // Safe diagnostics: length and the character codes of the first 4 characters only, never the secret text.
    throw new Error(`The GOOGLE_SERVICE_ACCOUNT_JSON secret in GitHub is not valid JSON. Re-paste the whole key file, from the first { to the last }. Secret length ${raw.length} characters; first 4 character codes: ${[...raw.slice(0, 4)].map((c) => c.charCodeAt(0)).join(', ') || 'none'}.`);
  }
  const at = await token();
  const auth = { authorization: `Bearer ${at}`, 'content-type': 'application/json' };
  if (mode === 'indexed') {
    const sm = await (await fetch(`${SITE}sitemap.xml`)).text();
    const urls = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
    lines.push(`Search Console indexing report, ${new Date().toISOString().slice(0, 10)}`, `Property ${SITE}, ${urls.length} sitemap URLs. Google's index version only; not a live test.`, '');
    let notIndexed = 0;
    for (const u of urls) {
      const r = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', { method: 'POST', headers: auth, body: JSON.stringify({ inspectionUrl: u, siteUrl: SITE }) });
      const j = await r.json();
      if (!r.ok) { lines.push(`${u}: ERROR ${r.status} ${j.error?.message || ''}`); failed = true; continue; }
      const s = j.inspectionResult?.indexStatusResult || {};
      if (s.verdict !== 'PASS') notIndexed++;
      lines.push(`${s.verdict === 'PASS' ? 'OK ' : 'CHECK'} ${u}\n   ${s.coverageState || 'no state'} | last crawl ${s.lastCrawlTime || 'never'} | canonical ${s.googleCanonical || 'n/a'}`);
    }
    lines.splice(2, 0, `${urls.length - notIndexed} of ${urls.length} pages show verdict PASS.`);
  } else {
    const d = new Date(); const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)); const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    const f = (x) => x.toISOString().slice(0, 10);
    const q = async (dimensions) => {
      const r = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE)}/searchAnalytics/query`, { method: 'POST', headers: auth, body: JSON.stringify({ startDate: f(start), endDate: f(end), dimensions, rowLimit: 10 }) });
      const j = await r.json(); if (!r.ok) throw new Error(`${r.status} ${j.error?.message}`); return j.rows || [];
    };
    const tot = await q([]);
    lines.push(`Search Console performance, ${f(start)} to ${f(end)} (data through the last date Google returned)`, '', `Clicks ${tot[0]?.clicks ?? 0} | Impressions ${tot[0]?.impressions ?? 0}`, '', 'Top queries:');
    for (const r of await q(['query'])) lines.push(`- ${r.keys[0]}: ${r.clicks} clicks, ${r.impressions} impressions`);
    lines.push('', 'Top pages:');
    for (const r of await q(['page'])) lines.push(`- ${r.keys[0]}: ${r.clicks} clicks, ${r.impressions} impressions`);
  }
} catch (e) {
  failed = true;
  lines = [`MJ Moving Search Console ${mode} report FAILED`, String(e.message)];
}
const report = lines.join('\n');
console.log(report);
if (process.env.RESEND_API_KEY && process.env.REPORT_TO_EMAIL) {
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: process.env.REPORT_FROM_EMAIL, to: [process.env.REPORT_TO_EMAIL], subject: `${failed ? 'PROBLEM: ' : ''}MJ Moving ${mode === 'indexed' ? 'weekly indexing' : 'monthly performance'} report`, text: report }) });
  console.log('Email status', r.status);
}
if (failed) process.exitCode = 1;
