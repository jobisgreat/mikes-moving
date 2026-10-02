// MJ Moving Company — lead delivery
// Receives quote requests and claims from the website and delivers them to Mike.
//
// Channels (each turns on only when its environment variables are set):
//   Email to Mike + customer confirmation  -> Resend      RESEND_API_KEY, LEAD_FROM_EMAIL, LEAD_TO_EMAIL
//   Text message to Mike                   -> Twilio      TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (or TWILIO_MESSAGING_SERVICE_SID), LEAD_TO_PHONE
//   Instant phone push to Mike (optional)  -> Pushover    PUSHOVER_TOKEN, PUSHOVER_USER
// Optional: SEND_CUSTOMER_EMAIL=false turns off the customer confirmation email.

const MAX = { name: 80, phone: 20, email: 120, text: 2000, short: 120 };

const clean = (v, n = MAX.short) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const digits = (v) => String(v ?? '').replace(/\D/g, '');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const fmtPhone = (d) => (d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d);
const yes = (b) => (b ? 'Yes' : 'No');

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

function customerEmail(l) {
  const phone = process.env.BUSINESS_PHONE_DISPLAY || '508-215-6322';
  if (l.kind === 'quote') {
    return {
      subject: "We got your moving quote request",
      text: `Hi ${l.name.split(' ')[0]},\n\nThanks for reaching out to MJ Moving Company. We received your request for a move on ${l.date} (${l.from} to ${l.to}, ${l.size}).\n\nWe'll call or text you shortly to go over the details and get you a written quote.\n\nNeed us sooner? Call or text ${phone}. We answer 24/7.\n\nMJ Moving Company\nMovers who care`,
    };
  }
  if (l.kind === 'partner') {
    return {
      subject: "Welcome to the MJ Moving Company referral program",
      text: `Hi ${l.name.split(' ')[0]},\n\nThanks for joining the MJ Moving Company referral program. We'll call you shortly to set up your account and confirm your referral code${l.code ? ' (' + l.code + ')' : ''}, plus how and when rewards are paid.\n\nQuestions? Call or text ${phone}, 24/7.\n\nMJ Moving Company\nMovers who care`,
    };
  }
  return {
    subject: 'We received your claim',
    text: `Hi ${l.name.split(' ')[0]},\n\nThis confirms MJ Moving Company received your ${l.claimType || 'claim'}. We'll review it and respond to you in writing.\n\nIf you have photos of the damage, reply to this email and attach them.\n\nQuestions? Call or text ${phone}, 24/7.\n\nMJ Moving Company`,
  };
}

async function sendResend({ to, subject, html, text, replyTo }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.LEAD_FROM_EMAIL, to: [to], subject, html, text, reply_to: replyTo }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
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
  return {
    email: !!(env.RESEND_API_KEY && env.LEAD_FROM_EMAIL && env.LEAD_TO_EMAIL),
    sms: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_FROM || env.TWILIO_MESSAGING_SERVICE_SID) && env.LEAD_TO_PHONE),
    push: !!(env.PUSHOVER_TOKEN && env.PUSHOVER_USER),
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    // Health check: shows which channels are switched on, never any secrets.
    return res.status(200).json({ ok: true, channels: channels() });
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  // Spam guards: a hidden field real people never fill, and a minimum time on the form.
  if (body.company || (Number(body.elapsed) > 0 && Number(body.elapsed) < 2500)) {
    return res.status(200).json({ ok: true });
  }

  const { lead, errors } = validate(body);
  if (errors.length) return res.status(400).json({ ok: false, error: 'invalid', fields: errors });

  const on = channels();
  if (!on.email && !on.sms && !on.push) {
    console.error('lead_not_delivered: no channels configured', { kind: lead.kind, name: lead.name, phone: lead.phone });
    return res.status(503).json({ ok: false, error: 'not_configured' });
  }

  const m = mikeEmail(lead);
  const tasks = [];
  if (on.email) tasks.push(['email', sendResend({ to: process.env.LEAD_TO_EMAIL, subject: m.subject, html: m.html, text: m.text, replyTo: lead.email })]);
  if (on.sms) tasks.push(['sms', sendTwilio(mikeText(lead))]);
  if (on.push) tasks.push(['push', sendPushover(m.subject, mikeText(lead))]);

  const results = await Promise.allSettled(tasks.map((t) => t[1]));
  const delivered = {};
  results.forEach((r, i) => {
    delivered[tasks[i][0]] = r.status === 'fulfilled';
    if (r.status === 'rejected') console.error(`lead_channel_failed:${tasks[i][0]}`, r.reason?.message);
  });
  const reachedMike = Object.values(delivered).some(Boolean);
  if (!reachedMike) {
    console.error('lead_not_delivered: all channels failed', { kind: lead.kind, name: lead.name, phone: lead.phone });
    return res.status(502).json({ ok: false, error: 'delivery_failed' });
  }

  // Customer confirmation (best effort; never blocks the response's success).
  if (on.email && process.env.SEND_CUSTOMER_EMAIL !== 'false') {
    const c = customerEmail(lead);
    try {
      await sendResend({ to: lead.email, subject: c.subject, text: c.text, html: `<p style="font:15px Arial;white-space:pre-wrap">${esc(c.text)}</p>`, replyTo: process.env.LEAD_TO_EMAIL });
      delivered.customerEmail = true;
    } catch (e) {
      delivered.customerEmail = false;
      console.error('customer_email_failed', e.message);
    }
  }
  return res.status(200).json({ ok: true, delivered });
}
