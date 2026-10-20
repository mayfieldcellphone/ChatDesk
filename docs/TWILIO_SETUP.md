# Setting up texting and calls (Twilio)

One Twilio number gives ChatDesk:

- **Texting**: reply to customers by SMS, and their texts land in the inbox.
- **Calls & voicemail**: calls ring your shop first, then go to voicemail. Voicemails appear in the inbox
  with a play button and a transcript, and callers who hang up get an automatic text.
- **Call back**: one click rings your phone and connects you to the customer, showing your business number.

It's optional: web chat works without it.

**Before you start:** ChatDesk must be running on the internet at an `https://` address (for example
`https://chat.yourshop.com.au`). Twilio has to reach your server to deliver incoming texts, and it
can't reach `localhost`. If you only want to try it from your computer first, see
[Testing from your computer](#testing-from-your-computer).

## 1. Create a Twilio account

1. Sign up at <https://www.twilio.com/try-twilio> and verify your email and mobile number.
2. While the account is a **trial**, you can only text numbers you've verified in Twilio, and messages
   start with "Sent from your Twilio trial account". Upgrade (add a payment method) before using it
   with real customers.

## 2. Get an SMS number

1. In the Twilio Console, open **Phone Numbers → Manage → Buy a number**.
2. Choose your country, tick **SMS** and **Voice** under capabilities, and pick a number. In Australia
   that means a **mobile** number (04…): local landline numbers can't send or receive texts.
3. **Australia (and many other countries) require a Regulatory Bundle** before you can buy a local
   mobile number: your business name, ABN or company registration, and an address. Twilio walks you
   through it when you try to buy, and approval can take a few business days. Check current prices on
   Twilio's pricing page for your country.

Use a **mobile number that supports SMS**, not an alphanumeric sender ID: customers need to be able to
reply.

## 3. Copy your Account SID and Auth Token

On the Twilio Console home page, under **Account Info**, copy the **Account SID** (starts with `AC`) and
the **Auth Token**. Treat the Auth Token like a password: never paste it into the website code or share
it.

## 4. Add them to ChatDesk's server

Set these environment variables where ChatDesk runs (your hosting provider's "Environment variables"
or "Secrets" page, or the `.env` file on your own server), then restart ChatDesk:

```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your-auth-token
PUBLIC_URL=https://chat.yourshop.com.au
```

`PUBLIC_URL` must be exactly the address people use to open ChatDesk: `https://`, no trailing slash.
ChatDesk uses it to check that incoming texts really come from Twilio.

## 5. Point the number at ChatDesk

In Twilio, open **Phone Numbers → Manage → Active numbers** and click your number. Replace
`https://chat.yourshop.com.au` below with your `PUBLIC_URL`, and use **HTTP POST** for every one.

| Section | Field | URL |
| --- | --- | --- |
| Voice Configuration | **A call comes in** (Webhook) | `https://chat.yourshop.com.au/api/voice/incoming` |
| Voice Configuration | **Call status changes** | `https://chat.yourshop.com.au/api/voice/status` |
| Messaging Configuration | **A message comes in** (Webhook) | `https://chat.yourshop.com.au/api/sms/inbound` |

Click **Save configuration**. ChatDesk's Settings page shows these exact URLs for your server too.

## 6. Turn it on in ChatDesk

In ChatDesk, go to **Settings → Widget & business**, enter the number in **Twilio SMS number** (for
example `+61491570006`) and click **Save**. The note under the field changes once the server has
picked up your Twilio settings.

## 7. Set up calls

In ChatDesk **Settings → Phone calls & voicemail**:

- **Ring this phone first**: your shop or mobile number. During office hours ChatDesk rings it for the
  number of seconds you choose, then sends the caller to voicemail. Leave it empty to send every call
  straight to voicemail.
- **Voicemail greeting**: what callers hear before the beep.
- **Missed-call text**: the automatic text a caller gets when you miss them (at most once an hour each).
- **Your mobile, for Call back**: the phone ChatDesk rings when you click 📞 Call back.

## 8. Test it

1. From your own mobile, text the Twilio number. It should appear in the ChatDesk inbox within a few
   seconds, marked **Text**.
2. Reply with **Reply by → Text**. The text should arrive on your phone.
3. Call the Twilio number from a phone that isn't the "ring first" number, let it go to voicemail and
   leave a message. Within about a minute the inbox shows the missed call, the voicemail with a play
   button, then the transcript. The caller gets your missed-call text.
4. Open that conversation and click **📞 Call back**: your phone rings, and when you answer you're
   connected to the caller.

## Keeping the number customers already know

Customers probably call your existing shop number. Two ways to bring those calls into ChatDesk:

- **Forward missed calls (easiest, keep your number).** Ask your phone carrier to turn on *conditional
  call forwarding* ("forward when busy / no answer / unreachable") to your Twilio number. Your phone
  still rings first; if you don't answer, the call reaches ChatDesk's voicemail. In this setup, leave
  **Ring this phone first** empty, or calls will bounce back and forth. Texts to your old number won't
  come through, so put the Twilio number on your website and Google profile for texting.
- **Port your number to Twilio.** Move the number itself into Twilio (Console → Phone Numbers → Port &
  Host). Then calls and texts to the number everyone knows go through ChatDesk, and **Ring this phone
  first** can point at your mobile. If the number currently belongs to Birdeye, ask them how to release
  it before you cancel.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| "Text" reply button is greyed out | The server is missing `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` (restart after adding them), the number isn't saved in Settings, or the customer has no mobile number. |
| "Text not sent: …" error | The message after the colon comes from Twilio. On a trial account the customer's number must be verified in Twilio first. Also check the account has credit. |
| Texts to your number don't appear in the inbox | In Twilio, open **Monitor → Logs → Errors** or the number's message logs. A **403** means `PUBLIC_URL` doesn't exactly match the webhook URL's address. A **503** means ChatDesk is missing the Twilio settings or `PUBLIC_URL`. No request at all means the webhook URL is wrong. |
| Texts appear under the wrong business, or not at all | The number in Settings must match the Twilio number exactly. ChatDesk stores it in `+61…` form. |
| Callers hear "this number isn't set up yet" | The Twilio number isn't saved in ChatDesk Settings, or doesn't match exactly. |
| Calls don't show in the inbox | Check the **A call comes in** webhook URL and method (POST). Twilio's call logs (**Monitor → Logs → Calls**) show the error. |
| Missed calls stay as "Incoming call…" | The **Call status changes** webhook isn't set. |
| Voicemail plays but there's no transcript | Twilio's transcription is English-only and skips recordings it can't make out. Press play to listen. |
| 📞 Call back says to add your mobile | Enter it under **Settings → Phone calls & voicemail**. |

## Testing from your computer

Twilio needs a public `https` address, so run a tunnel such as
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
(`cloudflared tunnel --url http://localhost:3000`) or [ngrok](https://ngrok.com/) (`ngrok http 3000`).
It prints an address like `https://random-words.trycloudflare.com`. Use that as `PUBLIC_URL`, restart
ChatDesk, and use it in the Twilio webhook URL. The address changes each time you restart the tunnel,
so update both when it does.

## Costs

Twilio charges for the number each month, plus per text, per call minute (including the minutes a
forwarded call rings your shop and call-backs, which are two legs), per voicemail transcription and for
storing recordings. Check Twilio's pricing page for your country, and set up usage alerts under
**Billing**. You can delete old recordings in the Twilio Console.

## Keeping it legal

In Australia the Spam Act 2003 applies to commercial texts: only text people who contacted you or agreed
to it (the widget asks for this consent), say who you are, and stop texting anyone who asks you to.
Other countries have similar rules. If you record calls beyond voicemail, check your state's
call-recording rules.
