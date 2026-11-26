# Error codes (forge.protocol/v1)

Every error emitted by `validate`, `run` and `verify-chain` has exactly six keys:
`{code, severity, locatable, path, ids[], fix}`. `fix` is a machine-readable next
step; `null` means "no candidate could be computed" and is written explicitly.
Uncaught internal crashes are not in this table: exit code 2 + one stderr line.

`severity: block` → exit code 1. `severity: warn` → exit code 0, shown in output.

`class` is one of:

- `rule` — validation rule; has a fixture, or is listed in `# doc-only:` in the tsv.
- `sequence` — must be produced by an event stream; its criterion is appendix A5.
- `runtime` — produced at run/request time; its criterion is appendix A2.4/A4.6/A5.12.

### Codes with no P0 fixture (`—`), and why

- `E_ILLEGAL_JUMP` [P0.5] — by definition a back edge `u -> v` has `v` reaching
  `u`, so `v` is always an ancestor of `u`. With no bounded retry edges in P0,
  "a back edge whose target is not an ancestor" is an empty set: the code has no
  trigger source in P0 and is verified in P0.5 (v2.4 A12.4).
- `E_PERMISSION_GAP` — the permission check runs at `run` time, not in the static
  flow validator; the code is verified by the A5 run-stage probe.
- `E_LIMIT_UNBOUNDED` [P0.5] — the unbounded/absurd retry limit lives on the
  `on:` / `max_iterations` edge fields, which are themselves P0.5
  (`E_P0_UNSUPPORTED`), so no P0 fixture can reach this code.
- `E_DEPTH_EXCEEDED` — P0 has no trigger source: subflows are P0.5 (A6.1/A6.3) and
  `main` has no implementation of this code yet.

`E_MISSING_EXIT` and `E_CYCLE` are inseparable in a finite P0 graph: if every node
has an outgoing edge, the graph must contain a cycle. `fixtures/missing-exit.yaml`
therefore registers BOTH codes, and the acceptance test compares the expected code
set with the actual one (no more, no less).

`LOOP_LIMIT_SUSPECT_THRESHOLD = 1000` is defined here only; the validator and
`fixtures/expected-codes.tsv` derive from this file.

| code | severity | locatable | fix | class | fixture |
|---|---|---|---|---|---|
| `E_SCHEMA_INVALID` | block | false | `{action, path}` | rule | `fixtures/broken-yaml.yaml` |
| `E_UNKNOWN_REF` | block | false | `{ref, refKind, available[]}` | rule | `fixtures/missing-check.yaml` |
| `E_CYCLE` | block | true | `{cycle: [ids]}` | rule | `fixtures/cycle.yaml` |
| `E_ILLEGAL_JUMP` | block | true | `{from, to}` | rule | — |
| `E_UNREACHABLE` | block | true | `{nodeId}` | rule | `fixtures/unreachable.yaml` |
| `E_MISSING_ENTRY` | block | false | `{action}` | rule | `fixtures/missing-entry.yaml` |
| `E_MISSING_EXIT` | block | false | `{action}` | rule | `fixtures/missing-exit.yaml` (+ `fixtures/cycle.yaml`: same graph) |
| `E_CONTRACT_MISMATCH` | block | true | `{from:{nodeId,output}, to:{nodeId,input}, expected, actual}` | rule | `fixtures/contract-mismatch.yaml` |
| `E_UNBOUND_INPUT` | block | true | `{input, slotOf, reason, candidates[]}` | rule | `fixtures/unbound-input.yaml` |
| `E_PERMISSION_GAP` | block | true | `{tool, requiredBy, agentSpec, suggestAddTo}` | rule | — |
| `E_CHECKER_NOT_FOUND` | block | true | `{check, searched[]}` | rule | `fixtures/checker-not-found.yaml` |
| `E_GATE_NO_APPROVER` | block | true | `{gate}` | rule | `fixtures/gate-no-approver.yaml` |
| `E_LIMIT_UNBOUNDED` | block / warn | true | `{object, suggestedMax}` | rule | — (P0.5; `fixtures/limit-unbounded.yaml` and `fixtures/limit-suspect.yaml` are registered with `E_P0_UNSUPPORTED` because their retry fields are P0.5) |
| `E_FANOUT_EXCEEDED` | block | true | `{nodeId, fanout, max}` | rule | `fixtures/fanout-9.yaml` |
| `E_NODE_COUNT_EXCEEDED` | block | false | `{count, max}` | rule | `fixtures/nodes-101.yaml` |
| `E_DEPTH_EXCEEDED` | block | false | `{depth, max}` | rule | — |
| `E_P0_UNSUPPORTED` | block | true | `{field, reason: "field is P0.5"}` | rule | `fixtures/p0-unsupported-<field>.yaml` |
| `E_BLOCK_CONTENT_DRIFT` | block | false | `{block, recordedSha256, actualSha256}` | sequence | — |
| `E_FLOW_CONTENT_DRIFT` | block | false | `{flow, recordedSha256, actualSha256}` | sequence | — |
| `E_EVENT_CORRUPT` | block | false | `{action, detail}` | sequence | — |
| `E_CHAIN_HASH_MISMATCH` | block | false | `{action, recordedHash}` | sequence | — |
| `E_EVENT_SEQ_GAP` | block | false | `{action, expectedSeq, actualSeq}` | sequence | — |
| `E_REF_DRIFT_ORDER` | block | false | `{action}` | sequence | — |
| `E_ILLEGAL_STAGE_WRITE` | block | false | `{action}` | sequence | — |
| `E_STAGE_FAILED` | block | false | `{action, hint}` | sequence | — |
| `E_EVENTS_LOCKED` | block | false | `{action}` | runtime | — |
| `E_INVALID_QUERY` | block | false | `{action}` | runtime | — |
| `E_FILE_NOT_FOUND` | block | false | `{action, path}` | runtime | — |
| `E_INVALID_ARGS` | block | false | `{action}` | runtime | — |

## Error-structure tests (one list, consumed by the validator unit tests)

| id | entry point | sample | expects |
|---|---|---|---|
| S1 | `validate` | `fixtures/cycle.yaml --json` | exit 1, every error has six keys, `fix` present |
| S2 | `run` | `FORGE_FAKE=no-evidence` | the error in `stage.end.payload.error` has six keys |
| S3 | `verify-chain` | tampered line `--json` | exit 1, six keys, `ids` contains `seq:5` |
| S4 | `run` | `FORGE_FAKE=crash` | exit 2, one stderr line, **no** error event added |
| S5 | `validate` | `fixtures/p0-unsupported-<field>.yaml --json` | exactly one error, `E_P0_UNSUPPORTED`, `path` names that field |
