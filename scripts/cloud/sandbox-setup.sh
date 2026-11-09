#!/usr/bin/env bash
# One-time setup inside the persistent Vercel Sandbox that runs DY's Workie worker.
# Usage (from a Mac): sandbox cp scripts/cloud/sandbox-setup.sh workie-dy-worker:/home/ubuntu/
#                     sandbox exec workie-dy-worker bash /home/ubuntu/sandbox-setup.sh <git-commit>
set -euo pipefail
COMMIT="${1:?usage: sandbox-setup.sh <workie git commit>}"
NODE_VERSION=22.23.2

# Xvfb: the worker opens a visible Chromium. gnome-keyring + dbus: the worker only
# accepts the Secret Service keychain on Linux. XeLaTeX + TeX Gyre: tailored PDFs.
sudo DEBIAN_FRONTEND=noninteractive apt-get update -q
sudo DEBIAN_FRONTEND=noninteractive apt-get install -yq --no-install-recommends \
  git ca-certificates curl build-essential python3 xvfb xauth dbus dbus-x11 gnome-keyring libsecret-tools \
  texlive-xetex texlive-fonts-recommended texlive-latex-extra fonts-texgyre fonts-liberation

# The sandbox image sets an npm prefix in ~/.npmrc, which nvm refuses to work with.
sed -i '/^prefix=/d' "$HOME/.npmrc" 2>/dev/null || true
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
. "$NVM_DIR/nvm.sh"
nvm install "$NODE_VERSION" >/dev/null
nvm alias default "$NODE_VERSION" >/dev/null

if [ ! -d "$HOME/workie/.git" ]; then
  git clone --filter=blob:none https://github.com/DY0810/Workie.git "$HOME/workie"
fi
cd "$HOME/workie"
git fetch -q origin
git checkout -q "$COMMIT"
npm ci --no-audit --no-fund
npx playwright install --with-deps chromium

umask 077
mkdir -p "$HOME/.local/share/workie-worker-dy" "$HOME/private"
chmod 700 "$HOME/.local/share/workie-worker-dy" "$HOME/private"
echo "setup ok: node $(node -v), workie $(git rev-parse --short HEAD), $(xelatex --version | head -1)"
