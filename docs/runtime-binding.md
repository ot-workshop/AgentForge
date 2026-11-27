# 接真实 agent 运行时：需要先定的边界（M2-B 第 1 步）

状态：提案，待拍板。本文只写「接真运行时要把哪些边界定死」和现有代码在这几处的实际行为，选哪家运行时、谁持有凭据、计费算谁的，留「待 shangxinha 定」。
范围：依据 `main = d9c8d356a8356a1bf89f3999f39efcc2da6e4fba`（PR #4 合入后）的代码与 v2.4 文档。本文不改 A4.4 / A5 的判据。

## 0. 现状（已核实）

- 阶段执行器固定为仓库里的假程序：`src/run.js:285`（`invokeRunner`）里取 `fixtures/fake-runner.js`，`src/run.js:290-294` 用 `spawnSync(process.execPath, [script, stage])` 同步跑一次；没有第二种执行器，没有超时、没有重试。
- 假程序（`fixtures/fake-runner.js`）的输入只有环境变量 `FORGE_FAKE`、`FORGE_STAGE`、`FORGE_ITERATION`、`FORGE_EVENTS`、`FORGE_CHECKS_FILE`、`FORGE_PREV_SEQ`（`src/run.js:292`），工作目录是本次 run 的目录（`src/run.js:291`）；它不读 Flow 的 `with` 参数，也不读上游阶段的产出。
- 编排器对子进程的解读（`src/run.js:295-313`）：退出码 2 = 崩溃；stdout 里出现行首 `EVENT ` = 伪造事件 → `E_ILLEGAL_STAGE_WRITE`；从第一个 `{` 起解析 JSON 作为 Submit；拿不到带 `status` 的 Submit → `E_SCHEMA_INVALID`。
- 墙：`checks.lock` 每阶段重写为固定内容、阶段后比 sha256，改过就回滚并记 `E_PERMISSION_GAP`（`src/run.js:132-142`、`src/run.js:181-189`，A4.4）。Submit 缺证据记 `E_MISSING_EVIDENCE`（`src/run.js:156-165`），Submit 报失败记 `E_STAGE_FAILED`（`src/run.js:190-198`）。
- AgentSpec 有两种执行器定义：`runtime.runner` 枚举已允许 `fake | claude-code | codex | cli | http`（`protocol/v1/spec.json:31-38`，`runner` 在第 36 行；其中 `cli` = 本机进程、`http` = 远程 API），，`limits.timeout_s / max_attempts / token_budget` 也已定义（`protocol/v1/spec.json:56-64`），但 `src/run.js` 里没有任何地方读它们；Flow 的节点是 `block:<name>@<ver>`（`flows/main.yaml:6-10`），block 通过 `agent: architect@1` 指向 AgentSpec（`blocks/design/v1.yaml:3`），而 `src/run.js:239-253` 的 `loadFlow` 只取节点 id 当阶段名（`src/run.js:252`），不看 block 挂的是哪个 agent。
- 基线：`node --test` 57/57、部署侧 acceptance 62/62，这两组都是员工四号在他的脚本 / 部署 head 上跑出的结果（`ca4d0fe` 那次 62/62 见 #流水线 消息 cbcb133d）；`main` 自那之后只多了 PR #3（tools/validate）与 PR #4（deploy/ 脚本），都不碰运行时，但我没有在 `d9c8d356` 上重跑 acceptance（见 #流水线:#9 的汇报）。。

## 1. 接法（推荐形态）

**保留现有 runner 契约不变，把「怎么执行」抽成一个执行器后端，按 AgentSpec 的 `runtime.runner` 选。**

- 编排器只认一条契约：子进程（或进程的等价物）在本次 run 目录下启动 → 读环境变量 → stdout 给 Submit JSON → 退出码约定不变。真运行时的适配器负责把「模型调用 / 本机 agent」翻译成这条契约。
- 好处：A4/A5 全部判据、事件流、码表、`checks.lock` 比对一行不改；86 条既有测试是这次改动的回归网。
- 代价：适配器要自己完成「读输入 → 调模型 → 写产出 → 组装 Submit + evidence」，这是真正的工作量所在。

## 2. 六个待定边界

