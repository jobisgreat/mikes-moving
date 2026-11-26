// MJ Moving Company — lead delivery
// Receives quote requests and claims from the website and delivers them to Mike.
//
// Channels (each turns on only when its environment variables are set):
//   Email to Mike + customer confirmation  -> Resend      RESEND_API_KEY, LEAD_FROM_EMAIL, LEAD_TO_EMAIL
//   Text message to Mike                   -> Twilio      TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (or TWILIO_MESSAGING_SERVICE_SID), LEAD_TO_PHONE
//   Instant phone push to Mike (optional)  -> Pushover    PUSHOVER_TOKEN, PUSHOVER_USER
// Optional: SEND_CUSTOMER_EMAIL=false turns off the customer confirmation email.
//
// Lead Safety Net (step 1):
//   1. Every valid request is SAVED first (Supabase table "client_leads"), then emailed.   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   2. The email to the owner is tried up to 3 times.
//   3. If it still fails, the lead stays saved and Tim is alerted (no lead details in the alert).
//      ALERT_EMAIL (+ ALERT_FROM_EMAIL, optional), ALERT_PUSHOVER_TOKEN, ALERT_PUSHOVER_USER
//   4. The visitor gets a reference code (L-XXXXXX).
//   5. Suspected spam is saved as "held" and is never emailed or silently deleted.
// Safety: anywhere except Vercel production, nothing goes to the owner or to customers. Owner email goes
//   only to PREVIEW_LEAD_TO_EMAIL (if unset, no email at all), the customer confirmation goes only if the
//   customer's address equals PREVIEW_LEAD_TO_EMAIL, and text/push to the owner are off.

const MAX = { name: 80, phone: 20, email: 120, text: 2000, short: 120 };

const clean = (v, n = MAX.short) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const digits = (v) => String(v ?? '').replace(/\D/g, '');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const fmtPhone = (d) => (d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d);
const yes = (b) => (b ? 'Yes' : 'No');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SITE = () => process.env.SITE_SLUG || 'mj-moving';
const isProd = (env = process.env) => env.VERCEL_ENV === 'production';
const previewTo = (env = process.env) => (env.PREVIEW_LEAD_TO_EMAIL || '').trim();
// Where the owner email goes. Production: LEAD_TO_EMAIL. Anything else: only the preview address, or nowhere.
export const ownerTo = (env = process.env) => (isProd(env) ? env.LEAD_TO_EMAIL : previewTo(env));

// Shape checks for settings, so the health page can say "looks valid" without ever showing the value.
const ADDR = '[^\\s@<>()]+@[^\\s@<>()]+\\.[^\\s@<>()]+';
export const validFrom = (v) => new RegExp(`^(?:[^<>]+<${ADDR}>|${ADDR})$`).test(String(v || '').trim());
export const validAddr = (v) => new RegExp(`^${ADDR}$`).test(String(v || '').trim());

// Reference code the visitor sees: L- plus 6 characters with no look-alikes (no 0/O, 1/I).
export function makeRef() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = new Uint8Array(6);
  globalThis.crypto.getRandomValues(b);
  return 'L-' + Array.from(b, (x) => A[x % A.length]).join('');
}

export function validate(body) {
  const kind = ['claim', 'partner'].includes(body.kind) ? body.kind : 'quote';
  const errors = [];
  let ph = digits(body.phone);
  if (ph.length === 11 && ph[0] === '1') ph = ph.slice(1);
  const lead = {
    kind,
    name: clean(body.name, MAX.name),
    phone: ph,
    email: clean(body.email, MAX.email).toLowerCase(),
  };
  if (lead.name.length < 2) errors.push('name');
  if (ph.length !== 10) errors.push('phone');
  if (!isEmail(lead.email)) errors.push('email');

  if (kind === 'quote') {
    Object.assign(lead, {
      date: clean(body.date, 20),
      from: digits(body.from).slice(0, 5),
      to: digits(body.to).slice(0, 5),
      size: clean(body.size),
      heard: clean(body.heard),
      smsService: !!body.svc,
      smsMarketing: !!body.mkt,
      ref: clean(body.ref, 24).toUpperCase().replace(/[^A-Z0-9-]/g, ''),
    });
    if (!lead.date) errors.push('date');
    if (lead.from.length !== 5) errors.push('from');
    if (lead.to.length !== 5) errors.push('to');
    if (!lead.size) errors.push('size');
  } else if (kind === 'partner') {
    Object.assign(lead, {
      company: clean(body.company2, 100),
      role: clean(body.role, 60),
      towns: clean(body.towns, 200),
      notes: clean(body.notes, 1000),
      code: clean(body.code, 16).toUpperCase().replace(/[^A-Z0-9-]/g, ''),
    });
    if (!lead.role) errors.push('role');
  } else {
    const items = Array.isArray(body.items) ? body.items.slice(0, 20) : [];
    Object.assign(lead, {
      claimType: clean(body.claimType, 30),
      job: clean(body.job, 60),
      date: clean(body.date, 20),
      address: clean(body.address, 200),
      description: clean(body.description, MAX.text),
      photoCount: Math.max(0, Math.min(50, parseInt(body.photoCount, 10) || 0)),
      items: items
        .map((i) => ({ item: clean(i.item, 80), issue: clean(i.issue, 200), value: clean(i.value, 20) }))
        .filter((i) => i.item || i.issue),
    });
    if (!lead.description) errors.push('description');
  }
  return { lead, errors };
}

