#!/bin/sh
set -e

# Ensure MIA data directory exists
mkdir -p "$HOME/.mia"

# Bridge Docker environment variables to MIA's .env file.
# MIA loads API keys from ~/.mia/.env — write them if set in the
# environment and not already present in the file.
ENV_FILE="$HOME/.mia/.env"
touch "$ENV_FILE"

for var in ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY; do
  eval val=\$$var
  if [ -n "$val" ] && ! grep -q "^${var}=" "$ENV_FILE" 2>/dev/null; then
    echo "${var}=${val}" >> "$ENV_FILE"
  fi
done

exec "$@"
