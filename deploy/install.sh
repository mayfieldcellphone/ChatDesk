#!/usr/bin/env bash
# Installs or updates ChatDesk on an Ubuntu/Debian server (e.g. a Hostinger VPS).
#   First time:  bash deploy/install.sh chatdesk.example.com.au
#   Update:      bash deploy/install.sh
# Your settings live in deploy/.env and your data in a Docker volume; both survive updates.
set -euo pipefail
cd "$(dirname "$0")"

[ "$(id -u)" -eq 0 ] || { echo "Run this as root (or with sudo)."; exit 1; }

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi

if [ ! -f .env ]; then
  domain="${1:-}"
  [ -n "$domain" ] || read -rp "Domain for ChatDesk (e.g. chatdesk.mayfieldphonerepair.com.au): " domain
  domain="${domain#https://}"; domain="${domain#http://}"; domain="${domain%%/*}"
  [ -n "$domain" ] || { echo "A domain is needed."; exit 1; }
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

server_ip=$(curl -fsS4 https://api.ipify.org || true)
dns_ip=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)
if [ -n "$server_ip" ] && [ "$dns_ip" != "$server_ip" ]; then
  echo "!! $DOMAIN points to '${dns_ip:-nothing}', but this server is $server_ip."
  echo "   Add a DNS A record: $DOMAIN -> $server_ip. HTTPS starts working once it updates."
fi

for port in 80 443; do
  if ss -ltnH "sport = :$port" | grep -q . && ! docker compose ps --status running caddy 2>/dev/null | grep -q caddy; then
    echo "!! Something else is already using port $port on this server:"; ss -ltnp "sport = :$port" | tail -n +2
    echo "   Stop it (or tell Claude what it is) and run this script again."; exit 1
  fi
done
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443 >/dev/null
fi

if [ -d ../.git ]; then
  echo "==> Getting the latest version"
  git -C .. pull --ff-only
fi

echo "==> Building and starting (the first build takes a few minutes)"
docker compose up -d --build
docker image prune -f >/dev/null

echo "==> Waiting for ChatDesk to answer"
for _ in $(seq 1 60); do
  if docker compose exec -T app node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then
    echo
    echo "ChatDesk is running:  https://$DOMAIN"
    echo "Meta webhook URL:     https://$DOMAIN/api/meta/webhook"
    echo "Meta verify token:    $META_VERIFY_TOKEN"
    echo "Logs:                 docker compose -f $(pwd)/docker-compose.yml logs -f app"
    exit 0
  fi
  sleep 3
done
echo "ChatDesk didn't start. Recent logs:"; docker compose logs --tail 50 app; exit 1
