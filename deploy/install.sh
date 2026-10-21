#!/usr/bin/env bash
# Installs or updates ChatDesk on an Ubuntu/Debian server (e.g. a Hostinger VPS).
#   First time:  bash deploy/install.sh [chatdesk.example.com.au]
#   Update:      bash deploy/install.sh
# Your settings live in deploy/.env and your data in a Docker volume; both survive updates.
# If nginx already serves other websites on this server, ChatDesk is added to it as one more
# site and those websites are left alone. Otherwise Caddy handles HTTPS.
set -euo pipefail
cd "$(dirname "$0")"

[ "$(id -u)" -eq 0 ] || { echo "Run this as root (or with sudo)."; exit 1; }

# Update first, then restart with the new copy of this script.
if [ -d ../.git ] && [ -z "${CHATDESK_UPDATED:-}" ]; then
  echo "==> Getting the latest version"
  git -C .. pull --ff-only
  CHATDESK_UPDATED=1 exec bash "$0" "$@"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi

# Who answers web requests on this server?
web_server() { ss -ltnpH "sport = :$1" | grep -o 'users:(("[^"]*' | head -1 | sed 's/.*"//'; }
if docker compose ps --status running caddy 2>/dev/null | grep -q caddy; then
  mode=caddy
else
  holder="$(web_server 80)"; holder="${holder:-$(web_server 443)}"
  case "$holder" in
    '') mode=caddy ;;
    nginx) mode=nginx ;;
    *) echo "!! '$holder' already serves websites on this server (ports 80/443)."
       echo "   Tell Claude this name and it will adapt the setup."; exit 1 ;;
  esac
fi

server_ip=$(curl -fsS4 https://api.ipify.org || true)
free="${server_ip//./-}.sslip.io"
# Next to an existing website, ChatDesk needs its own name; the bare free address belongs to that site.
[ "$mode" = nginx ] && free="chatdesk.$free"

if [ -f .env ] && [ "$mode" = nginx ] && grep -qx "DOMAIN=${server_ip//./-}.sslip.io" .env; then
  echo "==> Your other website uses ${server_ip//./-}.sslip.io, so ChatDesk moves to $free"
  sed -i "s#^DOMAIN=.*#DOMAIN=$free#; s#^PUBLIC_URL=.*#PUBLIC_URL=https://$free#" .env
fi

if [ ! -f .env ]; then
  domain="${1:-}"
  if [ -z "$domain" ]; then
    echo "Which web address should ChatDesk use?"
    echo "  Press Enter to use a free address that works straight away: $free"
    read -rp "  Or type your own (its DNS must already point to $server_ip): " domain
  fi
  domain="${domain#https://}"; domain="${domain#http://}"; domain="${domain%%/*}"
  [ -n "$domain" ] || domain="$free"
  case "$domain" in .sslip.io|chatdesk..sslip.io) echo "Couldn't find this server's IP address. Run again with your domain: bash $0 chatdesk.example.com"; exit 1 ;; esac
  echo "==> Writing deploy/.env"
  umask 077
  cat > .env <<ENV
DOMAIN=$domain
PUBLIC_URL=https://$domain
JWT_SECRET=$(openssl rand -hex 32)
DEFAULT_COUNTRY_CODE=+61
META_APP_ID=1102120456072237
META_LOGIN_CONFIG_ID=1424769452456407
META_VERIFY_TOKEN=$(openssl rand -hex 16)
# Optional. Secrets (app secrets, auth tokens, API keys) can instead be entered in
# ChatDesk -> Integrations -> Server keys, which keeps them out of this file.
ENV
fi
set -a; . ./.env; set +a

dns_ip=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)
if [ -n "$server_ip" ] && [ "$dns_ip" != "$server_ip" ]; then
  echo "!! $DOMAIN points to '${dns_ip:-nothing}', but this server is $server_ip."
  echo "   Add a DNS A record: $DOMAIN -> $server_ip, then run this again."
  exit 1
fi
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443 >/dev/null
fi

echo "==> Building and starting (the first build takes a few minutes)"
if [ "$mode" = caddy ]; then
  docker compose --profile caddy up -d --build --remove-orphans
else
  docker compose up -d --build --remove-orphans
fi
docker image prune -f >/dev/null

if [ "$mode" = nginx ]; then
  site=/etc/nginx/sites-available/chatdesk
  if [ ! -f "$site" ] || ! grep -q "server_name $DOMAIN;" "$site"; then
    echo "==> Adding ChatDesk to nginx as $DOMAIN (your other sites are not changed)"
    cat > "$site" <<NGINX
# ChatDesk (added by /opt/chatdesk/deploy/install.sh)
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 10m;
    location / {
        proxy_pass http://127.0.0.1:3010;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        # Live inbox updates are a long-lived stream.
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
NGINX
    ln -sf "$site" /etc/nginx/sites-enabled/chatdesk
    if ! nginx -t 2>/dev/null; then
      rm -f /etc/nginx/sites-enabled/chatdesk; nginx -t || true
      echo "!! nginx didn't accept the ChatDesk site, so it was removed again. Your other sites are unchanged."; exit 1
    fi
    systemctl reload nginx
  fi
  if ! grep -q "listen 443" "$site"; then
    echo "==> Getting the HTTPS certificate"
    command -v certbot >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq certbot python3-certbot-nginx; }
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
  fi
fi

echo "==> Waiting for ChatDesk to answer"
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "https://$DOMAIN/api/health" 2>/dev/null; then
    echo
    echo "ChatDesk is running:  https://$DOMAIN"
    echo "Meta webhook URL:     https://$DOMAIN/api/meta/webhook"
    echo "Meta verify token:    $META_VERIFY_TOKEN"
    echo "Logs:                 cd $(pwd) && docker compose logs -f app"
    exit 0
  fi
  sleep 3
done
echo "ChatDesk didn't answer at https://$DOMAIN. Recent logs:"; docker compose logs --tail 50 app; exit 1
