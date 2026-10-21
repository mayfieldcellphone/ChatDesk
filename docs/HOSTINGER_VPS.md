# Running ChatDesk on a Hostinger VPS

This runs ChatDesk on your own server with HTTPS. You need about 10 minutes.

## 1. Point your domain at the VPS

In hPanel → **VPS** → your server, copy the **IPv4 address**. Then add a DNS **A record**:

| Type | Name | Points to |
|------|------|-----------|
| A | `chatdesk` (gives `chatdesk.yourdomain.com.au`) | your VPS IPv4 |

If the domain is at Hostinger: hPanel → **Domains** → your domain → **DNS / Nameservers**. If it's elsewhere, add the same record at that registrar.

## 2. Open the VPS terminal

hPanel → **VPS** → your server → **Browser terminal** (or `ssh root@YOUR_VPS_IP`).
The VPS should run Ubuntu or Debian. Docker is installed for you if it isn't there.

## 3. Download ChatDesk

The repository is private, so GitHub asks you to sign in. Create a token first: GitHub → Settings →
Developer settings → **Fine-grained tokens** → Generate. Choose *Only select repositories* → ChatDesk,
and under Repository permissions set **Contents: Read-only**. Copy the token.

```bash
git config --global credential.helper store
git clone https://github.com/mayfieldcellphone/ChatDesk.git /opt/chatdesk
```

Username: `mayfieldcellphone`. Password: paste the token. The token is saved on the server, so updates won't ask again.

## 4. Install

```bash
bash /opt/chatdesk/deploy/install.sh chatdesk.yourdomain.com.au
```

At the end it prints your ChatDesk address, the Meta webhook URL and a new **Meta verify token**. Open the
address, create your account (the first account is the owner), then enter API keys in
**Integrations → Server keys**.

## Updating

```bash
bash /opt/chatdesk/deploy/install.sh
```

This pulls the latest version and restarts. Your data and settings are kept.

## Good to know

- **Settings** are in `/opt/chatdesk/deploy/.env`. After editing, run the install command again.
- **Data** is in the Docker volume `deploy_chatdesk-data`. Turn on VPS backups/snapshots in hPanel.
- **Logs:** `cd /opt/chatdesk/deploy && docker compose logs -f app`
- If something else already uses ports 80/443 on the VPS (another website or a panel), the installer stops and shows what it is.
- After moving, update every callback URL to the new address: Twilio number webhooks, Meta webhook and
  redirect URI (`/api/integrations/meta/callback`), Google OAuth redirect (`/api/integrations/google/callback`),
  and the chat widget snippet on your websites.
