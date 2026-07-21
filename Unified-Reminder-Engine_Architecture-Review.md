# Unified Reminder Engine — Architecture Review & Design

**Status:** IMPLEMENTED（2026-07-19）— 三处 refinement 已并入设计并完成实现，正式决策记录见 00_ADR_007_Unified_Reminder_Engine.gs，见文末「10. 实现记录」。

**Product principle acknowledged and applied throughout:** Reminder OS is policy-driven, not engine-driven. Everything below is designed so behavior comes from *Reminder Policy* + *Overdue Policy* + *lifecycle stage*, evaluated by one engine — not from which of two engines happens to be running.

**Method:** 基于对 `25_ReminderEngine.gs`（V1）、`26_ReminderOffsetEngine.gs`（V2）全部函数、两个项目的 Connector 层、`00_ADR_003`/`00_ADR_004` 的实际审查，不是从零设计。凡是能复用既有、已经跑通的机制（`reminder_count`/`last_reminder_at`、Rule/Occurrence/History 三表模型、"每轮重新计算、不存会过期的未来状态"这条既有原则），就复用，不重新发明。

---

## 1. Architecture Review（Deliverable 1）

### 1.1 现有两套机制的真实职责边界

| | V1（25_ReminderEngine.gs） | V2（26_ReminderOffsetEngine.gs） |
|---|---|---|
| 触发 | 每小时 | 每5分钟 |
| 数据模型 | 无独立表，直接读/写 Task 的 `reminder_count`/`last_reminder_at` | 自建 `ReminderRules`/`ReminderOccurrences`/`ReminderHistory` 三表 |
| 行为形状 | 持续重复（按优先级间隔），直到完成 | 一次性（每条 Rule 对应一次 fire_at） |
| 对 reminder_policy 的认知 | 完全不知道这个字段存在 | 唯一读取和消费这个字段的地方 |
| 平台通用性 | 对里程类（'40000km'）等非日期 due_date 有防御性处理（暂无实际调用方，等 RiderConnector） | `_resolveEffectiveDueDatetime_` 解析失败时同样安全返回 null，不会崩 |

两者从职责上从来就不是"互相竞争的同一件事的两个实现"，而是"一次性提醒"和"持续到期提醒"这两种**不同形状的行为**，只是物理上活在两个独立文件、两个独立触发器里。合并的本质不是"选一个删一个"，是把这两种行为形状都保留下来，放进同一个文件、同一个触发器、同一套数据模型里。

### 1.2 这次合并要解决的是什么

不是代码整洁度问题，是三个真实后果：
1. 你已经实测到的——V2 认识 reminder_policy，V1 不认识，两者独立运作导致显式 override 被 V1 的重复提醒盖过。
2. 两套触发器（每小时 + 每5分钟）意味着两条完全独立的 GAS 执行路径，任何未来的调试、监控、行为调整都要在两个地方各做一次。
3. 违反你们项目自己在拆分 Reminder OS 那天定下的原则（`92_ReminderEngine.gs` 文件头："不允许存在第二套提醒逻辑"）。

---

## 2. 概念清单核对（Architecture Requirements 部分的回答）

| 概念 | 是否需要 | 说明 |
|---|---|---|
| Reminder Policy | 保留，不变 | 已存在（Task.reminder_policy），这次不改 |
| Default Reminder Policy | 新增 | CONFIG 驱动、按 priority 分组，见 §4.1 |
| Overdue Policy | 新增 | CONFIG 驱动、按 priority 分组，见 §4.2、§8 |
| Reminder Occurrence | 保留，范围收窄 | 只代表 Pre-Due 阶段的"某条规则、算出来的下一次触发时间"，不代表 Overdue（理由见下） |
| **Reminder Queue** | **不建议新建物理实体** | 见下方说明 |
| Reminder History | 保留，扩展 | 新增字段区分 Pre-Due / Overdue 两种来源，两个阶段都写同一张表 |

**Reminder Queue 为什么不建议做成新表：** 这套系统从最早的设计文档开始就有一条原则——"不存会过期的未来状态，每一轮重新算"（Occurrence 现在就是这么做的：从不持久化"下次什么时候发"，每次轮询临时算）。Carson 你流程图里的"Notification Queue"这一步，实际含义是"这一轮轮询里，判定为该发了的那些提醒"——这本来就是现有 `checkOffsetReminders()` 内存里的一个临时数组（`activeRules` 过滤出 `fireAt <= now` 的那部分），不需要额外持久化成一张表。真做成表，会违反"不存futures state"这条原则，且没有任何真实场景需要"队列"具备跨轮询持久化的能力（不需要暂停、不需要跨进程传递）。**这是我唯一一处不同意字面 Architecture Requirements 里暗示的方向，理由是它会引入一个这套系统一直以来刻意避免的持久化未来状态。**