function mikeText(l) {
  if (l.kind === 'quote') {
    return `NEW QUOTE: ${l.name} ${fmtPhone(l.phone)}\nMove ${l.date} · ${l.from}→${l.to}\n${l.size}${l.heard ? ' · via ' + l.heard : ''}${l.ref ? '\nReferral code: ' + l.ref : ''}\nOK to text them: ${yes(l.smsService)}\n${l.email}`;
  }
  if (l.kind === 'partner') {
    return `NEW REFERRAL PARTNER: ${l.name}${l.company ? ' (' + l.company + ')' : ''} ${fmtPhone(l.phone)}\n${l.role}${l.towns ? ' · ' + l.towns : ''}\nSuggested code: ${l.code}\nCall them to set up.`;
  }
  return `NEW CLAIM (${l.claimType || 'claim'}): ${l.name} ${fmtPhone(l.phone)}\nMove ${l.date || '?'}${l.job ? ' · Job ' + l.job : ''}\n${l.description.slice(0, 120)}${l.description.length > 120 ? '…' : ''}\nFull details in email.`;
}

function mikeEmail(l) {
  const rows =
    l.kind === 'quote'
      ? [
          ['Name', l.name], ['Phone', fmtPhone(l.phone)], ['Email', l.email], ['Move date', l.date],
          ['From ZIP', l.from], ['To ZIP', l.to], ['Move size', l.size], ['Found us via', l.heard || '—'],
          ['OK to text about this move', yes(l.smsService)], ['OK to send offer texts', yes(l.smsMarketing)],
          ['Referral code', l.ref || '—'],
        ]
      : l.kind === 'partner'
      ? [
          ['Name', l.name], ['Company', l.company || '—'], ['Role', l.role], ['Phone', fmtPhone(l.phone)], ['Email', l.email],
          ['Works in', l.towns || '—'], ['Suggested referral code', l.code || '—'], ['Notes', l.notes || '—'],
        ]
      : [
          ['Claim type', l.claimType], ['Name', l.name], ['Phone', fmtPhone(l.phone)], ['Email', l.email],
          ['Move date', l.date || '—'], ['Bill of Lading / job #', l.job || '—'], ['Delivery address', l.address || '—'],
          ['Photos the customer has', l.photoCount ? `${l.photoCount} (ask them to reply with the photos)` : 'None attached'],
        ];
  const items =
    l.kind === 'claim' && l.items.length
      ? `<h3 style="font:700 15px Arial;margin:18px 0 6px">Items</h3><table cellpadding="6" style="border-collapse:collapse;font:14px Arial">${l.items
          .map((i) => `<tr><td style="border:1px solid #ddd"><b>${esc(i.item)}</b></td><td style="border:1px solid #ddd">${esc(i.issue)}</td><td style="border:1px solid #ddd">${i.value ? '$' + esc(i.value) : ''}</td></tr>`)
          .join('')}</table>`
      : '';
  const desc = l.kind === 'claim' ? `<h3 style="font:700 15px Arial;margin:18px 0 6px">What happened</h3><p style="font:14px Arial;white-space:pre-wrap">${esc(l.description)}</p>` : '';
  const heading = { quote: 'New quote request', claim: 'New claim / complaint', partner: 'New referral partner sign-up' }[l.kind];
  const html = `<div style="max-width:560px"><h2 style="font:800 20px Arial;color:#13275C;margin:0 0 12px">${heading}</h2>
<table cellpadding="6" style="border-collapse:collapse;font:14px Arial">${rows
    .map(([k, v]) => `<tr><td style="color:#55617A;border-bottom:1px solid #eee">${esc(k)}</td><td style="border-bottom:1px solid #eee"><b>${esc(v)}</b></td></tr>`)
    .join('')}</table>${items}${desc}
<p style="font:13px Arial;color:#55617A;margin-top:18px">Reply to this email to answer ${esc(l.name)} directly. Call or text: <b>${fmtPhone(l.phone)}</b></p></div>`;
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n') + (l.kind === 'claim' ? `\n\nItems:\n${l.items.map((i) => `- ${i.item}: ${i.issue} ${i.value ? '($' + i.value + ')' : ''}`).join('\n')}\n\nWhat happened:\n${l.description}` : '');
  const subject =
    l.kind === 'quote' ? `New quote: ${l.name} · moving ${l.date}${l.ref ? ' · ref ' + l.ref : ''}`
    : l.kind === 'partner' ? `New referral partner: ${l.name}${l.company ? ' (' + l.company + ')' : ''}`
    : `New claim: ${l.name} · ${l.claimType || 'claim'}`;
  return { subject, html, text };
}

