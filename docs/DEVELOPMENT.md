# Development

## Prerequisites

- Node.js 20+ (22 recommended)
- PostgreSQL (local or Neon)
- Optional: [WAHA](https://waha.devlike.pro/) for WhatsApp send/receive
- Optional: Groq (or other OpenAI-compatible) keys for NL parse + Whisper

## Install

```bash
git clone <REPO_URL>
cd reminder-app
cp .env.example .env
cp llm-keys.example.json llm-keys.json
# Edit .env and llm-keys.json with your values
npm install
npx prisma db push
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in with `APP_PASSWORD`.

## Useful commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Next.js + local due-reminder scheduler |
| `npm run build` | Prisma generate + production build |
| `npm run lint` | ESLint |
| `npx prisma db push` | Sync schema to the database |
| `npx prisma studio` | Browse data (local only) |

## Environment notes

- `LLM_KEYS_FILE` should point at a gitignored JSON file for large FreeLLMAPI-style key lists.
- `WAHA_BASE_URL` must include the protocol (`http://` or `https://`).
- Without WAHA, the UI and database still work; WhatsApp send/inbound will fail until configured.

## Debugging

- Inbound WhatsApp: check WAHA webhook URL and `CRON_SECRET` / `WAHA_WEBHOOK_SECRET`.
- WAHA has no per-chat webhook allowlist. Use `config.ignore` for status/channels/broadcast (`POST /api/waha/session` action `sync-inbound`); keep `groups: false` so the reminder group still works. Non-reminder groups are dropped in `/api/webhooks/waha`.
- Voice notes: ensure WAHA has media download enabled (`WHATSAPP_DOWNLOAD_MEDIA=true`).
- Parse quality: confirm at least one working key in `llm-keys.json`; local deterministic parse covers common English phrases.

## Tests

Automated test suite is minimal; verify manually:

1. Login / logout
2. Create a reminder from text
3. Dispatch via Settings or wait for the local scheduler
4. Optional: inbound WhatsApp create / snooze / list