**Occurrence 为什么不延伸覆盖 Overdue：** Occurrence 的形状是"一条 Rule → 一个确定的 fire_at"，适合"提前N分钟"这种离散、有限次的提醒。Overdue 的形状是"每隔 X 小时问一次'还没完成吗'，直到完成为止"，是一个持续的状态机，不是离散列表。硬套进 Occurrence 模型，需要发明一种"会自己重新生成下一个 occurrence 的 occurrence"，比直接复用 Task 自己的 `reminder_count`/`last_reminder_at`（V1 已经在用、已经有真实历史数据）要绕。**这也是最大的向后兼容优势：现有任务的 `last_reminder_at` 不需要任何数据迁移，新引擎直接继续读它。**

---

## 3. 更新后的 Reminder Lifecycle（Deliverable 2）

```
每 5 分钟（唯一触发器，替代原本的"每小时 + 每5分钟"两个）
        │
        ▼
读取 pending tasks（既有 QueryEngine.getPendingTasks()，不变——
done/cancelled 的任务本来就不会出现在这里，这也是下面"如何停止"的答案）
        │
        ├──────────────── Pre-Due 阶段（沿用 V2，小改）────────────────┐
        │  task 还没有任何 Rule 行？                                    │
        │    → 读 task.reminder_policy                                  │
        │        非空 → 按 override 生成 Rule（source: user_override）  │
        │        null/解析失败 → 按 task.priority 查 Default Reminder   │
        │          Policy（CONFIG），生成 Rule（source: auto_default）  │
        │  已有 Rule 的 task → 检查 Occurrence 是否到 fire_at            │
        │    → 到了就发送、记 History（stage: 'pre_due'）、清理          │
        └────────────────────────────────────────────────────────────┘
        │
        ├──────────────── Overdue 阶段（新，取代 V1）──────────────────┐
        │  task.due_datetime <= now 吗？（复用 26_ 已有的                │
        │  _resolveEffectiveDueDatetime_）                                │
        │    否 → 跳过，这个 task 本轮不进入 Overdue 判断                 │
        │    是 → 查 task.priority 对应的 Overdue Policy（CONFIG）        │
        │      → policy.enabled 是 false？→ 跳过，这个 priority 完全      │
        │        不产生 Overdue 提醒（2026-07-19 refinement）             │
        │      → task.last_reminder_at 为空，或距上次已经超过             │
        │        interval_minutes？                                       │
        │      → max_repeats 设了的话，reminder_count 还没到上限？        │
        │      → _isWithinQuietHours_(now) 是 true？→ 这一轮不发，        │
        │        下一轮再判断（复用既有函数，Pre-Due 已经在用，           │
        │        2026-07-19 refinement：Overdue 现在也共用同一个门槛）    │
        │        都满足 → 发送 Overdue 提醒、reminder_count+1、           │
        │        last_reminder_at=now、记 History（stage: 'overdue',      │
        │        policy_source: 'priority_default'，见§4.4）              │
        └────────────────────────────────────────────────────────────┘
        │
        ▼
task 后续被标记 DONE/CANCELLED
  → 下一轮它就不在 pending tasks 里了，Pre-Due 的 Rule 行走既有清理逻辑
    删除，Overdue 阶段自然不再检查它——不需要一个专门的"退出 Overdue"
    步骤，"不再是 pending"本身就是退出条件。
```

这个流程图跟你给的"Task → Pre-Due → Occurrences → Notification Queue → Due DateTime Reached → 完成？→ 是/否 → Overdue → 重复 → 完成 → Close"在语义上是一致的，区别只在于：不需要一个物理的"Notification Queue"实体（§2 已说明），"Due DateTime Reached"不是一个事件触发点，是每轮轮询时的一个判断条件（因为这套系统本来就是轮询模型，不是事件驱动模型）。

---

## 4. 数据模型改动（Deliverable 3）

### 4.1 Default Reminder Policy（CONFIG，新增，不是表）

