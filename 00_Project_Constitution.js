/**
 * 00_Project_Constitution.gs
 * Reminder OS v1.0 — 项目宪法
 *
 * 平台级原则的权威定义在 Personal AI Core 项目的
 * 00_Project_Constitution.gs，这里只放这个 OS 自己的东西。
 *
 * LAST_UPDATED: 2026-07-19 — Unified Reminder Engine（ADR-2026-07-19-007）：
 * 修订 P2（触发器从 checkReminders 每小时+checkOffsetReminders 每5分钟
 * 两个并存，改成 checkOffsetReminders 单一每5分钟触发器，同时承担
 * Pre-Due 和 Overdue 两个阶段）；P3 追加写入方变更说明（边界本身不变）；
 * P4 追加 REMINDER_INTERVAL_HOURS 数值去向说明（搬进新的
 * OVERDUE_POLICY_CONFIG，不是丢弃）。25_ReminderEngine.gs 停用触发器、
 * 文件本身保留观察期。
 * 2026-07-13 — 新增 P8（演进原则：保守优先，Claude 架构
 * 复审会话固定应用的默认立场）；新增 P9（领域边界：Reminder OS 不是
 * Calendar OS，Future-Proof Architecture Validation 结论）。
 * 2026-07-11 — 修订 P3（读边界从"只读 Tasks"扩大为"读
 * ActiveTasks 取候选+对 Tasks 定点查 reminder_count/last_reminder_at"，
 * 解决第三轮外部审计遗留的 HIGH RISK 2）；同步修订 P1 的表述。
 * 2026-07-10 — 修订 P3（写入机制细化为定点字段更新+Events
 * 批量发布，第四轮外部审计 HIGH RISK 1/MEDIUM RISK 1 关联）；P1 补充
 * 第四轮审计核实记录（LOW RISK 1 关联，结论：现状不变）。
 * 2026-07-06 — 新增 P6（Telegram callback 跨项目契约，外部
 * 审计 MEDIUM RISK 1 关联）；修订 P3（写入机制改成批量，外部审计
 * HIGH RISK 1 关联）；修订 P5（Setup.gs 内容已确认，去掉待确认标注）。
 */

