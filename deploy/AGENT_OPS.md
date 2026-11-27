# AgentForge 本地部署与 PR 验收（员工四号 runbook）

## 边界
- 机器：wsl-raft2（node v26.13.1 / npm 12.2.2 / git 2.43.0），**无 docker**；部署 = node 进程 + 端口。
- 仓库：`ot-workshop/AgentForge`（GitHub，经 Stamp）。需要 Stamp 登录后才能看私有 PR / 合并；未登录时只能处理公开仓库或本地 patch。
- 不代持凭据，不替人类登录。

## 约定（待 shangxinha 确认）
- 端口：Live/SSE `8787`，可由 `FORGE_PORT` 覆盖。
- SSE：`GET /events?run=<run_id>&since=<seq>`（严格 > since）。**必须带 `?run=`**（员工一号 cbb984d2）：省略时服务端只返回最新 run；不同 run 的帧不得混进同一条流；未知 run 必须 4xx + 结构化 code。**判据按 EventSource 标准**：帧以空行结束，`data:` 多行按 `\n` 拼接后 JSON.parse，得到的就是事件对象本身（不包一层）。实现约定 `data: <单行 JSON>` 只是便于人读，不作判据。
- 重连方式（写进每份报告）：**重建 URL 并显式带 `since=<最后完整 seq>`**，不依赖 `Last-Event-ID` 自动携带。
- 证据：A2.4 报告附 `curl -N "$BASE/events?since=0"` 前 200 字节原文。
- 健康检查（存活）：`GET /healthz` 200 + `{"ok":true}`；`GET /snapshot` 200 且能解析出 `runs` **数组**，冷启动 `[]` 记 healthy。
- 冒烟（有数据，分开断言）：`bash deploy/smoke.sh` —— 部署后跑一次假 runner，断言 `/snapshot` 里出现本次新 run。
- 部署目录：`/srv/agentforge/<deployed_sha>/`，`current` 软链指向当前版本；回滚 = 改软链 + 重启。
- **部署输入只能是合并后 `main` 上的 merge sha**，且员工二号对那一版复核 PASS（员工一号 fac6fcaa/417485a5）。`deploy.sh` 会核对 `merge-base --is-ancestor <sha> origin/main`，不满足直接拒绝。
- `deploy.sh` 跑完自动写 `/srv/agentforge/deploy-report-<short sha>.md`（七项骨架）；**没有这份报告不算部署过**，脚本 rc=0 也不算。
- 报告里的 acceptance 表：用与 PR 复核同一版脚本对 merge sha 重跑，**只列与 PR head 的增量行**，并给出两次运行的脚本 sha、两次 PASS/FAIL/UNVERIFIED 计数与逐条差异；改脚本导致判反时旧结果整份作废，报告里保留旧 sha + 作废原因一行。
- 回滚点：报告里写 `sha + 部署目录绝对路径`，验收方按路径核对 `current` 确实指回旧 sha。
- 报告粒度：一份报告只对应一个 commit sha；同 sha 重部署不重发，换 sha 必须重发。
- 报告每项一行：`编号 | PASS/FAIL/UNVERIFIED | 证据（命令摘要 / 事件 seq / 文件 sha）`；另写脚本 sha 与 fixture sha。
- 基准文档：agentforge-v2.4（附录 A/C 判据为唯一真相，附录 D 仲裁规则，附录 E CLI 契约，附录 I 的 A8–A12 标 [P0.5]）。
- P0 范围（2026-11-26 拍板）：线性 Flow + 事件流 + Live；bug 修复流不在可运行范围，P0 只要求 schema 可表达 + 校验器给出「P0 不支持」的结构化错误。
- Live 必须按 `(stage, iteration)` 分格；`iteration` 缺省为 1 与显式 1 的 `/snapshot` 必须逐字节一致（已进 smoke.sh）。
- 仓库写入：苦力三号 / 员工三号 / 我各自登录 Stamp、以自己身份开 PR；合并与验收结论归苦力三号。
- UNVERIFIED 不因冒烟全绿改判 PASS，分两类写：**「P0 范围外」**（多 runner、画布编辑）与 **「接口待定」**（脚本与实现约定不一致等）。「接口待定」必须同时作为待定项提给苦力三号和员工一号，下一轮必须变 PASS 或 FAIL；「帧格式不一致」按标准判 FAIL（协议面缺陷），不算未验。

## 收到 PR 后的流程
1. 取 PR：`stamp pr view <N> --repo ot-workshop/AgentForge`，`stamp pr diff <N> --repo ...` 通读。
2. 干净目录拉该 PR 的 head（精确 head，不用 merge 后的本地分支）：
   `git clone --depth 1 --branch <pr-head-branch> <repo_url> /srv/agentforge/build-<sha>`
3. 静态门槛：`npm ci && npm test`；测试名必须覆盖附录 A 编号（v2.1 口径：A1.1…A7.x）。
4. 验收门槛（附录 A，A1–A5 全过；画布相关 A3.4/A3.5 画布侧标「未验」不算通过）：
   `bash deploy/ci/acceptance.sh <workspace_dir>` —— 见该脚本，逐条跑并输出 PASS/FAIL 表。
5. block 漂移：`forge verify --check-refs` 必须报无 `E_BLOCK_CONTENT_DRIFT` / `E_FLOW_CONTENT_DRIFT`（A7.2）。
6. 搭积木检查：同一 block 被 ≥2 条 flow 引用时，换一个 block 版本不影响另一条 flow（目录级 diff + 干跑校验）。
7. 合并：不归我 —— 合并与最终验收结论在苦力三号。我只交部署版本证据；收到其合并/部署触发后执行第 8 步。
8. 部署：`bash deploy/deploy.sh <sha>`（安装、启动、健康检查）；随后 `bash deploy/smoke.sh` 做有数据冒烟；任一步失败自动回滚到上一版本。
9. 在 PR 与 #流水线 回报：PASS/FAIL 表摘要、部署版本、端口、访问方式、未覆盖项。

## 模拟自证（无仓库也能跑）
`bash deploy/ci/sim/run_sim.sh`：造两个提交模拟 PR，跑部署脚本 + 回滚 + 健康检查，输出日志。

## 三份独立证据（员工二号 e4a6a479 提议，已对齐）
- 员工三号：开发机自测（实现者证据）。
- 员工二号：干净克隆按文档命令复跑 A1–A7，只报通过/失败/未验 + commit + 输出文件。
- 员工四号（我）：部署环境复跑同一套命令（`deploy/ci/acceptance.sh`），产出「部署版本」证据，并执行苦力三号触发的部署。
- 合并权与最终验收结论在苦力三号（shangxinha 原话，edb87f73 已更正）；我只报证据，不宣布合并。

## 已知阻塞
- Stamp `session: not logged in`：看私有 PR / approve / merge / push 都做不了，需有权限的人批准我的 Stamp 登录。
- 无 docker：P0 不容器化。
