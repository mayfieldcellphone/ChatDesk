# Connecting Google, Facebook and Instagram

ChatDesk connects to your accounts the same way Birdeye does: you click **Connect** on the
**Integrations** page and sign in with Google or Facebook. Before those buttons work, ChatDesk needs
its own "app" registered with Google and with Meta. That's a one-time setup for your ChatDesk server,
covered below.

| Connection | What you get |
| --- | --- |
| **Google Business Profile** | Your Google reviews in ChatDesk, replies posted from ChatDesk (with ✨ AI drafts), alerts for new reviews, and your review link for **⭐ Ask for review**. |
| **Facebook Messenger** | Messages to your Facebook Page land in the inbox; you reply from ChatDesk. |
| **Instagram** | DMs to your Instagram professional account land in the inbox; you reply from ChatDesk. |

Google ended chat messaging on Business Profiles in July 2024, so Google brings reviews only.

All of these need ChatDesk running at its public address (`PUBLIC_URL`, for example
`https://chatdesk-production-f3ca.up.railway.app` or your own domain). If you later move to your own
domain, update the redirect and webhook URLs below to match.

---

## Where to put the keys

Either in **Railway → chatdesk → Variables**, or, without opening Railway, in ChatDesk itself:
**Integrations → 🔑 Server keys** (visible only to the ChatDesk owner: the first account created, or
the addresses in `ADMIN_EMAILS`). Keys saved there are encrypted; a key set in Railway takes priority.

---

## Google Business Profile

### 1. Create a Google Cloud project
1. Go to <https://console.cloud.google.com/>, sign in with the Google account that manages your
   Business Profile, and create a project (for example "ChatDesk").

### 2. Request Business Profile API access
Google gives these APIs to approved businesses only. Until approval, connecting works but reviews
fail with a quota or permission error.
1. Fill in Google's **Business Profile API access request** form:
   <https://support.google.com/business/contact/api_default>. Choose "Application for Basic API Access",
   and give your project number (Cloud Console → project settings).
2. Approval usually takes a few days, and Google emails you.

### 3. Enable the APIs
In **APIs & Services → Library**, enable all three:
- **My Business Account Management API**
- **My Business Business Information API**
- **Google My Business API** (this one holds reviews)

### 4. Set up the OAuth consent screen
1. **APIs & Services → OAuth consent screen** (also called "Google Auth Platform"). User type: **External**.
2. App name "ChatDesk", your email for support and developer contact.
3. Add the scope `https://www.googleapis.com/auth/business.manage`.
4. **Publish the app** (set it to "In production"). In "Testing" mode Google expires the sign-in after
   7 days and reviews stop syncing. Unverified apps show a "Google hasn't verified this app" screen;
   for your own business click **Advanced → Go to ChatDesk**. To connect *clients'* profiles without that
   warning, submit the app for Google's verification.

### 5. Create OAuth credentials
1. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type **Web application**.
2. Under **Authorized redirect URIs** add `PUBLIC_URL/api/integrations/google/callback`, for example
   `https://chatdesk-production-f3ca.up.railway.app/api/integrations/google/callback`.
3. Copy the **Client ID** and **Client secret**.

### 6. Add them to ChatDesk and connect
1. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the server (Railway → chatdesk → Variables).
2. In ChatDesk open **Integrations → Connect Google**, sign in with the account that owns your Business
   Profile, and allow access. Your locations appear, and reviews sync straight away, then every 15 minutes.

---

## Facebook Messenger and Instagram

### 1. Get your accounts ready
- You need a **Facebook Page** for the business, and you must be an admin of it.
- For Instagram: switch the Instagram account to a **professional (business or creator) account**,
  **link it to the Facebook Page** (Page settings → Linked accounts), and in the Instagram app turn on
  **Settings → Messages and story replies → Message controls → Connected tools → Allow access to messages**.

### 2. Create a Meta app
1. Go to <https://developers.facebook.com/apps>, **Create app**, and pick the **Business** type, or the
   use case for engaging with customers on Messenger and Instagram.
2. In **App settings → Basic**, copy the **App ID** and **App secret**, and fill in the privacy policy
   URL (any page on your website describing how you use customer messages).

### 3. Add Facebook Login
1. Add the **Facebook Login** (or "Facebook Login for Business") product.
2. In its settings, under **Valid OAuth Redirect URIs**, add `PUBLIC_URL/api/integrations/meta/callback`.

### 4. Set up webhooks
ChatDesk's server already has a `META_VERIFY_TOKEN` (a password Meta uses to check the webhook is
yours). Find it in Railway → chatdesk → Variables.
1. Add the **Messenger** product. Under **Webhooks**, set the callback URL to `PUBLIC_URL/api/meta/webhook`
   and the verify token to your `META_VERIFY_TOKEN`, then subscribe to **messages**, **messaging_postbacks**
   and **message_echoes**.
2. Add **Instagram** messaging (Messenger API for Instagram / Instagram webhooks) with the same callback
   URL and verify token, and subscribe to **messages**.

### 5. Add the app details to ChatDesk and connect
1. Set `META_APP_ID` and `META_APP_SECRET` on the server.
2. In ChatDesk open **Integrations → Connect Facebook & Instagram**. When Facebook asks, choose your Page
   (and its Instagram account) and allow everything listed.
3. Send your Page a message from a personal Facebook account. It should appear in the inbox within seconds.

### Your accounts vs. clients' accounts
While the Meta app is in **Development mode** it works for anyone with a role on the app (you), so your
own Page and Instagram work without review. To connect **clients'** Pages and Instagram accounts, Meta
requires **Business Verification** and **App Review** for `pages_messaging`, `pages_manage_metadata`,
`pages_show_list`, `business_management`, `instagram_basic` and `instagram_manage_messages`, after which
you switch the app to **Live**. Expect to record a short screen video showing ChatDesk receiving and
replying to a message.

Each client signs up for their own ChatDesk business (their own login) and connects their own
accounts from their Integrations page.

### Meta's rules to know
- You can reply to a customer for **24 hours** after their last message. After that Meta blocks the
  reply, and ChatDesk tells you so.
- Photos and other attachments show in the inbox as "[Photo]", "[Video]" etc.; open the conversation in
  Facebook or Instagram to see them.

---

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Connect button is grey | The server is missing `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, or `META_APP_ID`/`META_APP_SECRET`/`META_VERIFY_TOKEN`. Restart after adding them. |
| Google says `redirect_uri_mismatch` | The redirect URI in Google Cloud must match `PUBLIC_URL/api/integrations/google/callback` exactly. |
| Google connection shows ⚠ quota / permission error | API access isn't approved yet, or one of the three APIs isn't enabled. |
| Reviews stopped syncing after a week | The OAuth consent screen is still in "Testing". Publish it and connect again. |
| "Sign in to ChatDesk in this browser" after signing in to Google/Facebook | Open ChatDesk and sign in, then click Connect again in the same browser. |
| Facebook messages don't arrive | Check the webhook in the Meta app shows as verified and subscribed to `messages`; check the Page appears on the Integrations page. |
| Instagram DMs don't arrive | The Instagram account must be professional, linked to the Page, with "Allow access to messages" on. |
| Disconnecting Instagram also removed Facebook | They share one Page connection; reconnect to add the one you want. |

Tokens for connected accounts are stored encrypted. The key comes from `TOKEN_ENCRYPTION_KEY`, or
`JWT_SECRET` if that isn't set. If you change it, reconnect your accounts.
