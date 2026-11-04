#!/usr/bin/env bash
# Prints the desktop check that HEAD needs compared with BASE (default HEAD^1):
#   none        nothing that ships with the app changed
#   quick       the unpacked app on Apple silicon and Linux
#   installers  every installer: the installer's contents changed (its shell
#               fingerprint), or how installers are made and tested
set -euo pipefail

base=${1:-HEAD^1}
# Read the list first: a failed diff must fail, not look like an empty change.
files=$(git diff --name-only --no-renames "$base" HEAD)

scope=none
while IFS= read -r file; do
  case "$file" in
    '') ;;
    # Shipped with the app, Markdown included.
    skills/* | examples/*) [[ $scope != none ]] || scope=quick ;;
    # Never part of the app.
    *.md | LICENSE | docs/* | site/* | tests/* | i18n/* | .github/ISSUE_TEMPLATE/* | .github/workflows/pages.yml | \
    scripts/build-site.mjs | scripts/check-site.mjs | scripts/site-* | scripts/i18n.ts | scripts/i18n/*) ;;
    # How installers are made and tested.
    scripts/desktop-layer.mjs | scripts/check-desktop.mjs | scripts/check-desktop-linux.sh | .github/workflows/desktop.yml)
      scope=installers ;;
    *) [[ $scope != none ]] || scope=quick ;;
  esac
done <<< "$files"

# The installer's contents, as the Dev channel decides on new installers:
# Electron, Node, Codex, production dependencies and desktop/.
if [[ $scope == quick ]]; then
  tree=$(mktemp -d)
  git worktree add -q --detach "$tree" "$base"
  # shellcheck disable=SC2016 # ${root} is JavaScript
  node --input-type=module -e '
    const [root, base] = process.argv.slice(1);
    const { shellFingerprint } = await import(`${root}/scripts/desktop-layer.mjs`);
    process.exit(shellFingerprint(base) === shellFingerprint(root) ? 0 : 1);
  ' "$PWD" "$tree" || scope=installers
  git worktree remove --force "$tree"
fi

echo "$scope"
