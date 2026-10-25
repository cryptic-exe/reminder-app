# Security

## Reporting a vulnerability

If you find a security issue, please report it privately to the repository owner (GitHub Security Advisories preferred). Do **not** open a public issue that includes:

- Live API keys, tokens, or passwords
- Private WhatsApp chat content or phone numbers
- Production database dumps

## Secret management

| Item | Expected handling |
|------|-------------------|
| `.env` | Local / host secrets only — never commit |
| `llm-keys.json` | Gitignored; copy from `llm-keys.example.json` |
| `WAHA_API_KEY`, `CRON_SECRET`, `SESSION_SECRET`, `APP_PASSWORD` | Strong unique values per environment |
| Voice files under `.data/` | Local media cache — never commit |

Use `.env.example` as a template with placeholders only.

## Assumptions

- This app is designed as a **single-user** password gate, not multi-tenant SaaS auth.
- WhatsApp access depends on your WAHA instance security and network exposure.
- Cron dispatch endpoints must be protected with `CRON_SECRET` (Bearer token).
- Webhooks should use a shared secret query/header matching your deployment.

## If credentials were exposed

1. Rotate the affected keys immediately (LLM providers, WAHA, database, session secret).
2. Invalidate sessions by changing `SESSION_SECRET`.
3. Review Git history and hosting logs.
4. Treat any previously committed secret as compromised even after deletion from the latest tree.
