#!/usr/bin/env bash
set -euo pipefail
[[ "${CHECK_RESULT:-}" == success ]] || exit 1
[[ "${REVIEW_RESULT:-}" == success ]] || exit 1
[[ "${INTERFACE_RESULT:-}" == success ]] || exit 1
[[ "${WINDOWS_RESULT:-}" == success ]] || exit 1
event=${GITHUB_EVENT_NAME:-}
if [[ "$event" == push && "${GITHUB_REF:-}" != refs/heads/main ]]; then event=workflow_call; fi
case "$event" in
  pull_request|push)
    [[ "${CHANGES_RESULT:-}" == success ]] || exit 1
    case "${DESKTOP_SCOPE:-}" in
      none) [[ "${DESKTOP_RESULT:-}" == skipped ]] || exit 1 ;;
      quick|installers)
        [[ "${DESKTOP_RESULT:-}" == success && "${DESKTOP_VERIFIED:-}" == success ]] || exit 1 ;;
      *) exit 1 ;;
    esac ;;
  workflow_dispatch|workflow_call)
    [[ "${CHANGES_RESULT:-}" == skipped && "${DESKTOP_RESULT:-}" == skipped ]] || exit 1 ;;
  *) exit 1 ;;
esac