// "Saturday, October 24" from 10/24/2026 or 2026-10-24; falls back to what the customer typed.
export function niceDate(v) {
  const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/) || String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return v;
  const [y, mo, d] = m[1].length === 4 ? [m[1], m[2], m[3]] : [m[3], m[1], m[2]];
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, 12));
  if (isNaN(dt)) return v;
  return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// Customer emails come from Mike personally. Replies go to his inbox (LEAD_TO_EMAIL).
const CUSTOMER_FROM = () => process.env.CUSTOMER_FROM_EMAIL || 'Mike Bourque <mike@mjmovingco.com>';

export function customerEmail(l) {
  const phone = process.env.BUSINESS_PHONE_DISPLAY || '508-215-6322';
  const first = l.name.split(' ')[0];
  const sig = `Mike Bourque\nOwner, MJ Moving Company\n${phone} · mjmovingco.com`;
  if (l.kind === 'quote') {
    return {
      subject: `Got your moving request, ${first}`,
      text: `Hi ${first},\n\nThis is Mike Bourque, owner of MJ Moving Company. Thanks for sending your request for ${niceDate(l.date)}, ${l.from} to ${l.to} (${l.size.toLowerCase()}).\n\nI'll call or text you shortly to go over the details. You'll get a written quote before anything is booked.\n\nIf you'd rather talk now, call or text me at ${phone}. We answer 24/7. And if anything changes, just reply to this email.\n\n${sig}`,
    };
  }
  if (l.kind === 'partner') {
    return {
      subject: `Thanks for joining, ${first}`,
      text: `Hi ${first},\n\nThis is Mike Bourque, owner of MJ Moving Company. Thanks for signing up for the referral program.\n\nI'll call you shortly to set up your account and confirm your referral code${l.code ? ' (' + l.code + ')' : ''}, plus how and when rewards are paid.\n\nAny questions before then, call or text me at ${phone}, or just reply here.\n\n${sig}`,
    };
  }
  return {
    subject: `I got your ${(l.claimType || 'claim').toLowerCase()}, ${first}`,
    text: `Hi ${first},\n\nThis is Mike Bourque, owner of MJ Moving Company. I'm sorry something went wrong with your move, and thank you for telling me.\n\nI've received your ${(l.claimType || 'claim').toLowerCase()}. I'll review it with the crew and answer you in writing.\n\nIf you have photos of the damage, reply to this email and attach them. You can also call or text me at ${phone}.\n\n${sig}`,
  };
}