| # | 边界 | 现状（文件:行） | 需要谁定 / 怎么定 |
|---|---|---|---|
| 1 | **运行时形态** | 只有一种：本机 Node 进程同步执行（`src/run.js:290-294`）；AgentSpec 已预置 `cli`（本机进程）与 `http`（远程 API）两种枚举（`protocol/v1/spec.json:37-38`） | 形态二选一（见 §3 代价）；具体用谁、跑在哪台机器，待 shangxinha 定 |
| 2 | **每阶段输入输出边界** | 上下文文件 `context/<stage>@<iter>.json` 已写盘（`src/run.js:122-124`、`src/run.js:276-282`），但内容只有 `runId/stage/iteration/prevArtifacts:[]`；`stage.start.payload.inputs` 恒为 `[]`（`src/run.js:130`）。Flow 节点 `with` 的 `{{input.request}}`（`flows/main.yaml:9`）与上游产出目前**都没有传给执行器** | 定三件事：①阶段的任务书（prompt / 输入清单）从哪来——Flow 节点 `with`、block 的 `inputs`（`blocks/design/v1.yaml:4-9`）、还是新增字段；②上游产出怎么进下一阶段——artifact 路径（Submit 的 `artifacts[].path`，`protocol/v1/submit.json`）还是正文；③上下文文件是否仍记 sha256 进 `stage.start`（现在记的是 `contextSha256`，`src/run.js:130`） |
| 3 | **凭据持有者与注入方式** | 现在不读任何凭据；唯一的环境变量集合见 §0 | 约束已定：凭据不进仓库、不进事件流、不由 agent 代持。需要定：持有者是谁、注入到哪一层（编排器启动子进程时的环境 / 本机 agent 自己的登录态 / 远程网关代签）、注入值怎样保证不出现在 stdout（stdout 会被写进 `stage.end` 的 submit——`src/run.js:202-208`）、以及 `E_*` 错误里不得回显 |
| 4 | **超时与重试** | 同步 `spawnSync` 无超时（`src/run.js:290-294`）：一次模型调用挂住，整条 run 与 run 锁一起挂住。字段已在 AgentSpec 定义（`protocol/v1/spec.json:56-64`），Flow 侧 `on/max_iterations` 属 P0.5（`src/validate.js:9` 的 `P0_UNSUPPORTED_FIELDS`，报码在 `src/validate.js:412`） | 定：单阶段墙钟上限（建议由 AgentSpec 的 `limits.timeout_s` 落到执行器；现有校验器对「block 带了 `limits` 却没写 `timeout_s`」报 warn，`src/validate.js:308-311`）；超时的判定（见 #5）；P0 是否允许「自动重试同一阶段」——若允许，会与 `ref.drift`/`stage.start` 语义交叉，建议 M2 先只做「失败即停、人工重跑」 |
| 5 | **失败与半写的判定** | 已有三类：崩溃 = 退出码 2 + 一行 stderr、不写 error 事件（`src/run.js:149-156`，A5.8）；半行 = 末行无换行、读完忽略、下一次追加前截断并记 warn（`src/eventlog.js:30-37`、`src/run.js:161-166`）；完整但 hash 错 = 报错且不截断（`src/eventlog.js` 头注释，A5.9）。缺少的两类：①卡住不返回；②真运行时「零退出码但没有合法 Submit」——现在会判 `E_SCHEMA_INVALID`（`src/run.js:305-315`），可以接受，但和「提交格式错」混在一起 | ①超时应算「被编排器判失败」还是「崩溃」：建议归失败（有结构化 `E_RUNTIME_TIMEOUT`、有 `stage.end: failed`），不归崩溃，否则事件流里看不到原因；②必须同时确认子进程的后代进程被清理（见 §4 实测），否则超时后仍会有东西继续写文件 |
| 6 | **需要新增的错误码** | 现有码表（`docs/error-codes.md`）没有「运行时」类：调用超时、凭据缺失/失效、额度用尽、网关不可达，都会落到 `E_STAGE_FAILED`（`fix.hint` 为空）或 `E_SCHEMA_INVALID`（难区分） | 建议新增四条，形状沿用六键总则（v2.4 §2.3）：`E_RUNTIME_TIMEOUT`（`fix:{action:"retry-stage"| "raise-timeout", stage, timeout_s}`）、`E_RUNTIME_AUTH`（`fix:{action:"ask-credential-holder", provider:null}`）、`E_RUNTIME_QUOTA`（`fix:{action:"ask-credential-holder", resetsAt:null}`）、`E_RUNTIME_UNAVAILABLE`（`fix:{action:"retry-stage", detail}`）。各自的 `locatable/ids/path` 在定稿前先按 `false / ["stage:<id>"] / runs/<id>/events.jsonl#<stage>`。是否把它们作为 code-table 的正式行、是否需要 tsv 夹具，随定稿一起提交 |

## 3. 两种形态的代价

| | 本机进程（`runtime.runner: cli`） | 远程 API（`runtime.runner: http`） |
|---|---|---|
| 凭据在哪 | 在跑 run 的机器上（本机 agent 的登录态或环境变量） | 在调用 API 的一端；本机只拿到接口地址或网关凭据 |
| 隔离/权限 | 与编排器同机同用户，需要用户级隔离（独立目录已做到，进程/网络没有） | 远程侧能做到网络与文件隔离，但产出要回传 |
| 墙的完整性 | `checks.lock` 同机可写，靠 sha 比对事后发现并回滚（A4.4 现状）；A5.8 的「崩溃不写事件」可被后代进程绕过（§4） | 后端不能直接写 run 目录，墙反而更实；但回传的产出可信度取决于网关 |
| 机器要求 | 这台机器要装运行时并登录 | 这台机器只要能出网（或经代理） |
| 失败面 | 本机进程崩溃、卡住、后代进程残留 | 网络超时、限流、额度、鉴权失效 |
| 数据出机房 | 不出 | 任务书与产出都出 |

