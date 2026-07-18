/**
 * 00_ADR_006_Reminder_Policy_Override.gs
 * Reminder OS — 架构决策记录 #006
 *
 * STATUS: Accepted
 * DATE: 2026-07-17
 *
 * ⚠️ 编号说明：00_ADR_003（§ V2 Vision Evaluation）曾经为"真正的 Phase B
 * 设计"预留了 00_ADR_005 这个号，并明确建议"下次要写 Phase B 设计之前，
 * 先回来重新过一遍"。这次的 reminder_policy override 不是那份 Phase B
 * 设计（V2 Vision 里评估过、当时明确不采纳的完整 request/rules-table/
 * webhook 能力）——这次是在既有 V1 Offset Engine（26_ReminderOffsetEngine.gs，
 * Rule/Occurrence/History 三表模型）基础上做的一次局部扩展，范围小得多。
 * 为避免跟 003 预留的"005"混淆，这里跳到 006，005 继续留给未来真正评估
 * Phase B 时使用。
 */

/**
 * === 背景 ===
 *
 * Productivity OS 侧的原始需求（"Reminder OS / Productivity OS
 * Enhancement"文档）：用户创建任务时可以直接覆盖默认提醒策略（"remind me
 * 30 minutes before"这类短语），三种输入对应三种结果：
 *   - 不提 → 用默认策略
 *   - "remind me 30 minutes before" → 只生成这一条提前提醒
 *   - "no advance reminder" → 不生成提前提醒
 *
 * 完整的跨项目架构审查见 Personal-AI-main 那次对话产出的
 * Reminder-Policy-Override_Architecture-Review.md（Carson 2026-07-17
 * 批准）。本 ADR 只记录落到 Reminder OS 这一侧、需要长期遵守的决策，不
 * 重复整份审查文档的内容。
 *
 * 核心设计问题：reminder_policy 这个新字段该长在哪、Reminder OS 的规则
 * 生成逻辑该怎么消费它、消费的时机应该多"实时"。
 *
 * === 决策 ===
 *
 * 1. reminder_policy 长在 Productivity OS 的 Task 记录上（不是 Reminder OS
 *    自己的新表），JSON 字符串，null 表示"用默认策略"，{offsets:[]} 表示
 *    "不要提前提醒"，{offsets:[{value,unit}]} 表示显式覆盖。Reminder OS
 *    通过既有的 QueryEngine.getPendingTasks() 只读通道读取，不需要新的
 *    Connector 写能力（08_ReminderConnector.gs 现有的六个写操作
 *    supported:false 保持不变，这次功能不碰这个缺口）。
 *
 *    理由：ActiveTasks 投影是通用透传（Productivity OS
 *    10_ProjectionEngine.projectTaskCreated_ 整个 event payload upsert），
 *    QueryEngine 按表头通用转成扁平对象——新字段不需要改这两处代码就能
 *    读到，跟当年 due_time/due_datetime 免改这两个文件是同一个理由。
 *
 * 2. Task.reminder_policy 是唯一 Truth Source，ReminderRules 是它的
 *    Materialized Projection（Carson 决定 #3，2026-07-17）。
 *
 * 3. 落地时机采用窄口径（Carson 决定 #4，2026-07-17）：_ensureDefaultRules_
 *    改名 _ensureRulesFromPolicy_，只在 taskIdsWithRules 未命中（这个 task
 *    还没有任何规则行）的那一刻读一次 task.reminder_policy 决定生成什么，
 *    之后不再复查、不引入持续 Rebuild。原因是保持职责边界和现有引擎
 *    "首次物化、后续只调度"这套运行模型的成本纪律，不是单纯为了省扫描
 *    次数（Carson 原话）。
 *
 *    推论：手工直接改 ReminderRules 表或共享 Sheet，是本阶段之外的
 *    escape hatch，不在自动纠正范围内。未来如果 Productivity OS 支持
 *    "创建后修改 reminder_policy"，需要那个能力自己设计 Re-materialization
 *    流程，不是在 checkOffsetReminders 的热路径里加持续一致性检查。
 *
 * 4. "Due Reminder"（no advance reminder 时）语义（Carson 决定 #1，
 *    2026-07-17）：reminder_policy.offsets=[] 只表示"不建立任何 Offset
 *    Reminder"，不影响 25_ReminderEngine.gs（V1）的到期提醒，也不新增
 *    offset=0 这种特殊规则。V1 和 V2（Offset Engine）继续是两套完全独立、
 *    并行运行的机制（各自的 trigger：checkReminders 每小时、
 *    checkOffsetReminders 每5分钟），V1 从未、也不会读 reminder_policy。
 *
 *    理由：Offset Reminder（提前提醒）和 Due Reminder（到期提醒）是两种
 *    不同职责，前者是 Offset Policy 管辖的全部范围；引入 offset=0 会让
 *    "提前提醒"和"到期提醒"这两个概念在同一个机制里混在一起，不值得为了
 *    一个空数组的语义换来这种概念混淆。
 *
 * 5. 范围：本次只覆盖 Task 创建流程。创建后修改 reminder_policy 是独立
 *    能力，不在本次范围内（Carson 决定 #2，2026-07-17）——直接推论：本阶段
 *    reminder_policy 一旦写入 Task，不会再变化，"决策 3"的窄口径落地
 *    时机因此不会遗漏任何"Task 变了但 Rules 没跟上"的真实场景。
 *
 * === 后果 ===
 *
 * 正面：
 *   - 本次改动完全不touch Personal AI Core、Connector Layer（08_ 前缀
 *     六个文件）、12_TemporalEngine.gs、22_QueryEngine.gs——改动面严格
 *     限制在 26_ReminderOffsetEngine.gs 一个文件的一个函数
 *     （_ensureRulesFromPolicy_，原 _ensureDefaultRules_）。
 *   - reminder_policy 为 null 时（存量任务、以及本次改动之前创建的任何
 *     任务）行为跟改动前逐字节一致，不需要数据回填，只需要一次 schema
 *     迁移（Productivity OS 侧的 migrateSchemaReminderPolicy()，新增列
 *     本身）。
 *   - _ensureDefaultRules_ 保留一个只返回规则数组的 @deprecated wrapper，
 *     任何直接引用旧名字的外部代码（包括单元测试）不会被打破。
 *
 * 需要接受的代价（不回避）：
 *   - 如果有人在 Offset Engine 第一次处理某个 task 之前，手工往
 *     ReminderRules 表插入一条跟该 task 相关的行（极窄的竞态窗口，需要
 *     恰好卡在"任务创建"和"Offset Engine 下一次 5 分钟轮询"之间手动操作
 *     这张表），taskIdsWithRules 会命中，这次的 reminder_policy 会被
 *     静默跳过，不会被"纠正"回 reminder_policy 声明的内容——这是决策 3
 *     窄口径的直接代价，评估后认为这个窗口足够窄、后果足够可控（用户
 *     顶多是没拿到自己要的 override，不是拿到错误的数据），换来不必在
 *     每一轮热路径里都做一次比对的成本纪律，是值得的取舍（Carson 原话：
 *     "不是为了省几次扫描，而是为了保持职责边界和成本模型"）。
 *   - reminder_policy.offsets 里出现无法识别的 unit（不是
 *     minutes/hours/days）时，_offsetToMinutes_ 静默丢弃这一条、不报错
 *     不中断——好过让一个 task 因为一个看不懂的 offset 而完全拿不到任何
 *     提醒。这类输入理论上不应该出现（Productivity OS 侧的解析器只会产出
 *     这三种 unit），当前没有观察到实际发生，属于防御性处理，不是已知会
 *     触发的路径。
 *   - 这条 ADR 只覆盖 Reminder OS 这一侧。Productivity OS 侧的 Schema
 *     变更、解析器扩展、Known Limitations 边界扩展记在该项目自己的
 *     ADR-2026-07-17-009 里，不在这份文件重复。
 */
