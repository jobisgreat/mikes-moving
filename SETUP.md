# Mike's Moving Company: make the quote form live

The website is finished, and so is the code that delivers leads. Each lead reaches Mike as soon as a channel below is switched on. Without any channel, the form tells customers to call 508-215-6322, so no lead disappears without anyone knowing.

## What each lead does

| Channel | What Mike gets | Account needed | Time to set up |
|---|---|---|---|
| Email | Full quote or claim in his inbox. Hitting Reply answers the customer. | Resend (free up to 3,000 emails/month) | 15 minutes, plus adding DNS records to the domain |
| Customer confirmation | The customer gets a "We got your request" email | Same Resend account | Included |
| Text message | Short text to 508-215-6322 with name, phone, date and route | Twilio (about $1.15/month for the number plus about 1¢ per text) | Account takes 10 minutes. **Carrier registration (A2P 10DLC) takes several days to 2 weeks.** Texts may be blocked until it's approved. |
| Instant phone alert (optional) | Loud push notification on Mike's phone | Pushover app (one-time $5) | 5 minutes. Works the same day. |

Recommendation: turn on **Email plus Pushover** now, so Mike is alerted within seconds from day one. Start the **Twilio registration** at the same time. Texts switch on as soon as it's approved.

## Steps

1. **Resend** (resend.com): sign up, add the domain the site will use (for example mikesmovingcompany.com), and add the DNS records it shows. Then create an API key.
2. **Pushover** (pushover.net): install the app on Mike's phone and create an "application." Copy the **user key** and the **API token**.
3. **Twilio** (twilio.com): sign up, buy a local number, and complete **Sole Proprietor A2P 10DLC** registration using the business's legal name. Copy the Account SID, the Auth Token and the number.
4. **Vercel**: Project, then Settings, then Environment Variables. Add the values listed in `.env.example`. Paste keys straight into Vercel, not into chat or email.
5. Redeploy. Check `https://YOUR-SITE/api/lead` in a browser. It shows which channels are on (true/false) and never shows any keys.
6. Send one test quote yourself before telling anyone about the site.

## Files

- `index.html` is the website.
- `api/lead.js` is the lead delivery code. It's a Vercel serverless function and needs no npm packages.
- `vercel.json` holds security and caching settings.
- `.env.example` lists every setting the function reads.
- The images, video and icons are the remaining files.

## Referral program

Partner sign-ups from the Referral program page reach Mike the same way quotes do. A partner's link (`yoursite.com/?ref=MMC-JANED`) tags any quote that visitor sends, so Mike sees "ref MMC-JANED" in the text and the email subject. **Set the reward amount and payout rules before promoting the program.** The page deliberately doesn't state a number.

## Before going public

- Fix the USDOT number in the footer. The number provided (2232023) belongs to another company.
- Make sure the text-consent checkboxes name the business's legal name exactly as registered with Twilio.
- Point the domain at Vercel and update the email address on the site if the domain changes.
