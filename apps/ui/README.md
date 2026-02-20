# @cipherscope/ui

Next.js UI for CipherScope.

## Dev

From the workspace root:

- `pnpm dev`

The UI expects the local agent on:

- HTTP: `http://127.0.0.1:17400`
- WS: `ws://127.0.0.1:17400`

Override via `.env` (see workspace `.env.example`):

- `AGENT_HTTP_URL`
- `NEXT_PUBLIC_AGENT_WS_URL`
