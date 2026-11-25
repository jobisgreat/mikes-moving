// Tells IndexNow search engines (Bing, Yandex, Naver, Seznam, Yep...) which pages changed.
// Google does NOT take part in IndexNow; Google finds changes through sitemap.xml.
// Usage: node scripts/indexnow.mjs [--base <git-rev>] [--dry-run]
// "Changed" = URLs whose <lastmod> in sitemap.xml differs from the --base revision (default HEAD~1).
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const HOST = 'www.mjmovingco.com';
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'HEAD~1';

const keyFile = readdirSync('.').find(f => /^[a-f0-9]{32}\.txt$/.test(f));
if (!keyFile) throw new Error('No IndexNow key file (<32 hex>.txt) in the repo root.');
const key = readFileSync(keyFile, 'utf8').trim();
if (key !== keyFile.replace('.txt', '')) throw new Error('Key file content must equal its file name.');

const parse = xml => new Map([...xml.matchAll(/<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)].map(m => [m[1], m[2]]));
const now = parse(readFileSync('sitemap.xml', 'utf8'));
let before = new Map();
try { before = parse(execFileSync('git', ['show', `${base}:sitemap.xml`], { encoding: 'utf8' })); } catch { console.log('No earlier sitemap found; treating every URL as changed.'); }
const changed = [...now].filter(([u, d]) => before.get(u) !== d).map(([u]) => u);

if (!changed.length) { console.log('No changed URLs. Nothing to send.'); process.exit(0); }
console.log('Changed URLs:\n' + changed.map(u => '  ' + u).join('\n'));
if (dry) { console.log('Dry run: nothing sent.'); process.exit(0); }

// The key file must be live on the site before IndexNow will accept the request.
const keyUrl = `https://${HOST}/${keyFile}`;
const live = await fetch(keyUrl);
if (!live.ok || (await live.text()).trim() !== key) { console.error(`Key file not live at ${keyUrl} (status ${live.status}). Not sending.`); process.exit(1); }

const res = await fetch('https://api.indexnow.org/IndexNow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: HOST, key, keyLocation: keyUrl, urlList: changed })
});
console.log('IndexNow response:', res.status, res.statusText);
if (![200, 202].includes(res.status)) process.exit(1);
