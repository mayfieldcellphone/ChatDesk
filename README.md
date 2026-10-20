# ChatDesk

Website chat widget + team inbox for local businesses, in the style of Birdeye Webchat.

- **Chat widget**: one `<script>` tag adds a chat bubble to any website. Visitors leave their name, mobile and message; the conversation stays on their device across page loads.
- **Inbox**: every conversation in one place, updating live. Shows when the customer is on your website right now, unread counts, open/closed, search.
- **Reply by chat or text**: while the customer is on your site, reply in the widget. Once they've left, reply by SMS (via Twilio), and texts they send back land in the same thread.
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

## Texting (optional)

1. Buy an SMS-capable number in Twilio.
2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `PUBLIC_URL` (your server's public https address) in `.env`.
3. In Twilio, set the number's **A message comes in** webhook to `PUBLIC_URL/api/sms/inbound` (HTTP POST).
4. In ChatDesk **Settings**, enter the number.

Incoming webhooks are verified with Twilio's signature, so nobody else can post fake texts into your inbox.

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
| `server/sms.ts` | Twilio send + verified inbound webhook |
| `server/events.ts` | Live updates (SSE) and "on your website" presence |
| `server/auth.ts` | Sign-up / login with an httpOnly session cookie |
| `server/db.ts` | SQLite schema and helpers |
| `src/` | Inbox UI (React + Tailwind) |

## Ideas for next

Canned replies, assigning conversations to teammates, email/push notifications for new chats,
office hours and an away message, AI-suggested replies, and Google review requests after a job.
