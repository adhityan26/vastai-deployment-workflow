#!/usr/bin/env bash
# Block commits that contain secrets or ignored config files.
set -euo pipefail

staged_files=$(git diff --cached --name-only --diff-filter=ACM)

# 1. Refuse real config/secret files even if someone force-added them.
if echo "$staged_files" | grep -E '(^|/)(\.env(\..*)?|config\.env|.*\.local\.env|.*\.(key|pem))$' \
   | grep -vE '\.example$' | grep -q .; then
  echo "ERROR: a config/secret file is staged:" >&2
  echo "$staged_files" | grep -E '(^|/)(\.env(\..*)?|config\.env|.*\.local\.env|.*\.(key|pem))$' | grep -vE '\.example$' >&2
  exit 1
fi

# 2. Content scan with gitleaks when available.
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks protect --staged --redact --no-banner
else
  echo "WARNING: gitleaks not installed, content scan skipped" >&2
fi
