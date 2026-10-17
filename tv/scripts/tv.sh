#!/usr/bin/env bash
# Pull the latest code, then build, sign, install and launch the app on a real Samsung TV.
# Usage: scripts/tv.sh [tv-ip] [samsung-security-profile]
# Defaults: TV 192.168.0.181, profile home-tv (its distributor certificate must list the
# TV's DUID). The TV must be in Developer mode with this computer's IP set.
# Set NO_PULL=1 to install the working tree as-is.
set -euo pipefail
TV_IP="${1:-192.168.0.181}"
PROFILE="${2:-home-tv}"
TIZEN_HOME="${TIZEN_HOME:-$HOME/tizen-studio}"
export PATH="$TIZEN_HOME/tools/ide/bin:$TIZEN_HOME/tools:$PATH"
APP_ID="Anime1TV01.Anime1TV"
cd "$(dirname "$0")/.."

if [ -z "${NO_PULL:-}" ]; then
  git pull --ff-only
  npm install --no-audit --no-fund
fi

sdb connect "$TV_IP" >/dev/null
TARGET="$(sdb devices | awk -v ip="$TV_IP" 'index($1, ip ":") == 1 && $2 == "device" {print $3; exit}')"
[ -n "$TARGET" ] || { echo "TV $TV_IP not connected. Is Developer mode on and the TV awake?" >&2; exit 1; }

npm run package -- --profile "$PROFILE"
WGT="build/Anime1TV.wgt"
OUT="$(tizen install -n "$WGT" -t "$TARGET" 2>&1 || true)"
echo "$OUT"
echo "$OUT" | grep -q "successfully installed" \
  || { echo "Install failed. Wrong profile? Check the TV's DUID is in '$PROFILE'." >&2; exit 1; }
tizen run -p "$APP_ID" -t "$TARGET"
echo "Running on $TARGET ($TV_IP)."
