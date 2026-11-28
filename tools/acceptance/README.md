# Final acceptance suite (#流水线:#11)

One read-only entry point that judges the five final-stage standards
(员工一号 b03da5fa) against a checkout, and prints **通过 / 失败 / 未验 + 命令 +
原始行** for each.

```sh
node tools/acceptance/index.mjs --repo <checkout>          # human-readable
node tools/acceptance/index.mjs --repo <checkout> --json   # machine-readable
AF_REPO=<checkout> node --test --test-timeout=120000 tools/acceptance/test/   # the suite's own red probes (slow, see below)
```

Exit: `0` every judged row passes (未验 rows do not fail the suite), `1` any row
fails, `2` usage error. It never writes into `<checkout>`: every probe that needs
`.forge/` runs on a scratch copy under the OS temp dir.

### Running the suite's own tests: give it a long timeout

`tools/acceptance/test/` re-runs the whole suite (15 tests x one full `index` each),
so it is **slow by design**: 员工一号 measured **705 s** for the full run (员工三号
2 m 48 s for the one "a run that never ends must fail" test alone; ~1 min here). A plain
`node --test tools/acceptance/test/` (default per-test timeout 30 s / whole-file
internal timeouts) cuts it off mid-run and looks like a hang. Run it with a long
timeout, or one test at a time:

```sh
AF_REPO=$PWD node --test --test-timeout=120000 tools/acceptance/test/          # whole file
AF_REPO=$PWD node --test --test-name-pattern="never ends" tools/acceptance/test/   # just that one
```

The judged rows themselves (`index.mjs --repo .`) take ~30 s end to end; only `test/`
is slow.

### KNOWN GAP: the per-run SIGKILL ceiling

Every `forge run` a probe starts gets `timeout` + `killSignal: 'SIGKILL'`
(`lib/exec.js`, ceiling `AF_RUN_TIMEOUT_MS`, default 120 s), and a killed run is a
failed step of its row. **Reproducible:** the direct child is killed at ~5 s when the
limit is 5 s. **Not guaranteed** (员工三号 a6ddec12/cc39f9c9, 员工一号 f8b0004f):
`spawnSync`'s timeout is unreliable for a child with long-lived grandchildren
(`forge run` spawns `fake-runner.js` per stage) -- a 5 s limit has been seen to return
in ~59 s, grandchildren have outlived a killed parent, and a scratch copy left behind
by a kill is not removed (one held 11.8 MB of events). So the ceiling guarantees "the
suite ends", not "every descendant is gone and every scratch dir removed". A
process-group kill with provable cleanup is tracked separately.

## Rows

| row | standard | what it measures now |
|---|---|---|
| `G0 freeze-allowed` | 冻结样例的前置 | H1 and H2 both green; while red, no frozen sample is produced |
| `H1 run-positional-arg` | `forge run <file>` 不得静默忽略 | non-zero + `E_INVALID_ARGS`, no run dir created |
| `H2 flow-path-relative` | `--flow` 写出的路径可跨机重放 | `manifest.flow.path == run.start.payload.flow`, relative to the repo root |
| `V1.1 人机同门` | 人画的和 agent 写的过同一个校验器，报错指回节点 | CLI verdict == library verdict; a cycle is refused with a node id |
| `V1.2a replay==incremental==从头` | 全程事件可回放 | frozen run: replay == incremental(0) == events.jsonl（经 `src/project.js` 投影后逐行相等）, `--since 2` == the tail, row count == `freeze.json`（该样例冻结时的 sha256/条数；记录了 `flowPath` 时，`manifest.flow.path` 与 `run.start.payload.flow` 也必须等于它——入口从绝对路径改成相对路径后，旧样例会现形）。判定入口可换：`AF_FROZEN_DIR=<dir>` 指任何含 `.forge/runs/<run>/events.jsonl` 的目录。 冻结样例只入 `events.jsonl` + `manifest.json`（员工一号 820539da：`context/`、`checks.lock`、`.events-lock` 一律不入） |
| `V1.2b 失败定位到阶段` | 中途失败能定位阶段与原因 | `stage.end.status=failed` on the failing stage, visible in `/snapshot` |
| `V1.3 越权被拦` | 权限边界由编排器强制 | a runner that rewrites the checker is refused (`E_PERMISSION_GAP`) |
| `V1.4 分支与有限循环` | 循环/分支，上限是硬限制 | 16 条断言 + 6 个反例（员工一号 a9d63f5a / 79faf4a2 / 971e72b6 / 10ad82ae / 918356de / 1c4df2e6），全部在仓外副本里跑、每次 `run` 都有 SIGKILL 上限：无上限回边 → 只 `E_CYCLE`（带节点 ids），CLI == 库；`run` 拒被拦的流程时不留 run 目录；`loop-bounded.yaml` + `FORGE_FAKE=retry-verify:2` 真跑 `goto 1,2` + `design@1…ops@1` + `run.end ok`，goto.iteration 与目标下一次 `stage.start.iteration` 配对、同一 `loopId` 连续 goto 必须是 1,2；`snapshot` 八格不覆盖；`retry-verify:9` 无 `on_exhausted` → `run.end failed/E_LIMIT_UNBOUNDED`（loopId/iterations/fix），有 → 一条 `loop-exhausted` log + `run.end ok`；分支两个方向各走各的边。6 个反例（上限早一格收尾、goto 从 0 起、run 不再先校验、on 不参与选边、`on_exhausted` 不收尾、校验器放宽）各自转红。**未覆盖**：M3（同一阶段经普通边再次进入仍是新格子）与 M4（`on:` 边优先于普通边），按员工一号 1c4df2e6 从本条摘出、合并后单开任务 |
| `V1.4u 未覆盖：M3/M4` | 不在本条判 | 上面两行的「未覆盖」在这里留一行字：这两条没有判据、也不计入 PASS；单开任务接手时在此行补断言 |
| `V1.4f 冻结样例 loop-bounded` | 有界循环可重放 | `frozen/loop-bounded/`（`4de2dea4` 上 `FORGE_FAKE=retry-verify:2` 真跑 20 条事件）：条数/sha256/flow 路径对 `freeze.json`；重跑后**只比**事件类型顺序、`stage.end.status`、`(stage,iteration)`、`flow.goto` 的 from/to/iteration/loopId/checkResultId、`run.end`；**不比** `ts`/`hash`/`prev`/`stage.start.payload.contextSha256`（它是对 `{runId,stage,iteration,prevArtifacts}` 取 sha，`runId` 是 run 目录名——员工一号 918356de、员工二号 83e69916；跨目录逐字节相等是 M3 的事）。3 个反例（改一轮 status、删第 2 个 goto、改 run.end）各自转红 |
| `V1.5 人只在两端` | agent 不能自己宣布通过 | **负向判据**（员工一号 820539da）：一次正常 run 里没有 `actor.kind=human` / `type` 以 `accept` 结尾的事件，`manifest` 没有 accepted 字段，`src/` 没有写这类事件的代码路径。正向那一半（人工验收命令）等 #9 第 3 块落地再补 |
| `D1 deploy-scripts-substantive` | 部署段复用 `deploy.sh` + `acceptance.sh` | `bash -n` clean **and** the scripts still contain what they claim (`deploy-report-`, `merge-base --is-ancestor`, `/healthz` `/snapshot` `/events`) |
| `D2 serves-healthz-snapshot-events` | 起一次真服务 | calls `deploy/ci/serve_probe.sh` (员工四号) on a scratch copy: free port, `/healthz`, `/snapshot`, `/events?run=…` first frame `run.start`, then it stops the server |

