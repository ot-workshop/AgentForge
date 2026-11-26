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

### Fixture column `—`, and why

- `E_ILLEGAL_JUMP` [P0.5] — a back edge `u -> v` always has `v` reaching `u`, so `v`
  is an ancestor of `u`; with no bounded retry edges in P0, "a back edge whose
  target is not an ancestor" is an empty set. No P0 trigger source (v2.4 A12.4).
  `fixtures/illegal-jump.yaml` keeps its shape; in P0 its code set is
  `{E_MISSING_EXIT, E_CYCLE}`, which is what the tsv registers.
- `E_LIMIT_UNBOUNDED` [P0.5] — every trigger (`on`, `max_iterations`) is itself a
  P0.5 field, so a P0 flow reports `E_P0_UNSUPPORTED` first. The `limit-*` fixtures
  stay in the tree as P0.5 material; the P0 tsv registers them under
  `E_P0_UNSUPPORTED`, never deletes them.

`E_MISSING_EXIT` and `E_CYCLE` are inseparable in a finite P0 graph: if every node
has an outgoing edge, the graph must contain a cycle; `missing-exit.yaml` registers
both codes and the test compares the full code set.

`LOOP_LIMIT_SUSPECT_THRESHOLD = 1000` is defined here only; the validator and
`fixtures/expected-codes.tsv` derive from this file.

| code | severity | locatable | fix | class | fixture |
|---|---|---|---|---|---|
| `E_SCHEMA_INVALID` | block | false | `{action, path}` | rule | `fixtures/broken-yaml.yaml` |
| `E_UNKNOWN_REF` | block | false | `{ref, refKind, available[]}` | rule | `fixtures/missing-check.yaml` |
| `E_CYCLE` | block | true | `{cycle: [ids]}` | rule | `fixtures/cycle.yaml` |
| `E_ILLEGAL_JUMP` | block | true | `{from, to}` | rule | — **[P0.5]** no P0 trigger source (see note) |
| `E_UNREACHABLE` | block | true | `{nodeId}` | rule | `fixtures/unreachable.yaml` |
| `E_MISSING_ENTRY` | block | false | `{action}` | rule | `fixtures/missing-entry.yaml` |
| `E_MISSING_EXIT` | block | false | `{action}` | rule | `fixtures/missing-exit.yaml` |
| `E_CONTRACT_MISMATCH` | block | true | `{from:{nodeId,output}, to:{nodeId,input}, expected, actual}` | rule | `fixtures/contract-mismatch.yaml` |
| `E_UNBOUND_INPUT` | block | true | `{input, slotOf, reason, candidates[]}` | rule | `fixtures/unbound-input.yaml` |
| `E_PERMISSION_GAP` | block | true | `{tool, requiredBy, agentSpec, suggestAddTo}` | rule | `fixtures/permission-gap.yaml` |
| `E_CHECKER_NOT_FOUND` | block | true | `{check, searched[]}` | rule | `fixtures/checker-not-found.yaml` |
| `E_GATE_NO_APPROVER` | block | true | `{gate}` | rule | `fixtures/gate-no-approver.yaml` |
| `E_LIMIT_UNBOUNDED` | block / warn | true | `{object, suggestedMax}` | rule | — **[P0.5]** every trigger is a P0.5 field (see note); `fixtures/limit-unbounded.yaml` / `limit-suspect.yaml` stay in the tree as P0.5 material |
| `E_FANOUT_EXCEEDED` | block | true | `{nodeId, fanout, max}` | rule | `fixtures/fanout-9.yaml` |
| `E_NODE_COUNT_EXCEEDED` | block | false | `{count, max}` | rule | `fixtures/nodes-101.yaml` |
| `E_DEPTH_EXCEEDED` | block | false | `{depth, max}` | rule | `fixtures/depth-4.yaml` |
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
| `E_UNKNOWN_RUN` | block | false | `{action, available[]}` | runtime | — |
| `E_INVALID_ARGS` | block | false | `{action}` | runtime | — |

## Error-structure tests (one list, consumed by the validator unit tests)

| id | entry point | sample | expects |
|---|---|---|---|
| S1 | `validate` | `fixtures/cycle.yaml --json` | exit 1, every error has six keys, `fix` present |
| S2 | `run` | `FORGE_FAKE=no-evidence` | the error in `stage.end.payload.error` has six keys |
| S3 | `verify-chain` | tampered line `--json` | exit 1, six keys, `ids` contains `seq:5` |
| S4 | `run` | `FORGE_FAKE=crash` | exit 2, one stderr line, **no** error event added |
| S5 | `validate` | `fixtures/p0-unsupported-<field>.yaml --json` | exactly one error, `E_P0_UNSUPPORTED`, `path` names that field |
