# ChatDesk

Website chat widget + team inbox for local businesses, in the style of Birdeye Webchat.

- **Chat widget**: one `<script>` tag adds a chat bubble to any website. Visitors leave their name, mobile and message; the conversation stays on their device across page loads.
- **Inbox**: every conversation in one place, updating live. Shows when the customer is on your website right now, unread counts, open/closed, search.
- **Reply by chat or text**: while the customer is on your site, reply in the widget. Once they've left, reply by SMS (via Twilio), and texts they send back land in the same thread.
- **Calls & voicemail** (Twilio): calls ring your shop first, then go to voicemail. Voicemails show in the inbox with a play button and transcript, callers who hang up get an automatic text, and **Call back** rings your phone and connects you, showing the business number.
- **Google reviews**: see and reply to Google Business Profile reviews (with AI drafts), get alerts for new ones, and send customers your review link with **⭐ Ask for review**.
- **Facebook Messenger & Instagram**: DMs land in the same inbox and you reply from ChatDesk.
- **Office hours & away message**: outside your hours, customers get an automatic reply and the widget shows you're away.
- **Saved replies**: one-click answers to common questions, with `{name}` and `{business}` filled in. Type `/` in the reply box.
- **AI-suggested replies**: Claude drafts a reply from the conversation, your business info and saved replies, for you to check before sending.
- **Alerts**: a sound and desktop notification while the inbox is open, and an email when nobody has it open.
- **Multi-business**: each sign-up gets its own business, widget key, colour, greeting and SMS number.

## Run locally

Requires Node.js 22.13 or newer (uses the built-in `node:sqlite`, so there's no database to install).

```bash
npm install
cp .env.example .env     # set JWT_SECRET; DEFAULT_COUNTRY_CODE defaults to +61
npm run dev              # http://localhost:3000
```

1. Open http://localhost:3000 and create an account.
2. Go to **Settings** and click **Preview on a test page** to try the widget as a customer.
3. To add it to your real website, paste the snippet from Settings before `</body>`.

## Optional features

| Feature | What to set |
| --- | --- |
| Texting, calls & voicemail | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `PUBLIC_URL`. Step-by-step guide: [docs/TWILIO_SETUP.md](docs/TWILIO_SETUP.md) |
| AI-suggested replies | `ANTHROPIC_API_KEY` (uses Claude Opus 5.5 by default; override with `ANTHROPIC_MODEL`). Each suggestion is one paid API call. Add your prices and policies under Settings so drafts are accurate. |
| Google reviews, Messenger, Instagram | `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and `META_APP_ID`/`META_APP_SECRET`/`META_VERIFY_TOKEN`. Guide: [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) |
| Email alerts | `SMTP_HOST`, `SMTP_FROM`, and usually `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` from any email provider |

Office hours, away messages, saved replies and desktop alerts need no setup: turn them on in Settings.

Incoming Twilio webhooks are verified with Twilio's signature, so nobody else can post fake texts into your inbox.

## Production

```bash
npm run build
JWT_SECRET=... npm start
```

Run it behind HTTPS (session cookies are `Secure` in production). The SQLite file lives at `DATABASE_FILE`
(default `./data/chatdesk.db`), so put it on a persistent disk and back it up.

Live updates use server-sent events and an in-memory hub, so run a **single instance**. Scaling out needs
a shared pub/sub (e.g. Redis) in `server/events.ts`.

## Layout

| Path | What it is |
| --- | --- |
| `public/widget.js` | The embeddable widget (plain JS, Shadow DOM so site CSS can't break it) |
| `public/demo.html` | Test page that loads the widget |
| `server/widget.ts` | Public API the widget talks to (CORS-enabled, rate-limited, visitor token per chat) |
| `server/inbox.ts` | Signed-in inbox API, scoped to the user's business |
| `server/sms.ts`, `server/twilio.ts` | Twilio inbound webhook (signature-verified) and sending |
| `server/voice.ts`, `server/phone.ts` | Calls: ring-through, voicemail, transcripts, missed-call texts |
| `server/google.ts`, `server/meta.ts`, `server/integrations.ts` | Google Business Profile reviews; Messenger/Instagram webhook and sending; connect/disconnect and review routes |
| `server/outbound.ts` | Sends a message to a customer over whichever channel reaches them |
| `server/inbound.ts` | What happens when a customer message arrives: live update, away message, email alert |
| `server/hours.ts` | Office hours and the open/closed check |
| `server/ai.ts` | AI-suggested replies (Claude) |
| `server/notify.ts` | Google reviews, Messenger, Instagram | `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and `META_APP_ID`/`META_APP_SECRET`/`META_VERIFY_TOKEN`. Guide: [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) |
| Email alerts |
| `server/events.ts` | Live updates (SSE) and "on your website" presence |
| `server/auth.ts` | Sign-up / login with an httpOnly session cookie |
| `server/db.ts` | SQLite schema and helpers |
| `src/` | Inbox UI (React + Tailwind) |

## Ideas for next

One login managing several businesses (for agencies), automatic review requests after a job, team
members, and mobile push notifications.