/**
 * P1. 定位
 *     全平台共享的时间与通知服务。不是 Productivity OS 专属——现在读
 *     Tasks/ActiveTasks 两张表判断该不该提醒（见 P3 2026-07-11 更新）；
 *     未来 Property/Finance/Vehicle OS 只要往共享 Spreadsheet 写自己的表，
 *     这个项目加一段"也查那张表"的逻辑，就能复用同一套提醒/通知机制，
 *     不需要每个 Domain OS 各自重新做一套（见 Core 项目 Constitution
 *     D2/D5）。
 *
 *     ✅ 2026-07-10 核实（第四轮外部审计 LOW RISK 1，结论：现状不变）：
 *     审计建议为对接多个 Domain OS 引入一层抽象模型/字段映射，核实后
 *     发现这跟上面这段已经写明的方案（新 Domain OS 接入时"加一段查询
 *     逻辑"，不是"抽象一层通用接口"）方向相反。按 00_ADR_003_Reminder_
 *     OS_V2_Vision_Evaluation.gs 里的 Progression Rule（不为还没出现的
 *     真实需求预先设计），在 Property/Finance/Vehicle OS 任何一个真的
 *     接入之前，没有足够信息判断"通用接口"该长什么样，维持本条现状，
 *     不引入抽象层。完整决策依据见
 *     00_ADR_002_ReminderEngine_Audit_Fixes.txt「第四轮」。
 *
 * P2. 部署形态
 *     独立 Apps Script 项目，完全自主运作：自己的时间触发器
 *     （checkOffsetReminders，每5分钟——2026-07-19 起这一个触发器同时
 *     承担 Pre-Due 和 Overdue 两个阶段，取代原来 checkReminders 每小时+
 *     checkOffsetReminders 每5分钟两个独立触发器并存的状态，完整决策
 *     依据见 00_ADR_007_Unified_Reminder_Engine.txt）主动醒来、主动查、
 *     主动发 Telegram 消息。不接 Telegram webhook，不被任何项目当
 *     Library 调用，也不调用任何项目的代码——跟 Personal AI Core /
 *     Productivity OS 之间唯一的联系是"读写同一张共享 Google Sheet"。
 *
 * P3. 数据边界
 *     只写 Tasks 表的 reminder_count/last_reminder_at 两个字段，不碰
 *     其他字段，不碰 ActiveTasks/ArchiveTasks 的任何写入；另外追加自己的
 *     REMINDER_SENT 事件到共享 Events 表。
 *
 *     ✅ 2026-07-19 更新（Unified Reminder Engine）：这条边界本身没变，
 *     只是写入方从 25_ReminderEngine.gs（V1，已停用触发器）换成
 *     20_ReminderEngine.gs 的 Overdue 阶段——同样只写这两个字段，同样用
 *     SheetUtils.batchUpdateFieldsByKey_ 做定点更新，不是重新设计一套
 *     写入机制。25_ReminderEngine.gs 文件本身还在（迁移观察期），但它的
 *     触发器已经摘掉，不会再实际写入。
 *
 *     ✅ 2026-07-06 更新（外部审计 HIGH RISK 1 关联）：写 Tasks 表这两个
 *     字段的机制从"每个任务各自直接 upsertRowByKey_"改成"checkReminders()
 *     循环结束后 batchUpsertRowsByKey_ 一次性批量写"，仍然不通过
 *     Productivity OS、仍然只碰这两个字段，只是物理写入的时机和批次变了，
 *     见 2_Runtime/25_ReminderEngine.gs 的 HIGH RISK 1 修复说明（历史
 *     记录，V1 现已停用，机制精神被 Overdue 阶段继承）。
 *
 *     ✅ 2026-07-10 更新（第四轮外部审计 HIGH RISK 1/MEDIUM RISK 1 关联）：
 *     两处进一步细化，边界本身（只写这两个字段、只追加 Events、不碰
 *     ActiveTasks/ArchiveTasks 的写入）没有变：
 *       - 写 Tasks 表这两个字段，改成 SheetUtils.batchUpdateFieldsByKey_
 *         按批次做定点单元格更新（不再整表读写），仍然只碰
 *         reminder_count/last_reminder_at；
 *       - 追加 REMINDER_SENT 事件到 Events 表，改成 EventBus.publishBatch
 *         按批次一次性写入多行，不再是循环内逐条 appendRow。
 *     完整决策依据见 2_Runtime/25_ReminderEngine.gs 文件头和
 *     00_ADR_002_ReminderEngine_Audit_Fixes.txt「第四轮」。
 *
 *     🆕 2026-07-11 更新（读边界扩大，解决第三轮遗留的 HIGH RISK 2）：
 *     本条原文是"只读 Tasks 表...不碰 ActiveTasks/ArchiveTasks"——这句话
 *     现在不准确了，需要正式修订，不是补充说明：
 *
 *     读边界从"只读 Tasks"扩大为"读 ActiveTasks（候选任务列表）+ 对
 *     Tasks 做定点字段查询（reminder_count/last_reminder_at）"。原因：
 *     2_Runtime/22_QueryEngine.gs 的 getPendingTasks() 之前整张 Tasks
 *     表（含全部历史 DONE/CANCELLED 任务）都要读进内存再过滤，这是第三轮
 *     外部审计的 HIGH RISK 2，当时因为看不到 Productivity OS 的代码、
 *     没法评估有没有更好的数据源，只能记成已知问题。拿到 Productivity OS
 *     代码后确认：ActiveTasks 是它自己实时维护（不是定时批处理）、永远
 *     只含当前非终态任务的表，完全符合"取待提醒候选"这个用途；但
 *     reminder_count 的权威数据仍然只在 Tasks（ActiveTasks 上的同名列
 *     不会被同步——Productivity OS 自己的 10_ProjectionEngine.gs 明确
 *     跳过这一列；26_AnalyticsEngine.gs 的统计功能依赖 Tasks 全量任务的
 *     reminder_count 历史值，不能改成只写 ActiveTasks），所以写边界
 *     不变，只有读边界扩大。
 *
 *     这仍然是"只读、不写"关系，跟原有的"只读 Tasks"性质相同，没有反过来
 *     要求 Productivity OS 改任何代码、没有新增任何写入目标，符合本条
 *     一直以来的精神（读别的 Domain OS 的 Read Model 没问题，写只能碰
 *     自己明确拥有的那几个字段）。完整决策依据（包括为什么不是"只写
 *     ActiveTasks"、为什么不做整表归档）见
 *     00_ADR_002_ReminderEngine_Audit_Fixes.txt「第三轮 HIGH RISK 2 后续
 *     解决」。
 *
 * P4. 不变的东西（沿用 Core 宪法，历史记录）：
 *     2026-07-03 从 Core 拆分时：_shouldRemind 的判断逻辑（含当时已知的
 *     HIGH RISK 2——缺 due_date 临近性判断）原样保留，没有夹带修复。
 *     REMINDER_INTERVAL_HOURS 的数值也原样保留。改这些属于"修 bug"，
 *     不属于当时"拆分"的范围。
 *
 *     ✅ 2026-07-06 更新：HIGH RISK 2 已修复（新增 REMINDER_ADVANCE_HOURS
 *     提前量判断，未逾期且距 due_date 太远时不提醒），见
 *     2_Runtime/25_ReminderEngine.gs 的 "2026-07-06 bugfix" 注释和
 *     00_Project_State.gs「已完成」。REMINDER_INTERVAL_HOURS 数值本身
 *     没有变。这条 P4 上半段保留作为拆分时点的历史记录，不代表当前状态——
 *     当前状态以这一段"✅ 2026-07-06"为准。
 *
 *     ✅ 2026-07-19 更新（Unified Reminder Engine）：25_ReminderEngine.gs
 *     的触发器已停用，REMINDER_INTERVAL_HOURS 这几个数值（4/6/12/24小时）
 *     没有被丢弃——原样搬进了 20_ReminderEngine.gs 的
 *     OVERDUE_POLICY_CONFIG（换算成分钟，按 priority 分组，新增
 *     enabled/max_repeats 两个可配置项），不是重新设计的新数字。完整
 *     决策依据见 00_ADR_007_Unified_Reminder_Engine.txt。
 *
 * P5. 架构分层（Domain OS Blueprint，2026-07-06 采用）
 *     本项目从这次起，文件按平台统一的 Domain OS Blueprint 分层组织：
 *     0.Governance / 1.Foundation / 2.Runtime / 3.Intelligence /
 *     4.Integration / 5.Testing。
 *
 *     这份 blueprint 是跨所有 Domain OS 项目的平台级约定，按 P1 开头那句
 *     "平台级原则的权威定义在 Personal AI Core" 的一贯做法，理论上权威/
 *     完整定义也该记在 Core 项目的 00_Project_Constitution.gs 里——但这次
 *     只有 Reminder OS 的代码给到我（Claude）看，Core 项目的文件我这边
 *     没有，所以没有一并去改那边。这里先把本次采用的版本记一份本地副本；
 *     如果 Core 项目那边后续也记了权威版本、或者两边对不上，以 Core 那边
 *     为准，记得回来同步这里。
 *
 *     Reminder OS 目前只用到其中三层：
 *       - Foundation（Configuration：SecureConfig + Setup 的 createTriggers
 *         部分）
 *       - Runtime（Event / Projection / Query / Decision / Execution，
 *         对应 EventBus / SheetUtils / QueryEngine / ReminderEngine）
 *       - Integration（APIs：Output.gs 对接 Telegram Bot API）
 *     Intelligence 和 Testing 两层暂无内容，文件夹保留但是空的——不代表
 *     "漏做了"，纯粹是这个 OS 目前的功能范围用不到，具体理由见对应文件夹
 *     下的 _RESERVED.txt。
 *
 *     哪个文件对应 blueprint 的哪一层/哪个子分类、为什么某些文件（比如
 *     21_SheetUtils.gs、25_ReminderEngine.gs）横跨多层没有拆分，完整依据
 *     见 00_File_Map.txt 和 00_ADR_001_Domain_OS_Blueprint_Adoption.txt。
 *
 * P6. 跨项目契约：Telegram Interactive Callback（2026-07-06 新增，外部
 *     审计 MEDIUM RISK 1 关联，完整决策依据见
 *     00_ADR_002_ReminderEngine_Audit_Fixes.txt）
 *     2_Runtime/25_ReminderEngine.gs 的 _sendReminder 发出的提醒消息带
 *     inline button（✅ Done / ⏰ Snooze 1h），callback_data 格式固定为
 *     'task_done:{task_id}' / 'task_snooze:{task_id}'。
 *
 *     Reminder OS 自己【不接 Telegram webhook】（见 P2）——这两个按钮被
 *     点击后产生的 callback_query，只能由另一个注册了 webhook、且用
 *     同一个 TELEGRAM_TOKEN 的项目（目前是 Personal AI Core）接住并解析。
 *     这是必须显式承认、不能靠"应该没问题"默认成立的跨项目耦合：
 *       - 两边 TELEGRAM_TOKEN 必须是同一个值（README 已注明）
 *       - Core 项目必须实现对 'task_done:'/'task_snooze:' 前缀的解析，
 *         协议不能单方面改动
 *       - 如果 Core 的 webhook 没注册、掉线、或 token 不一致，用户点按钮
 *         会一直转圈直到 Telegram 超时，本项目这边不会有任何报错或日志
 *
 *     1_Foundation/11_Setup.gs 的 runDiagnostics() 新增了 webhook 可达性
 *     检查（调 Telegram getWebhookInfo，看 url 是否非空），部署时或怀疑
 *     按钮失灵时可以手动跑一次排查，但这只能检测"webhook 有没有注册"，
 *     检测不了"Core 项目是否正确解析了这两种 callback_data"——后者没有
 *     办法从 Reminder OS 这边验证，只能靠这条契约本身的文档约束，以及
 *     两边各自代码走查。
 *
 * P7. 长期方向（2026-07-06 新增，Proposed，不是已确立的架构）
 *     Reminder OS 将逐步演化为平台级 Reminder Service。
 *
 *     具体构想、评估、分阶段路线图，见
 *     00_ADR_003_Reminder_OS_V2_Vision_Evaluation.gs，不在这里重复列出，
 *     避免这份 Constitution 变成两份文档要同步维护同一份清单。
 *
 *     ⚠️ 重要：这条 P7 只是"记录有这个方向在讨论"，不代表任何新架构已经
 *     设计定案或开始实现。当前唯一在跑的实现还是 P1-P6 描述的这套 V1
 *     （单一 ReminderEngine，只认 due_date + priority 这一种规则形状）。
 *     File_Map.gs 里没有为此新增任何"预留"资料夹——范围还没有拍板，不
 *     提前建看起来像是"已经决定"的结构。
 *
 * P8. 演进原则：保守优先（2026-07-13 新增）
 *     架构复审、disposition review、新阶段设计评估中，建议"修"或"不修"、
 *     "现在做"或"以后做"时，默认偏向少做——一项改动只有在能清楚说明具体
 *     解决了什么问题、关闭了什么风险敞口时才建议 Fix Now/现在做；如果理由
 *     只是"更完整""更规范""以防万一"，且没有真实调用方或真实风险场景
 *     支撑，应该建议 Fix Later/Won't Fix，并明确写出触发重新评估的条件是
 *     什么（不能只是"以后再说"，要说清楚"以后"具体指什么发生的时候）。
 *
 *     这条原则不新增任何判断维度，是把 00_ADR_003 的 Progression Rule、
 *     00_ADR_004"考虑过但没采纳 timezone 参数"那类判断，从"针对单个 ADR
 *     的具体决定"提升为这个项目一贯适用的评审默认立场，供以后每一次
 *     架构复审直接引用，不用每次重新论证一遍"为什么要保守"。
 *
 *     原话，保留请求者措辞（比照 00_ADR_003 对三个 Open Questions 保留
 *     英文措辞的先例）：
 *     "Please be conservative. Only recommend fixes that materially
 *     improve the architecture. Avoid polishing changes that increase
 *     complexity without meaningful long-term benefit."
 *
 * P9. 领域边界：Reminder OS 不是 Calendar OS（2026-07-13 新增，
 *     Future-Proof Architecture Validation 结论）
 *     Reminder OS 拥有：reminder rules、reminder schedule、reminder
 *     queue、reminder history、notification channels、reminder
 *     lifecycle。
 *
 *     Reminder OS 不拥有，属于未来 Calendar OS：meetings、calendar
 *     events、recurring calendar schedules、time blocking、
 *     availability analysis、free/busy management、Google Calendar
 *     synchronization。
 *
 *     判断测试：这个功能需不需要知道"某个时间点上正在发生什么"（会议、
 *     事件、忙闲状态）？需要 → Calendar OS 的事。这个功能只需要知道
 *     "该在什么时候触发"，且触发时机来自别的领域已经拥有的数据（一个
 *     任务的 due_datetime、一个固定的时钟窗口）？→ Reminder OS 的事。
 *     Reminder OS 回答"该在什么时候就某件事发通知"，不回答"日历上有
 *     什么"或"此刻是否可用"。
 *
 *     两个容易被误认为"只是往前走一小步"、需要显式划线的点（完整推理见
 *     Time-Based Offset Reminder Engine 设计文档 §2.1）：
 *       - Quiet Hours（固定时钟窗口，如22:00-08:00）属于 reminder
 *         lifecycle，不是 availability analysis——它不读日历、不判断
 *         "此刻是否有会议"。如果以后真的需要"开会时不提醒"这种基于真实
 *         日历数据的动态判断，那是 Calendar OS 该做的事：由 Calendar OS
 *         计算并发布一个"当前忙碌"信号（沿用本条 P1 那套"新 Domain OS
 *         加一段查询逻辑"模式），Reminder OS 最多是读这个信号，不会自己
 *         去读 Google Calendar 或做会议冲突判断。
 *       - 1_Foundation/12_TemporalEngine.gs 的"recurring schedule"计算
 *         是通用日期数学工具，不是"recurring calendar schedule"——它不
 *         知道会议、与会人、地点、时长。即使未来的 Calendar OS 复用
 *         TemporalEngine 算"下一次周二3点"，TemporalEngine 本身依然不
 *         因此变成 Calendar 概念的拥有者，就跟它现在被 Reminder OS
 *         用、也不代表 TemporalEngine 归 Reminder OS 所有一样——它是
 *         没有领域归属的 Foundation 层基础设施（见 00_ADR_004
 *         Dependency Rule）。
 */
