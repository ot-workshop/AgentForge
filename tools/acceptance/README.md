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
| `D1 deploy-scripts-present` | 部署段复用 `deploy.sh` + `acceptance.sh` | scripts present and `bash -n` clean |
| `D2 served-run-traceable` | `/snapshot` 看得到刚跑完的 run | three stages `ok` in the projection |

Every row carries `reds`: probes that must be **red on a broken implementation**
and green on a correct one. The suite's own tests mutate a scratch copy
(`Validator drops E_CYCLE`, `failed stage recorded as ok`, `orchestrator ignores a
rewritten checker`) and assert the matching row turns `fail`.

## In-repo vs standalone

Inside the AgentForge checkout this directory is `tools/acceptance/` and `--repo .`
works directly. The suite imports nothing from `src/` except through the probe that
deliberately calls the library validator, so it also runs from outside a checkout
(`--repo /path/to/checkout`).
