# Setting up texting (Twilio)

Texting lets you reply to customers by SMS after they leave your website, and puts their texts into
the ChatDesk inbox. It's optional: web chat works without it.

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
2. Choose your country, tick **SMS** under capabilities, and pick a number.
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

1. In Twilio, open **Phone Numbers → Manage → Active numbers** and click your number.
2. Under **Messaging Configuration**, set **A message comes in** to **Webhook**, with:
   - URL: `https://chat.yourshop.com.au/api/sms/inbound` (your `PUBLIC_URL` + `/api/sms/inbound`)
   - HTTP method: **HTTP POST**
3. Click **Save configuration**.

## 6. Turn it on in ChatDesk

In ChatDesk, go to **Settings → Widget & business**, enter the number in **Twilio SMS number** (for
example `+61491570006`) and click **Save**. The note under the field changes once the server has
picked up your Twilio settings.

## 7. Test it

1. From your own mobile, text the Twilio number. It should appear in the ChatDesk inbox within a few
   seconds, marked **Text**.
2. Reply with **Reply by → Text**. The text should arrive on your phone.
3. Start a chat in the widget (Settings → Preview on a test page) with your mobile number, close the
   page, and reply by text from the inbox. The customer's texted answer joins the same conversation.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| "Text" reply button is greyed out | The server is missing `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` (restart after adding them), the number isn't saved in Settings, or the customer has no mobile number. |
| "Text not sent: …" error | The message after the colon comes from Twilio. On a trial account the customer's number must be verified in Twilio first. Also check the account has credit. |
| Texts to your number don't appear in the inbox | In Twilio, open **Monitor → Logs → Errors** or the number's message logs. A **403** means `PUBLIC_URL` doesn't exactly match the webhook URL's address. A **503** means ChatDesk is missing the Twilio settings or `PUBLIC_URL`. No request at all means the webhook URL is wrong. |
| Texts appear under the wrong business, or not at all | The number in Settings must match the Twilio number exactly. ChatDesk stores it in `+61…` form. |

## Testing from your computer

Twilio needs a public `https` address, so run a tunnel such as
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
(`cloudflared tunnel --url http://localhost:3000`) or [ngrok](https://ngrok.com/) (`ngrok http 3000`).
It prints an address like `https://random-words.trycloudflare.com`. Use that as `PUBLIC_URL`, restart
ChatDesk, and use it in the Twilio webhook URL. The address changes each time you restart the tunnel,
so update both when it does.

## Keeping it legal

In Australia the Spam Act 2003 applies to commercial texts: only text people who contacted you or agreed
to it (the widget asks for this consent), say who you are, and stop texting anyone who asks you to.
Other countries have similar rules.
