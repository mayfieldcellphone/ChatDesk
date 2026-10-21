#!/usr/bin/env bash
# One-paste setup for a fresh VPS: signs in to GitHub (the repo is private), downloads ChatDesk
# to /opt/chatdesk and runs the installer. The same block is in docs/HOSTINGER_VPS.md.
set -e
if ! command -v gh >/dev/null 2>&1; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq && apt-get install -y -qq gh git
fi
gh auth status >/dev/null 2>&1 || gh auth login --hostname github.com --git-protocol https --web --skip-ssh-key
gh auth setup-git
[ -d /opt/chatdesk ] || gh repo clone mayfieldcellphone/ChatDesk /opt/chatdesk
bash /opt/chatdesk/deploy/install.sh "$@"
