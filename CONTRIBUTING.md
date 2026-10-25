# Contributing

Thanks for your interest in improving Reminder App.

## Ground rules

- Do **not** commit secrets (`.env`, `llm-keys.json`, API keys, WAHA tokens, database dumps).
- Prefer small, focused pull requests with a clear description.
- Match existing TypeScript, React, and Prisma patterns in `src/`.
- Keep WhatsApp delivery as the primary notification path unless a change is explicitly scoped otherwise.

## Setup

Follow [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Use synthetic data only — never real customer or production chat exports.

## Pull requests

1. Fork / branch from `main`.
2. Run `npm run lint` and `npm run build` when practical.
3. Update docs if behavior or env vars change.
4. Explain *why* the change is needed.

## Security reports

See [docs/SECURITY.md](docs/SECURITY.md). Do not open public issues that include live credentials or private chat content.