```js
var DEFAULT_REMINDER_POLICY_CONFIG = {
  LOW:      { offsets_minutes: [30] },
  MEDIUM:   { offsets_minutes: [60] },
  HIGH:     { offsets_minutes: [120, 30] },
  CRITICAL: { offsets_minutes: [1440, 120, 30] }
};
```
（数值直接采用你这次 prompt 里举的例子：LOW -30min／MEDIUM -1h／HIGH -2h+-30min／CRITICAL -1天+-2h+-30min）取代现在的扁平 `DEFAULT_REMINDER_OFFSETS_MINUTES`。

### 4.2 Overdue Policy（CONFIG，新增，不是表）—— 具体数值见 §8

```js
var OVERDUE_POLICY_CONFIG = {
  LOW:      { enabled: true, interval_minutes: 1440, max_repeats: null },
  MEDIUM:   { enabled: true, interval_minutes: 720,  max_repeats: null },
  HIGH:     { enabled: true, interval_minutes: 360,  max_repeats: null },
  CRITICAL: { enabled: true, interval_minutes: 240,  max_repeats: null }
};
```
**2026-07-19 refinement：** 每个 priority 新增 `enabled` 字段——之前的版本假设 Overdue 对所有 priority 都开启，现在可以针对某个 priority 单独关闭（比如"LOW 优先级的任务逾期了不用一直提醒"），不需要改代码，改这一个字段就行。判断逻辑里 `enabled` 检查放在最前面（见 §3 流程图），`false` 时这个 priority 的任务完全不进入 Overdue 判断。`max_repeats: null` = 无限重复（跟 V1 现状行为一致）。这两份 CONFIG 建议放进同一个地方（比如新建一个小的 `01_ReminderConfig.gs`，或者沿用现有惯例放在引擎文件顶部——你的项目里 `DEFAULT_REMINDER_OFFSETS_MINUTES` 现在就是直接放在 `26_` 文件顶部，保持一致即可，不需要为了"CONFIG 驱动"这四个字另外抽一层）。

### 4.3 ReminderRules 表——不需要 schema 变更

现有字段（`rule_id/task_id/chat_id/offset_minutes/offset_label/channels/rule_status/source/resolved_fire_ats/created_at`）足够表达 Pre-Due 阶段，Overdue 不进这张表（§2 已说明理由）。

### 4.4 ReminderHistory 表——新增两个字段

新增 `stage` 列（值：`'pre_due'` | `'overdue'`），区分这条历史记录来自哪个阶段。

**2026-07-19 refinement，新增 `policy_source` 列：** 区分这条提醒是"默认策略"还是"用户自定义"产生的，不用等以后要做分析时再加列。取值：
- Pre-Due 阶段：直接照抄触发这条提醒的 Rule 本身的 `source` 字段（`'auto_default'` | `'user_override'`），这个信息 Rule 上已经有，History 只是多留一份，不需要额外计算。
- Overdue 阶段：现在只有按 priority 分组的 CONFIG，还没有"某个任务自定义 Overdue 间隔"这种能力，所以现在一律记 `'priority_default'`；这个字段先留着这个值，将来如果真的要支持"这个任务的 Overdue 提醒间隔单独设置"，不需要再改 History 的表结构，只需要新增一个 `'user_override'` 的取值。

这是这次唯一需要的表结构改动（两个新列，`stage` + `policy_source`）。

### 4.5 Task 表（Productivity OS 侧）——不需要任何改动

`reminder_count`/`last_reminder_at` 已经存在，直接复用。

### 4.6 Quiet Hours——已经建好了，不是"预留"，是"现在就能用，只是默认关闭"

**2026-07-19 refinement 的好消息：** 查了代码，`26_ReminderOffsetEngine.gs` 里已经有 `_isWithinQuietHours_(now)` 这个函数，和 `QUIET_HOURS_START_HOUR`/`QUIET_HOURS_END_HOUR` 两个配置常量（现在都是 `null`，代表关闭），已经在 Pre-Due 阶段的发送逻辑里被调用（第656行附近），支持跨午夜窗口（比如 22 点到 8 点）。**这不是需要"预留架构、以后再做"的东西，是已经做完、只是没打开的功能。** 这次唯一要做的：Overdue 阶段的发送逻辑在真正发消息之前，同样调用一次 `_isWithinQuietHours_`（跟 Pre-Due 共用同一个函数、同一套配置，不是给 Overdue 单独做一套），命中就跳过这一轮、留到下一轮再检查（不会丢，只是延后，`last_reminder_at` 也不会被提前更新）。想启用的话，把两个常量改成具体小时数（比如 22 和 8）就行，不需要额外开发。

---

## 5. 文件改动清单（Deliverable 4）

