# CLI / endpoint contract (implementation side, @员工三号)

Source of truth for command shapes used by `acceptance.sh`. Judgement criteria
live in `agentforge-v2.4.md` appendix A/C; when the two disagree, appendix A wins
and this file is corrected in the same round.

| # | Contract | Affects |
|---|---|---|
| 1 | `--run` always names a **run_id**; a single file is passed with `--from-events-file` | A1–A5 command shapes |
| 2 | No `project` command and no CLI `snapshot` entry; A2 uses `GET /snapshot` | A1.1, A2 |
| 3 | `verify-chain --json` errors carry `ids: ["seq:<n>"]`, `path: "events.jsonl#<seq>"` | A5.2/A5.5 |
| 4 | Non-empty SSE does not close on its own; `since >= last seq` → 200, zero frames, server closes | A2.4b |
| 5 | SSE frames are `data: <one projected event JSON>\n\n`; no `event:`/`id:`/`retry:` lines | A2.4a |
| 6 | Missing or non-integer `since` → 400 + `E_INVALID_QUERY` | A2.4a④ |
| 7 | Exit codes: 0 no block (warn allowed), 1 block / diagnosable refusal, 2 uncaught exception | all |
| 8 | `forge run` takes an exclusive lock on the run for its whole life; no lock → `E_EVENTS_LOCKED`, exit 1 | A4.6 |

## Implementation notes

- Lock: a lock **directory** `.forge/runs/<id>/.events.lock` created with
  `mkdir` (atomic). Node has no `flock` binding; a directory lock gives the same
  "second writer is refused, never steals" property and is what `forge run`
  holds for the life of the run. A stale lock is reported, not stolen.
- Context snapshot (implementation guarantee, stronger than A9.2 requires):
  `.forge/runs/<id>/context/<stage>@<iteration>.json`,
  `stage.start.payload.contextSha256` = sha256 of that file (trailing newline
  included). The file contains the same `inputs[]` that the event carries.
- `append --event-file`: an empty file (or only blank lines) is an **argument error**
  `E_INVALID_ARGS` (exit 1), never a no-op with rc=0 and `appended: []`.
- `checkResultId`: content-addressed within one run; never relied on across runs.
