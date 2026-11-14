# ChatBird progress notes

The one place to see where ChatBird is up to. Keep it short and current: update it at the end of
every working session (Claude does this when asked, see CLAUDE.md). The printable folder version is
made from the same information.

Last updated: 14 Nov 2026

## Where things stand

- **ChatBird v1.1** runs Mayfield Phone Repair (Birdeye cancelled). v1.0 = commit `2d023d1`; v1.1 (who's calling, bookings with reminders) merged to `main` on 14 Nov 2026.
- **Branches:** `main` is the tested version Mayfield runs. New work happens on other branches and only reaches `main` when the owner says “merge”.
- **Live server:** Hostinger VPS, folder `/opt/chatdesk`, address https://chatdesk.31-97-66-240.sslip.io
- **Mayfield stays on v1.0** while ChatBird is made into a product. Only update it after a new
  version has been tested on staging.
- **Next big goal:** sell ChatBird to other businesses (see Roadmap).

## How to…

| Task | What to do |
|---|---|
| Update the live server | Hostinger → VPS → Browser terminal: `cd /opt/chatdesk && bash deploy/install.sh && git log --oneline -1` |
| See backups | ChatBird → Integrations → Backups (nightly, 14 kept, emailed every Monday) |
| ChatBird is down | Calls still ring your mobile (Twilio “Primary handler fails” → TwiML Bin “Ring mobile”). UptimeRobot emails you. Restart: `cd /opt/chatdesk/deploy && docker compose restart app` |
| Turn the AI receptionist off | Settings → AI phone receptionist → Off (instant) |
| Start a new Claude session | Say: “Read docs/PROGRESS.md first, then …” |

## Accounts (names only, never passwords or keys here)

| Service | Used for | Where |
|---|---|---|
| Hostinger | VPS that runs ChatBird | hpanel.hostinger.com |
| GitHub | The code (mayfieldcellphone/ChatDesk) | github.com |
| Twilio | AU number 0485 002 786, calls and texts | console.twilio.com |
| Anthropic | AI (assistant, receptionist, captions) | console.anthropic.com |
| OpenAI | Voicemail transcripts | platform.openai.com |
| Google Cloud | Business Profile API (reviews, posts, listings) | console.cloud.google.com |
| Meta for Developers | App “ChatBird” (Messenger, Instagram, posting) | developers.facebook.com |
| UptimeRobot | Down alerts by email | uptimerobot.com |
| Gmail SMTP | ChatBird’s emails | Google account |

## Added in v1.1 (14 Nov 2026, on main)

- **Who's calling:** phone notification as a ChatBird call rings your mobile, and “ChatBird call
  from Sarah, 0412…” when you answer (Settings → Phone calls, on by default). Australian networks
  often show ChatBird's number instead of the caller's.
- **Bookings with reminders:** new Bookings page. Website and AI receptionist bookings get a real
  date and time; 📅 Booking adds one in a conversation. Texts the evening before and 2 hours before;
  reply C confirms, R tags Needs reply. Mark Arrived / No-show; a no-show can get a “want to rebook?”
  text. No-show rate on the Bookings page.
## What ChatBird does (v1.0)

- **Inbox:** website chat, texts (with photos), Messenger, Instagram, email, calls and voicemails in
  one place. Tags, saved replies, contact card, AI reply suggestions, lead source on every
  conversation, Repair done button.
- **Phone:** rings your mobile first, voicemail with transcript, missed-call text, AI phone
  receptionist (bookings, call-backs, transfers, holiday hours), fallback to mobile if ChatBird is down.
- **AI assistant:** answers website chat and texts from your FAQs and notes, hands over when unsure.
- **Reviews:** Google reviews synced, AI replies (auto for 4–5★), low-star alerts, review requests
  (button, Repair done, automatic), QR codes for the shop, reviews widget for the website, share good
  reviews to Facebook and Instagram.
- **Marketing:** customer lists (phone backups, Birdeye, RepairBill, Excel), text and email
  campaigns with STOP handling, social posts with poster maker, Auto posts for weeks or months.
- **Listings:** one place for hours, holiday hours, phone, website and description, sent to Google,
  Facebook, the website and ChatBird; checklist for other sites.
- **Reports:** conversations by source, how website visitors found you, response times, calls,
  reviews and requests, QR scans, CSV export, weekly email.
- **Safety:** nightly backups (emailed weekly), health check, opt-outs respected everywhere.

## Roadmap: selling ChatBird

Tick boxes as you go. Dates are targets, not promises.

### Phase 1: business set-up (weeks 1–2)
- [ ] Check the name “ChatBird” on IP Australia and pick a domain
- [ ] Company or ABN, business bank account
- [ ] Stripe account (AUD)
- [ ] Start Meta app review and business verification (takes 2–6 weeks)
- [ ] Start Google OAuth verification for Business Profile (takes 2–6 weeks)
- [ ] Terms of service and privacy policy

### Phase 2: product (weeks 2–6), new server, Mayfield untouched
- [ ] New server for ChatBird Cloud, plus a staging copy for testing
- [ ] Self sign-up and setup wizard
- [ ] Billing: plans, free trial, usage limits (texts, AI minutes, users)
- [ ] Phone numbers inside the app (Twilio sub-account per customer, AU regulatory bundle)
- [ ] Admin console (customers, usage, costs, log in as for support)
- [ ] Help pages and onboarding emails
- [ ] Update `ws` and `body-parser` packages (security fixes)

### Phase 3: pilot (weeks 6–10)
- [ ] 5–10 founding businesses (40% off for life for a testimonial)
- [ ] Fix what they find, write the Mayfield case study with real numbers

### Phase 4: launch
- [ ] Marketing website with live chat and a number to call the AI receptionist
- [ ] RepairBill partnership or referral deal
- [ ] Google Ads on “Birdeye alternative”, “Podium alternative Australia”
- [ ] Referral programme

## Draft pricing (AUD per month per location; check Twilio and Anthropic prices first)

| Plan | Price | Main features | Est. cost |
|---|---|---|---|
| Starter | A$49 | Inbox, widget, reviews + AI replies, review requests, QR, 100 texts | ~A$20 |
| Growth | A$99 | + AI assistant, campaigns, posts, listings, reports, 300 texts | ~A$45 |
| Pro | A$179 | + AI phone receptionist (150 min), 600 texts, unlimited users | ~A$95 |

Add-ons: extra location A$39, 1,000 texts A$90, receptionist minutes A$0.25.

## Decisions made

| Date | Decision | Why |
|---|---|---|
| Nov 2026 | Reminders on by default; automatic no-show texts off by default | A wrong “we missed you” text to someone in the shop is worse than none |
| Oct 2026 | Build ChatBird instead of paying for Birdeye | Cost, control, AI features |
| Nov 2026 | Name and address only change in Google itself, not from Listings | Google re-verifies those |
| Nov 2026 | One codebase; Mayfield on its own server, pinned to tested versions | Selling must not disturb the shop |

## Parking lot (ideas for later)

- Own domain for ChatBird (then reprint QR codes, update Meta and Google settings)
- Tickets with assignee and time-to-resolve; NPS survey; AI insights from reviews
- Public API and webhooks; white-label for agencies
