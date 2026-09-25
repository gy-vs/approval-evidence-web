# approval-evidence-web

异步审批的**证据冻结与回放**演示。提交时服务端冻结输入、规则版本、基线值、计算结果与摘要；审批人在源数据变化后仍能查看原始依据，批准/拒绝/撤回的决定与该快照摘要绑定。批准执行的是冻结的拟执行值，而不是审批当时的当前对象值。

## 三个分离的数据面

| 平面 | 内容 | 是否可变 |
| --- | --- | --- |
| 当前对象 `current` | live 对象 `{value, version, updatedAt}` | 直接保存或批准落库时产生新版本 |
| 待审/冻结提交 `submissions` | 不可变快照：输入、基线值与版本、规则 `ruleId@version` + 规则摘要、计算结果、拟执行值、快照摘要、状态机 | 状态迁移受控，快照内容不动 |
| 历史决定 `decisions` | 仅追加：谁、何时、结论、理由、决定时 live 版本、**绑定的快照摘要**、冲突是否确认、落库版本 | 仅追加 |

快照摘要与规则摘要均为 sha256；`replaySnapshot` 用冻结的规则版本对冻结输入重算并逐项比对（规则摘要 / ruleOutcome / proposedValue / 快照摘要）。

## 状态与异常码（不是隐藏按钮）

- `pending → approved | rejected | withdrawn`，终态再操作返回 `DECISION_CONFLICT` / `NOT_PENDING`
- 提交后源数据变化：待审项标记冲突，未显式 `allowConflict` 时批准返回 `CONFLICT`；确认后仍只执行冻结值
- 审批期间的新提交是独立快照，旧审批的决定永远绑定旧摘要、旧基线版本
- 权限在操作时校验：`PERMISSION_DENIED`；撤回仅提交人本人可用
- 证据问题定位到字段：`EVIDENCE_MISSING`（含字段名）、`EVIDENCE_TAMPERED`、`RULE_VERSION_UNKNOWN`、`RULE_VERSION_MISSING`
- 旧流程保持兼容：`PUT /api/source` 直接保存、`{id, evidence}` 旧提交（标记 `legacy`，源数据变化时仍是原来的 `SOURCE_CHANGED` 严格行为）

## 接口

- `PUT /api/source {id, value}` — 直接保存路径（原契约）
- `POST /api/submissions {objectId, input, rule?}` — 冻结证据并提交（旧 `{id, evidence}` 仍支持）
- `GET /api/submissions/:id` — 快照、回放结果、与 live 的差异、冲突、历史决定
- `POST /api/decisions {submissionId, outcome, reason?, allowConflict?}` — 批准/拒绝；批准落库冻结值
- `POST /api/submissions/:id/withdraw` — 提交人撤回
- `GET /api/state?viewer=` / `GET /api/approvals`（旧聚合接口）/ `GET /api/rules`
- `GET|PUT /api/permissions`；`GET /api/events`（SSE，前端断线自动轮询兜底）
- 请求头 `x-actor` 标识操作人（alice 可提交+审批，bob 仅提交，carol 仅审批）

前端每张审批卡有三个页签：**原始快照 / 当前差异 / 历史决定**；冲突、证据缺失、终态都有明确文案与服务端错误码展示。

## 持久化

默认写入 `data/ledger.json`（原子 temp+rename，已在 `.gitignore`），重启后证据、决定与事件均可回放；`DATA_FILE=:memory:` 使用内存模式。

## 运行

```bash
npm start          # http://localhost:4184
npm test           # node --test，23 个用例
```

测试覆盖：证据不被当前数据覆盖、批准实际落库冻结版本、版本冲突不会静默通过、并发提交互不串版本、重复决定/撤回/权限变化的显式状态、篡改与部分缺失证据的字段级定位、重启后回放、SSE 实时推送，以及旧接口端到端兼容。