// Customer-facing email: MJ logo on top, message below. Plain text version is sent alongside.
export function brandedHtml(text, site = process.env.SITE_URL || 'https://www.mjmovingco.com') {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F7FA;padding:24px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FFFFFF;border:1px solid #D8DEE8;border-radius:12px">
<tr><td align="center" style="padding:28px 24px 8px"><a href="${site}"><img src="${site}/email-logo.png" width="180" height="117" alt="MJ Moving Company" style="display:block;border:0;width:180px;height:auto"></a></td></tr>
<tr><td style="padding:12px 32px 28px;font:16px/1.55 Arial,Helvetica,sans-serif;color:#0E1A31;white-space:pre-wrap">${esc(text)}</td></tr>
</table></td></tr></table>`;
}

async function sendResend({ to, subject, html, text, replyTo, from }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: from || process.env.LEAD_FROM_EMAIL, to: [to], subject, html, text, reply_to: replyTo }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json().catch(() => ({}));
  return j.id || null;
}

// Try up to 3 times, with short pauses. Returns { id, attempts } or throws the last error.
export async function withRetry(fn, delays = [400, 1200]) {
  let last;
  for (let i = 0; i <= delays.length; i++) {
    try { return { value: await fn(), attempts: i + 1 }; } catch (e) { last = e; if (i < delays.length) await sleep(delays[i]); }
  }
  last.attempts = delays.length + 1;
  throw last;
}

// ---- Saving leads (Supabase REST, no packages). The service key never leaves the server. ----
export const storeOn = (env = process.env) => !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);
async function sb(method, path, body, env = process.env) {
  const r = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${path}`, {
    method,
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
export function leadRow(lead, ref, status, extra = {}) {
  const { name, phone, email, kind, smsService, smsMarketing, ...rest } = lead;
  return {
    ref_code: ref, site: SITE(), env: isProd() ? 'production' : 'preview', kind, status,
    name, phone, email,
    answers: rest,
    consent: kind === 'quote' ? { sms_service: !!smsService, sms_marketing: !!smsMarketing, form_version: 'mj-quote-v1' } : {},
    ...extra,
  };
}
const saveLead = (row) => sb('POST', 'client_leads', row);
const updateLead = (ref, patch) => sb('PATCH', `client_leads?ref_code=eq.${encodeURIComponent(ref)}`, { ...patch, updated_at: new Date().toISOString() });

// ---- Failure alert to Tim. Never contains the visitor's name, phone, email or answers. ----
export async function alertTim(subject, lines, env = process.env) {
  const text = lines.join('\n');
  const sent = [];
  if (env.ALERT_EMAIL && env.RESEND_API_KEY && (env.ALERT_FROM_EMAIL || env.LEAD_FROM_EMAIL)) {
    try { await sendResend({ to: env.ALERT_EMAIL, subject, html: `<pre style="font:14px Arial">${esc(text)}</pre>`, text, from: env.ALERT_FROM_EMAIL || env.LEAD_FROM_EMAIL }); sent.push('email'); } catch (e) { console.error('alert_email_failed', e.message); }
  }
  if (env.ALERT_PUSHOVER_TOKEN && env.ALERT_PUSHOVER_USER) {
    try {
      const r = await fetch('https://api.pushover.net/1/messages.json', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: env.ALERT_PUSHOVER_TOKEN, user: env.ALERT_PUSHOVER_USER, title: subject, message: text, priority: '1' }) });
      if (!r.ok) throw new Error(`pushover ${r.status}`);
      sent.push('push');
    } catch (e) { console.error('alert_push_failed', e.message); }
  }
  if (!sent.length) console.error('alert_not_sent: no alert channel worked', subject);
  return sent;
}

