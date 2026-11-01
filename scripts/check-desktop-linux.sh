#!/usr/bin/env bash
set -euo pipefail

# Xvfb supplies the display, Openbox supplies real maximize/minimize behavior.
openbox > /tmp/papilot-openbox.log 2>&1 &
window_manager=$!
trap 'kill "$window_manager" 2>/dev/null || true' EXIT

arch=$(node -p 'process.arch')
unpacked=linux-unpacked
if [[ "$arch" != x64 ]]; then unpacked="linux-$arch-unpacked"; fi
app="$PWD/release/desktop/$unpacked/papilot"
PAPILOT_DESKTOP_EXECUTABLE="$app" npm run test:desktop
cp test-results/desktop-demo-packaged.png test-results/desktop-linux-directory.png

# Extract-and-run exercises the actual AppImage without depending on FUSE on CI.
# The binary preflight uses the matching build resources; the launched backend
# and renderer below come from the AppImage's own temporary extraction.
image=("$PWD"/release/desktop/*.AppImage)
APPIMAGE_EXTRACT_AND_RUN=1 PAPILOT_DESKTOP_RESOURCES="$(dirname "$app")/resources" PAPILOT_DESKTOP_EXECUTABLE="${image[0]}" npm run test:desktop
cp test-results/desktop-demo-packaged.png test-results/desktop-linux-appimage.png

sudo apt-get install -y ./release/desktop/*.deb
PAPILOT_DESKTOP_EXECUTABLE=/opt/Papilot/papilot npm run test:desktop
cp test-results/desktop-demo-packaged.png test-results/desktop-linux-deb.png
