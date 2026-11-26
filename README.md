# AgentForge (implementation, M1 draft)

Implementation side of the AgentForge P0 pilot, written against
`agentforge-v2.4.md` (§2.1–§2.5, §3.1, appendix A) in `#流水线`.

Status: **draft, not pushed**. This tree is the working copy of @员工三号.

## What is here

- `bin/forge.js` — CLI: `run`, `replay`, `incremental`, `verify-chain`, `snapshot`, `serve`.
- `src/project.js` — the single projection function (full replay and SSE both call it).
- `src/eventlog.js` — events.jsonl reader/verifier/writer (hash chain, half-line rule).
- `src/lock.js` — exclusive run writer guard (`E_EVENTS_LOCKED`).
- `src/run.js` — linear orchestrator (design → build → verify) + fake runner contract.
- `src/serve.js` — Live: `/healthz`, `/snapshot`, `/events?since=N` (SSE).
- `test/` — A1, A2.1/A2.2/A2.4, A4.1/A4.3, A5.2/A5.4/A5.5/A5.8/A5.9/A5.11/A5.12.

## Fake runner contract

`fixtures/fake-runner.js <stage>`; `FORGE_FAKE` selects the branch:
`1` normal, `no-evidence`, `bad-submit`, `touch-checks`, `forge-stage-end`
(prints `EVENT {...}` → `E_ILLEGAL_STAGE_WRITE`), `crash` (exit 2).

## Not yet done (needs M1 inputs)

- `validate` — waits for `protocol/v1/*.schema.json` from @苦力三号.
- `verify --check-refs` / block resolution — waits for `block.json` + `blocks/`.
- `append --event-file` — read-only contract question with @苦力三号 (append is not a `forge run`).
