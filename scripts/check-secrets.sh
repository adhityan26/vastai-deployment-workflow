#!/usr/bin/env bash
# Pre-commit guard: block secret/config files and scan staged content.
# Set SKIP_GITLEAKS=1 only if gitleaks is genuinely unavailable.
set -euo pipefail

# ACMR includes renames, so `git mv x .env` cannot slip through.
staged_files=$(git diff --cached --name-only --diff-filter=ACMR)

blocked=$(printf '%s\n' "$staged_files" | grep -E \
  '(^|/)(\.env(\..*)?|\.npmrc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials.*\.json|secrets/.*)$|\.(key|pem|p12|pfx)$' \
  | grep -vE '^\.env\.example$' \
  || true)
# Only the repository-root .env.example is exempt from the file-name block above; its STAGED
# content is checked below instead.

if [ -n "$blocked" ]; then
  echo "ERROR: config/secret files are staged:" >&2
  printf '%s\n' "$blocked" >&2
  exit 1
fi

if printf '%s\n' "$staged_files" | grep -qxF '.env.example'; then
  # Check the staged blob, not the working tree. Print line numbers and key names, never values.
  bad=$(git show :.env.example | awk '
    /^[[:space:]]*(#|$)/ { next }
    {
      line = $0
      eq = index(line, "=")
      if (eq == 0) next
      key = substr(line, 1, eq - 1); val = substr(line, eq + 1)
      gsub(/^[ \t]+|[ \t]+$/, "", key); gsub(/^[ \t"\x27]+|[ \t"\x27]+$/, "", val)
      ukey = toupper(key)
      if (val != "" && ukey ~ /(SECRET|KEY|TOKEN|PASSWORD)/ && ukey !~ /_FILE$/) { print NR ": " key " (secret-like key with a value)"; next }
      if (val ~ /tskey-/ || val ~ /ghp_/ || val ~ /[0-9a-fA-F]{32,}/ || val ~ /[A-Za-z0-9+\/_-]{40,}/) print NR ": " key " (secret-like value)"
    }')
  if [ -n "$bad" ]; then
    echo "ERROR: .env.example (staged) must hold placeholders only:" >&2
    printf '%s\n' "$bad" >&2
    exit 1
  fi
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