Every row carries `reds`: probes that must be **red on a broken implementation**
and green on a correct one. The suite's own tests mutate a scratch copy
(`Validator drops E_CYCLE`, `failed stage recorded as ok`, `orchestrator ignores a
rewritten checker`, `smoke.sh loses /events`, `deploy.sh emptied`, `serve stops
streaming run.start`) and assert the matching row turns `fail`.

## In-repo vs standalone

Inside the AgentForge checkout this directory is `tools/acceptance/` and `--repo .`
works directly. The suite imports nothing from `src/` except through the probe that
deliberately calls the library validator, so it also runs from outside a checkout
(`--repo /path/to/checkout`).

## Deploy in one line

`D1`/`D2` are the parts a machine can judge. The real deployment is still
`deploy/deploy.sh <merge-sha>`: its input must be an ancestor of `origin/main`, it
lands under `<root>/<sha>/`, writes `deploy-report-<short>.md`, and stops the old
instance before starting the new one. That needs an exclusive port and is run by a
person, never by this suite.

## Frozen sample

`tools/acceptance/frozen/linear-golden/` holds one run produced on base
`9b7ed8d5` with `forge run --run linear-golden --flow flows/main.yaml`:

- `.forge/runs/linear-golden/events.jsonl` + `manifest.json` only (no `context/`,
  no `checks.lock`, no `.events-lock`);
- `freeze.json` — `run`, `base`, `eventCount`, `sha256` of `events.jsonl`,
  `flowPath` (`manifest.flow.path == run.start.payload.flow == "flows/main.yaml"`),
  `flowSha256`, `startFlow`, and the run's timestamps.

`freeze.json` is written once at freeze time and is the authority on "how many
events, and which flow shape" the sample had; a sample taken on a different entry
shape shows up as `MISMATCH`, not as a pass.

`tools/acceptance/frozen/loop-bounded/` holds a second sample produced on base
`4de2dea4` with `FORGE_FAKE=retry-verify:2 forge run --run loop-bounded --flow
fixtures/loop-bounded.yaml` (20 events, the real bounded loop):
`runs/loop-bounded/events.jsonl` + `manifest.json` + `freeze.json`. It is judged by
`V1.4f` on the flow's own fields only -- event type order, `stage.end.status`,
`(stage, iteration)`, `flow.goto` `from/to/iteration/loopId/checkResultId`, and
`run.end` -- and deliberately **not** on `ts`, `hash`, `prev` or
`stage.start.payload.contextSha256`: the last one is `sha256({runId, stage,
iteration, prevArtifacts})`, and `runId` is the run directory's name, so it is a
property of the run, not of the flow (员工一号 918356de, 员工二号 83e69916). Byte
equality across directories is M3's job.
