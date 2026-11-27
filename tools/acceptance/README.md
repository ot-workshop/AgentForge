# Final acceptance suite (#流水线:#11)

One read-only entry point that judges the five final-stage standards
(员工一号 b03da5fa) against a checkout, and prints **通过 / 失败 / 未验 + 命令 +
原始行** for each.

```sh
node tools/acceptance/index.mjs --repo <checkout>          # human-readable
node tools/acceptance/index.mjs --repo <checkout> --json   # machine-readable
AF_REPO=<checkout> node --test tools/acceptance/test/      # the suite's own red probes
```

Exit: `0` every judged row passes (未验 rows do not fail the suite), `1` any row
fails, `2` usage error. It never writes into `<checkout>`: every probe that needs
`.forge/` runs on a scratch copy under the OS temp dir.

## Rows

| row | standard | what it measures now |
|---|---|---|
| `G0 freeze-allowed` | 冻结样例的前置 | H1 and H2 both green; while red, no frozen sample is produced |
| `H1 run-positional-arg` | `forge run <file>` 不得静默忽略 | non-zero + `E_INVALID_ARGS`, no run dir created |
| `H2 flow-path-relative` | `--flow` 写出的路径可跨机重放 | `manifest.flow.path == run.start.payload.flow`, relative to the repo root |
| `V1.1 人机同门` | 人画的和 agent 写的过同一个校验器，报错指回节点 | CLI verdict == library verdict; a cycle is refused with a node id |
| `V1.2a replay==incremental==从头` | 全程事件可回放 | frozen run: replay == incremental(0) == events.jsonl, `--since 2` == the tail |
| `V1.2b 失败定位到阶段` | 中途失败能定位阶段与原因 | `stage.end.status=failed` on the failing stage, visible in `/snapshot` |
| `V1.3 越权被拦` | 权限边界由编排器强制 | a runner that rewrites the checker is refused (`E_PERMISSION_GAP`) |
| `V1.4 分支与有限循环` | 循环/分支，上限是硬限制 | 未验 until #10 lands |
| `V1.5 人只在两端` | agent 不能自己宣布通过 | 未验: no machine-checkable carrier in the repo yet |
| `D1 deploy-scripts-substantive` | 部署段复用 `deploy.sh` + `acceptance.sh` | `bash -n` clean **and** the scripts still contain what they claim (`deploy-report-`, `merge-base --is-ancestor`, `/healthz` `/snapshot` `/events`) |
| `D2 serves-healthz-snapshot-events` | 起一次真服务 | free port from the kernel, `/healthz` ok, `/snapshot` lists the fresh run, `/events?since=0` first frame is `run.start`, then the process is stopped |

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