## 4. 实测：接真运行时会暴露的现有三个缺口

探针都在 `main`（`d9c8d356`）的干净副本上跑，脚本 sha256 见下；只用本机 Node，没有网络、没有凭据。

1. **后代进程在阶段返回后仍能追加事件文件**（A5.8 的边界；顺带说明「一把写锁」只约束编排器自己的写入）。
   脚本 `review/m2b/probe/stage.mjs`（sha256 `d2c1de46e3c54c44662262ee6b9ef4c5316e09b1453d7d9e6998816ac92cc449`）：阶段拿到 `FORGE_EVENTS` 指向的 `events.jsonl`，先写一行，再 `spawn(detached).unref()` 留一个 600ms 后追加一行的子进程，随即返回合法 Submit。实测：阶段返回后 33ms 时文件里只有第一行；1.3s 后是两行——**阶段结束之后文件仍被追加**。现有假程序只会「同步写完就退」，这条路径在假执行器下永远测不到。
2. **执行器能读自己的 `events.jsonl`**（输入墙）。
   把 `fixtures/fake-runner.js` 换成读自己 run 目录 `events.jsonl` 的探针（`review/m2b/probe/read-own-events.cjs.mjs`，sha256 `cf3702222b53ca34b21ca1c1e5f3faa3045ee69c06c8071342f8ee4c978fc357`，首次写成 CJS 时因 `package.json` 的 `"type":"module"` 报 `require is not defined`，改 ESM 后重跑），`node bin/forge.js run --flow flows/main.yaml` 的 `stage.end` 里：`checks.lock` / `context` / `events.jsonl` 均 `true`、cwd 即该 run 目录，证据 `exit: 0`。对照：另一次同形态的探针里 `manifest.json` 在阶段启动时还不存在（`stage.start` 早于 `manifest.json` 落盘），所以「正在发生的事」读得到、「结果清单」读不到。
3. **整机范围没有隔离**（v2.4 §3.2 已写明「无内核级隔离」，此处只是把范围量出来）。
   脚本 `review/m2b/probe/probe-walls.cjs`（sha256 `14939d49ac80e6b66d2443f796a223fc37fa22d15468175ce866285edd8be77c`）在 run 目录下实测：读写仓库根 `flows/` 下的文件「allowed」、追加写 `events.jsonl`「allowed」、改 `checks.lock`「allowed」（改会被 A4.4 事后发现并回滚），用 bash 工具读 block 正文「allowed」。换成真实运行时，这几项就是 agent 实际拥有的权限。

这三条都不改 A4/A5 判据；它们说明的是：**同机进程形态下，输入墙（只读）、进程清理、整机隔离三样目前都没有做到，靠的仍是事后审计（A4.4 的 sha 比对、A5.8 的 N0 口径）。接真运行时要么补上，要么在验收里明确记为未验。**

## 5. 对 P0 / P0.5 范围的影响

- **P0（M2 第 2 步，只换 design 阶段）**：执行器后端抽一层 + 一个适配器 + 超时 + 四条新码；A4/A5 判据不改；`node --test` 与 acceptance 不得出现新 FAIL；新增一条「运行时失败 → 结构化错误 + 退出码非 0」的测试。输入墙（只读挂载或只传副本）与后代进程清理若不做，M2 验收需显式记为未验，不能写「墙已成立」。
- **P0.5**：多 runner 调度、循环/分支重试（`on` / `max_iterations`）与运行时的关系——自动重试与 `ref.drift` / `stage.start` 的顺序约束要一起定（A5.5）；画布侧「人机同门」（A3.4/A3.5）与运行时无关，仍按原计划补跑。
- **M3 及以后**：真隔离（v2.4 §3.2 把 P0 的「无内核级隔离」记为已知限制，没有单列补救里程碑；本文用 M3 指 §3.1 里「沙箱真隔离」一项落地的阶段），到那时 §4 的第 1、3 条才可能真正关闭。

## 6. 待 shangxinha 定（三项，定了才能进第 2 步）

1. 运行时形态：本机进程还是远程 API；选后者，指出是哪家的接口或哪个网关。
2. 凭据持有者与注入方式：谁持有、注入到哪一层（见 §2 #3）。
3. 计费边界：试跑额度、是否允许自动化调用、超出后是停还是等人工。

## 附：本文引用的文件与行

`src/run.js`、`src/eventlog.js`、`src/validate.js`、`protocol/v1/spec.json`、`blocks/design/v1.yaml`、`flows/main.yaml`、`docs/error-codes.md`；文档条文 v2.4 §2.3、§3.1、§3.2、A4.4、A5.5、A5.8、A5.9。