- **`26_ReminderOffsetEngine.gs`**（建议同时改名成 `20_ReminderEngine.gs`，理由见下）——新增 Overdue 阶段的判断和发送逻辑（复用 `_isWithinQuietHours_`/`_sendReminder`风格的既有发送/重试/节流机制，不重新发明）；`DEFAULT_REMINDER_OFFSETS_MINUTES` 改成按 priority 分组的 `DEFAULT_REMINDER_POLICY_CONFIG`；新增 `OVERDUE_POLICY_CONFIG`；`_toHistoryRecord_` 新增 `stage` 字段。
- **`25_ReminderEngine.gs`**——退役。建议直接删除文件，而不是留一个空壳（详见 §6 迁移策略——不留是因为空文件本身就是一种"这里曾经有逻辑"的误导）。
- **`11_Setup.gs`**——移除 `checkReminders` 的每小时触发器，只保留（改名后的）统一引擎的每5分钟触发器。
- **`00_Project_Constitution.gs`**——P2/P4 等描述"两套独立机制"的条款更新为"单一引擎，两个阶段"。
- **`00_ADR_00X_Unified_Reminder_Engine.gs`**（新建）——正式记录这次决定，引用并部分取代 `00_ADR_003`（V2 Vision Evaluation，Phase B 的"missed occurrence 补偿"这个开放问题，这次通过 Overdue 阶段间接解决了）。
- **关于改名（`26_` → `20_`）：** 建议做，但优先级低于功能本身——`25_ReminderEngine.gs` 整个退役之后，"Offset"这个名字不再准确描述这个文件（它现在同时管 Pre-Due 和 Overdue），改成中性的 `20_ReminderEngine.gs` 更贴切。这是唯一一处我建议"顺手做"但不是这次真正要解决的问题的改动，只在你确认要做这次合并时才有意义，不需要单独决定。

**不受影响：** Productivity OS 全部文件、Personal AI Core 全部文件（`task_done:`/`task_snooze:` 回调协议不变，见上一轮审查 §4 第4点）。

---

## 6. 迁移策略（Deliverable 5）

1. 先在新引擎里实现 Overdue 阶段，跟 Pre-Due 阶段共用同一个触发器、同一次轮询——这一步 V1 继续保留、继续跑，两边并行验证新 Overdue 阶段行为是否符合预期（发送内容、间隔、停止条件）。
2. 确认新 Overdue 阶段稳定后，移除 V1 的每小时触发器（`11_Setup.gs`），但**先不删文件**，观察一到两天。
3. 确认没有任何遗漏（尤其是里程类/非日期 due_date 这种低频路径，见 §7），再删除 `25_ReminderEngine.gs` 文件本身和相关的重试/节流辅助代码（如果没有被新引擎复用的话）。
4. 不需要任何数据迁移脚本——`reminder_count`/`last_reminder_at` 字段本来就在用，新引擎直接读写同样的字段，存量数据天然兼容。

---

## 7. 向后兼容分析（Deliverable 6）

**回答你的问题1（能否安全退役 V1）：** 能，前提是 Overdue 阶段先落地并验证过（本文档§3的设计已经包含这个阶段，不是"以后再说"）。

**隐藏的行为差异（问题5）：**
- V1 的提醒消息包含"Reminded: Nx"计数和逾期红色图标／未逾期黄色图标——新引擎的 Overdue 阶段消息应该保留这个信息量（不只是照抄 V2 现在"⏰ 提醒（X分钟前）"这种 Pre-Due 风格的极简文案），否则用户会觉得信息变少了。
- 里程类（`'40000km'`）due_date 的防御性处理——V1 现在对这种值的处理方式，跟 V2 的 `_resolveEffectiveDueDatetime_` 在"解析失败就安全返回 null/false，不崩溃"这一点上是一致的，但 V1 对于"距今多久"未知时会用一种更宽松的判断（不受72小时提前窗口限制），V2 目前对无法解析 due 的任务直接整体跳过（不参与 Pre-Due，也不会参与 Overdue，因为 Overdue 判断本身就需要先能解析出 due_datetime）。这条路径目前没有任何实际调用方（等 RiderConnector 才会有），我认为可以先保持"V2 现在的安全跳过"这个行为，不需要为了一个还没人用的场景特意复刻 V1 的更宽松处理——等 Vehicle/Rider OS 真的开始产生里程类 due_date 时，那时候有真实场景再设计，符合 ADR-003 定的 Progression Rule。

---

## 8. Overdue Policy 设计建议（Deliverable 8）

