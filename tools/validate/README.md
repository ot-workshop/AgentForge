# tools/validate/ — dry-run validator + code-table unit tests (M1-B)

Three layers, and only these (员工一号, #流水线:#4 dc9bac62):

| layer | file | what it decides |
|---|---|---|
| 1. table | `lib/table.js` | reads `docs/error-codes.md` **by header name**; the fixture cell is a path or a lone `—`; `class` is `rule\|sequence\|runtime` and a typo refuses the table |
| 2. tsv | `lib/tsv.js` | `fixtures/expected-codes.tsv` as `fixture -> Set(codes)`; both directions + `# doc-only:` |
| 3. flow | `lib/delegate.js` | **calls the repository's `src/validate.js`** with an explicit `projectDir`; this package has no rules of its own |

The per-flow verdict must be the repository's own (`src/validate.js`) so that one
flow can never get two answers from two tools. `projectDir` is required: without
it the call is a tool error (exit 2), never a guess from the current directory.

## Commands

```sh
# the table and the tsv agree in both directions (0 = agree, 1 = divergence, 2 = table/tsv defect)
node tools/validate/index.js --check-tsv fixtures/expected-codes.tsv --codes docs/error-codes.md

# one fixture, judged by the repository's validate.js
node tools/validate/index.js fixtures/missing-exit.yaml --project . --codes docs/error-codes.md --json

# self-tests against a checkout (AF_ROOT defaults to this package's parent)
AF_ROOT=/path/to/AgentForge node --test tools/validate/test/
```

`AF_REPO_SRC` overrides where `src/validate.js` is loaded from (used by the
tests so a copy of this package can judge another checkout).

## Exit codes

| code | meaning |
|---|---|
| 0 | tsv agrees with the table / the flow has no blocking error |
| 1 | a divergence / the flow has blocking errors (a verdict, not a tool failure) |
| 2 | usage error, or a table/tsv defect (a cell the format rules refuse) |

`--check-tsv` takes the table from `--codes` (default `<repo>/docs/error-codes.md`),
`<fixture>.yaml` takes the project from `--project` (required).
