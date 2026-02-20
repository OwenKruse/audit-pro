# TODO: TASK.md Remaining Work

This repo currently implements the **Section 1 deliverable** from `TASK.md` plus early Milestone A/B groundwork: a running Next.js UI connected to the agent, durable SQLite capture, a local HTTP proxy (HTTP + CONNECT tunneling) with intercept, History list/detail, and a basic Repeater (replay + persisted variants/diff).

The remaining items in `TASK.md` are large, multi-milestone features. They are **not impossible**, but they are not implemented yet. This file centralizes requirements and completion specs so future work can be done without ambiguity.

## Agent: TLS Proxy + Capture (Milestone A)

Status:

- Implemented: HTTP proxy, CONNECT tunneling, TLS MITM (decrypt HTTPS), intercept queue, History rows, ws:// and wss:// frame capture.
- Implemented: export/import case files (zip with SQLite snapshot + manifest).
- Implemented: Proxy UI troubleshooting (macOS setup steps + “Generate Test Traffic” smoke test).
- Missing: cert rotation UX, upstream TLS policy UI, and per-OS setup guidance beyond macOS.

Requirements:

- HTTP proxy with CONNECT tunneling.
- Full TLS MITM with locally generated CA (first run) and per-host certs.
- Intercept on/off queue: allow, drop, forward.
- Capture pipeline persists:
  - raw request/response
  - structured headers/cookies/query
  - JSON body (attempted parse) and raw fallback
  - timing fields (dns/connect/tls/ttfb/total)
- WebSocket frame capture (direction/opcode/timestamp, attempt JSON parse).
- Export/import “case file” zip (DB + artifacts).

Completion specs:

- Capturing an HTTPS dapp session produces history rows and WS frames.
- Turning intercept on/off reliably changes behavior without losing capture.
- Exported case file can be imported into a new project and browsed.

## Agent: Replay (Repeater) (Mostly Implemented)

Status:

- Implemented: `POST /replay`, `POST /replay/batch`, variant persistence (`parent_id`) and replay diff persistence (`replay_diff_json`), basic UI Repeater.
- Missing: richer request composer (params editor + cookie jar UI), variant list/management, stronger batch determinism, and more advanced diff/visualization.

## Crypto Decoding + Flow Graph (Milestone B)

Requirements:

- Heuristic classifiers: WalletConnect, SIWE, JSON-RPC, swap/bridge/approve patterns.
- Flow graph: group messages by correlation and tag ordered steps.
- ABI vault: add/upload ABIs, known addresses per chain; optional verified ABI fetch.
- Decode:
  - tx call data (selector + args)
  - logs for common standards (ERC20 Transfer/Approval)
  - EIP-712 typed data with risky-field highlighting

Completion specs:

- Captured `eth_sendTransaction` / typed-data signing renders decoded meaning.
- “Flow view” groups sequences with tags (sign/approve/swap).

## Anvil Sandbox (Milestone C)

Requirements:

- `evm/anvilManager` manages child process:
  - detect `anvil` binary
  - start/stop with config output persisted
  - forkUrl + forkBlockNumber + block time options
- Health: chain id/latest block/fork metadata.
- Snapshot/revert:
  - `POST /evm/snapshot` -> `anvil_snapshot`
  - `POST /evm/revert` -> `anvil_revert`
- State shaping helpers (balance/code/storage) and optional impersonation workflow.
- “Replay on Anvil” mapping from captured flow to tx replay, store receipts/logs/decoded events.

Completion specs:

- Start fork, snapshot, replay, and revert deterministically from UI.
- Approve/swap flows replay in fork and show decoded outcomes.

## AI Retrieval + Copilot (Milestone D)

Requirements:

- Embeddings index over messages/flows/ABIs/findings.
- Retrieval API: `POST /ai/retrieve` with filters.
- Evidence links and confidence for every output.
- Offline-only mode + redaction + retention settings.

Completion specs:

- AI can answer “what happened in this flow” with clickable evidence and no generic output.

## Fuzzer + Scanner (Milestone E)

Status:

- Implemented (Scanner): passive checks (SIWE correctness, typed-data domain separation, replay indicators, unlimited approval indicators), guardrailed active probes, findings persistence, and Scanner UI.
- Implemented (Fuzzer): baseline campaign endpoint and UI.
- Missing: richer mutation strategy coverage, larger-scale clustering UX, and tighter Anvil snapshot/revert coupling.

Requirements:

- Mutation framework + rate limiting + clustering for fuzzer (integrates Anvil snapshot/revert).
- Scanner passive checks + guardrailed active probes + finding pipeline.

Completion specs:

- Run a fuzz campaign and get clustered outcomes.
- Scanner emits findings with evidence + remediation writeups.
