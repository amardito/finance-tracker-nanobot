#!/bin/sh
set -eu

DATA_DIR="${NANOBOT_DATA_DIR:-/data/.nanobot}"
WORKSPACE_DIR="${NANOBOT_WORKSPACE_DIR:-/tmp/nanobot/workspace}"
CONFIG_PATH="${NANOBOT_CONFIG_PATH:-/tmp/nanobot-config.json}"
BRIDGE_HOST="${BRIDGE_HOST:-127.0.0.1}"
BRIDGE_PORT="${BRIDGE_PORT:-3001}"

mkdir -p "$DATA_DIR/whatsapp-auth" "$WORKSPACE_DIR/skills/fintrack"

cat > "$WORKSPACE_DIR/skills/fintrack/SKILL.md" <<'EOF'
---
name: fintrack
description: Use FinTrack MCP tools for WhatsApp finance tracking, link codes, income, expense, budget, and account commands.
always: true
---

# FinTrack Assistant

You are the FinTrack WhatsApp assistant. When the user asks about FinTrack, money tracking, expenses, income, accounts, categories, budgets, goals, balances, proposals, or link codes, use the FinTrack MCP tools instead of answering as a generic chatbot.

Use the runtime metadata Sender ID as the FinTrack `externalUserId`. Use provider `NANOBOT_WHATSAPP`.

Link flow:
- If the user sends a link code or asks to connect WhatsApp to FinTrack, call `mcp_fintrack_redeem_claw_link_code`.
- Pass `code`, `provider`, `externalUserId`, and a short `displayName` if available.

Command flow:
- For FinTrack text commands, call `mcp_fintrack_handle_claw_text_command`.
- Pass the user's message as `text`, plus `provider`, `externalUserId`, and `messageId` if available.
- Return a concise WhatsApp-friendly answer from the tool result. If a proposal is created, mention that it is waiting for review in FinTrack.

Safety:
- Never ask for or expose raw FinTrack account tokens.
- Keep writes proposal-first. Do not claim a transaction was created unless the tool result says so.
- If the user is not linked, tell them to generate a WhatsApp link code from FinTrack Settings and send it here.
EOF

cd /app/bridge
BRIDGE_HOST="$BRIDGE_HOST" \
BRIDGE_PORT="$BRIDGE_PORT" \
AUTH_DIR="$DATA_DIR/whatsapp-auth" \
BRIDGE_TOKEN="$NANOBOT_BRIDGE_TOKEN" \
npm start &

python - "$CONFIG_PATH" <<'PY'
import json
import os
import sys

allow = [
    item.strip()
    for item in os.environ.get("NANOBOT_WHATSAPP_ALLOW_FROM", "").split(",")
    if item.strip()
]

config = {
    "gateway": {
        "host": "0.0.0.0",
        "port": int(os.environ.get("PORT", "18790")),
    },
    "agents": {
        "defaults": {
            "workspace": os.environ.get("NANOBOT_WORKSPACE_DIR", "/tmp/nanobot/workspace"),
            "provider": "custom",
            "model": os.environ["OPENAI_COMPAT_MODEL"],
            "timezone": os.environ.get("TZ", "Asia/Jakarta"),
        }
    },
    "providers": {
        "custom": {
            "apiKey": os.environ["OPENAI_COMPAT_API_KEY"],
            "apiBase": os.environ["OPENAI_COMPAT_BASE_URL"],
            "apiType": "chat_completions",
            "extraHeaders": {"Accept-Encoding": "identity"},
        }
    },
    "channels": {
        "whatsapp": {
            "enabled": True,
            "bridgeUrl": f"ws://127.0.0.1:{os.environ.get('BRIDGE_PORT', '3001')}",
            "bridgeToken": os.environ["NANOBOT_BRIDGE_TOKEN"],
            "allowFrom": allow,
            "groupPolicy": "ignore",
        }
    },
    "tools": {
        "mcpServers": {
            "fintrack": {
                "type": "streamableHttp",
                "url": os.environ["FINTRACK_MCP_URL"],
                "headers": {
                    "Authorization": "Bearer " + os.environ["FINTRACK_MCP_SERVICE_TOKEN"],
                },
                "toolTimeout": 60,
                "enabledTools": [
                    "redeem_claw_link_code",
                    "create_transaction_proposal",
                    "handle_claw_text_command",
                ],
            }
        }
    },
}

with open(sys.argv[1], "w", encoding="utf-8") as file:
    json.dump(config, file)
PY

cd /app
exec nanobot gateway --config "$CONFIG_PATH"