async function sendTwilio(body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const params = new URLSearchParams({ To: process.env.LEAD_TO_PHONE, Body: body });
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) params.set('MessagingServiceSid', process.env.TWILIO_MESSAGING_SERVICE_SID);
  else params.set('From', process.env.TWILIO_FROM);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!r.ok) throw new Error(`twilio ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function sendPushover(title, message) {
  const r = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: process.env.PUSHOVER_TOKEN, user: process.env.PUSHOVER_USER, title, message, priority: '1' }),
  });
  if (!r.ok) throw new Error(`pushover ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

export function channels(env = process.env) {
  const prod = isProd(env);
  return {
    email: !!(env.RESEND_API_KEY && env.LEAD_FROM_EMAIL && ownerTo(env)),
    sms: prod && !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_FROM || env.TWILIO_MESSAGING_SERVICE_SID) && env.LEAD_TO_PHONE),
    push: prod && !!(env.PUSHOVER_TOKEN && env.PUSHOVER_USER),
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    // Health check: shows which channels are switched on, never any secrets.
    return res.status(200).json({ ok: true, mode: isProd() ? 'production' : 'preview', store: storeOn(), settings_look_valid: { from: validFrom(process.env.LEAD_FROM_EMAIL), owner_to: validAddr(ownerTo()), alert_to: validAddr(process.env.ALERT_EMAIL) }, alert: !!(process.env.ALERT_EMAIL || process.env.ALERT_PUSHOVER_TOKEN), channels: channels() });
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const { lead, errors } = validate(body);
  if (errors.length) return res.status(400).json({ ok: false, error: 'invalid', fields: errors });

  const ref = makeRef();
  const store = storeOn();
  const extra = { source_page: clean(req.headers?.referer, 300) };

  // Spam guards: a hidden field real people never fill, and a minimum time on the form.
  // Suspects are SAVED as "held" (never emailed, never silently deleted). The visitor sees the normal thank-you.
  if (body.company || (Number(body.elapsed) > 0 && Number(body.elapsed) < 2500)) {
    if (store) { try { await saveLead(leadRow(lead, ref, 'held', { ...extra, last_error: body.company ? 'trap field filled' : 'sent too fast' })); } catch (e) { console.error('held_save_failed', e.message); } }
    return res.status(200).json({ ok: true, ref });
  }

  // 1. SAVE FIRST.
  let saved = false;
  if (store) {
    try { await saveLead(leadRow(lead, ref, 'received', extra)); saved = true; } catch (e) { console.error('lead_save_failed', ref, e.message); }
  }

  const on = channels();
  const m = mikeEmail(lead);
  const tasks = [];
  // 2. EMAIL THE OWNER (up to 3 tries).
  if (on.email) tasks.push(['email', withRetry(() => sendResend({ to: ownerTo(), subject: m.subject, html: m.html, text: m.text, replyTo: lead.email }))]);
  if (on.sms) tasks.push(['sms', sendTwilio(mikeText(lead))]);
  if (on.push) tasks.push(['push', sendPushover(m.subject, mikeText(lead))]);

  const results = await Promise.allSettled(tasks.map((t) => t[1]));
  const delivered = {};
  let emailId = null; let attempts = 0; let lastError = '';
  results.forEach((r, i) => {
    const ch = tasks[i][0];
    delivered[ch] = r.status === 'fulfilled';
    if (r.status === 'fulfilled' && ch === 'email') { emailId = r.value.value; attempts = r.value.attempts; }
    if (r.status === 'rejected') { lastError = String(r.reason?.message || r.reason).slice(0, 300); if (ch === 'email') attempts = r.reason?.attempts || 3; console.error(`lead_channel_failed:${ch}`, ref, lastError); }
  });
  const reachedOwner = Object.values(delivered).some(Boolean);

  // 3. UPDATE THE SAVED ROW, 4. ALERT TIM IF THE OWNER WAS NOT REACHED.
  const where = isProd() ? 'production' : 'preview';
  if (reachedOwner) {
    if (saved) { try { await updateLead(ref, { status: 'emailed', email_id: emailId, email_attempts: attempts }); } catch (e) { console.error('lead_update_failed', ref, e.message); } }
    else if (store) {
      // The owner got the lead, but saving is broken. Tell Tim so the safety net gets fixed before it matters.
      await alertTim(`Lead saving is failing on ${SITE()} (${where})`, [`Reference ${ref} was emailed but NOT saved. The leads table is not accepting writes.`, 'Check Supabase (project may be paused or the key changed).']);
    }
  } else {
    if (saved) { try { await updateLead(ref, { status: 'needs_attention', email_attempts: attempts, last_error: lastError || 'no channel configured' }); } catch (e) { console.error('lead_update_failed', ref, e.message); } }
    console.error('lead_not_delivered', ref, { saved, mode: where });
    await alertTim(`Lead waiting on ${SITE()} (${where})`, [
      `Reference ${ref} was ${saved ? 'SAVED but not emailed to the owner' : 'NOT SAVED and NOT emailed (no copy exists except the visitor’s own browser)'}.`,
      saved ? `Open the "client_leads" table in Supabase and find ref_code ${ref}.` : 'Check the Vercel logs for this site, then call the owner.',
      `Reason: ${lastError || 'no delivery channel is configured'}`,
    ]);
    if (!saved) return res.status(store ? 502 : 503).json({ ok: false, error: store ? 'delivery_failed' : 'not_configured' });
    // Saved, so the request is safe: tell the visitor it arrived, and show the phone number for anything urgent.
    return res.status(200).json({ ok: true, ref, queued: true, delivered });
  }

  // Customer confirmation (best effort; never blocks the response's success).
  // Outside production it goes only to the preview address, so no real customer is ever emailed from a preview.
  const confirmOk = isProd() || (previewTo() && lead.email === previewTo().toLowerCase());
  if (on.email && confirmOk && process.env.SEND_CUSTOMER_EMAIL !== 'false') {
    const c = customerEmail(lead);
    const text = `${c.text}\n\nYour reference: ${ref}`;
    try {
      await sendResend({ from: CUSTOMER_FROM(), to: lead.email, subject: c.subject, text, html: brandedHtml(text), replyTo: ownerTo() });
      delivered.customerEmail = true;
    } catch (e) {
      delivered.customerEmail = false;
      console.error('customer_email_failed', ref, e.message);
    }
  }
  return res.status(200).json({ ok: true, ref, delivered });
}
