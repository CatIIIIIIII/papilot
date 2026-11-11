#!/usr/bin/env bash
# Fails unless every package named is fully installed: dpkg knows packages
# that are only unpacked, half configured or removed too.
set -euo pipefail
dpkg-query -W -f='${db:Status-Abbrev} ${Package}\n' "$@" | awk '$1 != "ii" { print "Not installed: " $2; bad = 1 } END { exit bad }'