你列的选项逐一评估：
- **repeat every X hours** —— 采用，按 priority 分组（§4.2），直接沿用 V1 已经验证过的 4h/6h/12h/24h 分级，不是凭空定新数字。
- **escalation strategy**（换渠道/换间隔）—— **不在这次做**。这是你自己"Future Compatibility"清单里单独列出的 Escalation，ADR-003 当时的判断（"现在写接口就是纯猜测，等真的有使用数据"）我认为仍然适用——现在只有一个通知渠道，没有真实的"忽略模式"数据。Overdue Policy 的 CONFIG 形状（每个 priority 一个 interval + 可选 max_repeats）不会阻止未来加 escalation，只是这次不做。
- **configurable intervals** —— 采用，CONFIG 驱动（§4.2），不写死在函数里。
- **maximum repeat count（optional）** —— 采用，做成可选字段，默认 null（无限重复，匹配 V1 现状），需要时可以给某个 priority 设置具体上限。
- **stop when completed / stop when cancelled** —— 不需要专门实现："pending tasks 查询天然排除已完成/已取消"这个既有机制已经覆盖了这一点，见 §3 流程图。

---

## 9. 风险评估（Deliverable 7）

1. **【中，需要在实现时验证】Overdue 消息内容不能比 V1 现在的信息量少**——见 §7，具体是"Reminded: Nx"和逾期视觉标记要在新引擎里保留。
2. **【低，暂不处理，需要记录】里程类 due_date 的宽松判断行为差异**——见 §7，等真实调用方出现再处理，不阻塞这次合并。
3. **【低，独立于这次决定但顺手提醒】`92_ReminderEngine.gs`**——上一轮审查发现的死代码文件，建议这次一并清理。
4. **【需要在实现阶段做】触发频率变化**——V1 现在是每小时检查一次，Overdue 阶段并入每5分钟轮询后，理论上响应更及时（不会出现"该提醒但要等到整点"的情况），这是改善不是风险，但要确认没有依赖"整点"这个隐含假设的地方（目前没有发现任何这样的假设，只是列出来供你确认）。

---

## 10. 实现记录（2026-07-19）

**改动文件（Reminder OS，只列有改动/新增的，.gs 以 .txt 交付）：**

`20_ReminderEngine.txt`（原 `26_ReminderOffsetEngine.txt` 改名——**Carson 需要删除旧文件**）、`50_ReminderEngine_Tests.txt`（原 `50_ReminderOffsetEngine_Tests.txt` 改名——**需要删除旧文件**）、`run_reminder_tests.js`（原 `run_offset_tests.js` 改名——**需要删除旧文件**）、`00_ADR_007_Unified_Reminder_Engine.txt`（新建）、`11_Setup.txt`、`00_Project_Constitution.txt`、`00_Project_State.txt`。

**`25_ReminderEngine.gs`（V1）本身没有删除**——按 §6 迁移策略，只摘掉了它的每小时触发器（`11_Setup.gs` 的 `createTriggers()` 不再注册它），文件内容原样保留，作为观察期的安全网。确认 Overdue 阶段实际运作一段时间没问题后，再手动删除这个文件，不是这次实现的一部分。

**三处 refinement 落地方式：**
1. `OVERDUE_POLICY_CONFIG` 每个 priority 增加 `enabled` 字段。
2. `QUIET_HOURS_START_HOUR`/`QUIET_HOURS_END_HOUR` 两个裸变量重构成 `QUIET_HOURS_CONFIG` 对象——原因是裸的 number/null 变量导出到模块外面是拷贝值，没法真正做到"可配置"；包成对象之后可以跟另外两份 CONFIG 一样导出对象引用直接调整。
3. `ReminderHistory` 新增 `stage`/`policy_source` 两列，`11_Setup.gs` 新增 `migrateSchemaReminderHistoryStages()` 迁移函数（幂等，只加列不填数据）。

**验证：** 完整测试套件（含新增的场景 A2/J/K/L/M/N，覆盖 priority 缺失回退、Overdue 基础发送、间隔未到、`enabled=false`、`max_repeats` 到上限、Quiet Hours 门控）真实执行 71 项全部通过（`node run_reminder_tests.js`），不是只做语法检查。

**顺手发现、记录但不在这次改动范围内：** `92_ReminderEngine.gs`（2026-07-03 拆分前的原始文件，定义裸全局函数）、`05_SheetUtils.gs`（疑似被 `21_SheetUtils.gs` 取代后的遗留文件）——两者都建议找时间清理，理由见 00_ADR_007 的"需要接受的代价"部分。
