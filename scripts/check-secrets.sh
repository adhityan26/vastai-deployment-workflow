#!/usr/bin/env bash
# Pre-commit guard: block secret/config files and scan staged content.
# Set SKIP_GITLEAKS=1 only if gitleaks is genuinely unavailable.
set -euo pipefail

# ACMR includes renames, so `git mv x .env` cannot slip through.
staged_files=$(git diff --cached --name-only --diff-filter=ACMR)

blocked=$(printf '%s\n' "$staged_files" | grep -E \
  '(^|/)(\.env(\..*)?|\.npmrc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials.*\.json|secrets/.*)$|\.(key|pem|p12|pfx)$' \
  || true)

if [ -n "$blocked" ]; then
  echo "ERROR: config/secret files are staged:" >&2
  printf '%s\n' "$blocked" >&2
  exit 1
fi

if command -v gitleaks >/dev/null 2>&1; then
  gitleaks git --staged --redact --no-banner
elif [ "${SKIP_GITLEAKS:-0}" = "1" ]; then
  echo "WARNING: gitleaks missing, content scan skipped (SKIP_GITLEAKS=1)" >&2
else
  echo "ERROR: gitleaks is not installed; refusing to commit without a content scan." >&2
  echo "Install it, or set SKIP_GITLEAKS=1 to bypass knowingly." >&2
  exit 1
fi
