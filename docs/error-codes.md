# Error codes (forge.protocol/v1)

Every error emitted by `validate`, `run` and `verify-chain` has exactly six keys:
`{code, severity, locatable, path, ids[], fix}`. `fix` is a machine-readable next
step; `null` means "no candidate could be computed" and is written explicitly.
Uncaught internal crashes are not in this table: exit code 2 + one stderr line.

`severity: block` → exit code 1. `severity: warn` → exit code 0, shown in output.

| code | severity | locatable | fix shape | notes |
|---|---|---|---|---|
| `E_SCHEMA_INVALID` | block | false | `{action, path}` | YAML/JSON itself is invalid; `path` points at the offending field when known |
| `E_UNKNOWN_REF` | block | false | `{ref, refKind, available[]}` | unknown agent / block / flow version / group (empty string is invalid too) |
| `E_CYCLE` | block | true | `{cycle: [ids]}` | a cycle that is not a bounded retry edge back to an ancestor |
| `E_ILLEGAL_JUMP` | block | true | `{from, to}` | edge back to a non-ancestor |
| `E_UNREACHABLE` | block | true | `{nodeId}` | node not reachable from entry |
| `E_MISSING_ENTRY` | block | false | `{action}` | no entry node |
| `E_MISSING_EXIT` | block | false | `{action}` | no node without outgoing edges |
| `E_CONTRACT_MISMATCH` | block | true | `{from:{nodeId,output}, to:{nodeId,input}, expected, actual}` | `ids` holds both ends |
| `E_UNBOUND_INPUT` | block | true | `{input, slotOf, reason, candidates[]}` | required input not produced upstream nor passed by `with` |
| `E_PERMISSION_GAP` | block | true | `{tool, requiredBy, agentSpec, suggestAddTo}` | agent may not use a tool its block needs |
| `E_CHECKER_NOT_FOUND` | block | true | `{check, searched[]}` | check names no existing checker |
| `E_GATE_NO_APPROVER` | block | true | `{gate}` | human gate without an approver role |
| `E_LIMIT_UNBOUNDED` | block (retry edge) / warn (stage timeout) | true | `{object, suggestedMax}` | second use is a loop without `max_iterations` (block) or `max_iterations >= LOOP_LIMIT_SUSPECT_THRESHOLD` (warn) |
| `E_FANOUT_EXCEEDED` | block | true | `{nodeId, fanout, max}` | default max 8 |
| `E_NODE_COUNT_EXCEEDED` | block | false | `{count, max}` | default max 100 |
| `E_DEPTH_EXCEEDED` | block | false | `{depth, max}` | subflow nesting, default max 3 |
| `E_BLOCK_CONTENT_DRIFT` | block | false | `{block, recordedSha256, actualSha256}` | file edited in place; replay is unaffected |
| `E_FLOW_CONTENT_DRIFT` | block | false | `{flow, recordedSha256, actualSha256}` | same, for a flow file |
| `E_EVENTS_LOCKED` | block | false | `{action: wait-for-writer-then-retry}` | `forge run`/`append` could not take the run lock |
| `E_EVENT_CORRUPT` | block | false | `{action, detail}` | an events.jsonl line in the middle is not valid JSON |
| `E_CHAIN_HASH_MISMATCH` | block | false | `{action, recordedHash}` | complete line whose hash does not match the chain |
| `E_EVENT_SEQ_GAP` | block | false | `{action, expectedSeq, actualSeq}` | seq not contiguous from 1 |
| `E_REF_DRIFT_ORDER` | block | false | `{action}` | `ref.drift` more than once or after the first `stage.start` |
| `E_ILLEGAL_STAGE_WRITE` | block | false | `{action}` | runner tried to write stage state itself (`EVENT ` line) |
| `E_STAGE_FAILED` | block | false | `{action, hint}` | stage ended `failed`/`blocked` |
| `E_INVALID_QUERY` | block | false | `{action}` | HTTP 400: `since` missing/non-integer |
| `E_P0_UNSUPPORTED` | block | true | `{field, reason: "field is P0.5"}` | flow uses `on` / `max_iterations` / `on_exhausted` / `loop_id` / `group`; exactly one error per fixture |

`LOOP_LIMIT_SUSPECT_THRESHOLD = 1000` is defined **here only**; the validator and
`fixtures/expected-codes.tsv` derive from this file.

## Error-structure tests (one list, consumed by the validator unit tests)

| id | entry point | sample | expects |
|---|---|---|---|
| S1 | `validate` | `fixtures/cycle.yaml --json` | exit 1, every error has six keys, `fix` present |
| S2 | `run` | `FORGE_FAKE=no-evidence` | the error in `stage.end.payload.error` has six keys |
| S3 | `verify-chain` | tampered line `--json` | exit 1, six keys, `ids` contains `seq:5` |
| S4 | `run` | `FORGE_FAKE=crash` | exit 2, one stderr line, **no** error event added |
| S5 | `validate` | `fixtures/p0-unsupported-<field>.yaml --json` | exactly one error, `E_P0_UNSUPPORTED`, `path` names that field |
