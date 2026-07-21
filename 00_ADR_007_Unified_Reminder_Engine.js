/**
 * 00_ADR_007_Unified_Reminder_Engine.gs
 * Reminder OS — 架构决策记录 #007
 *
 * STATUS: Accepted
 * DATE: 2026-07-19
 * SUPERSEDES: 无（跟 00_ADR_006_Reminder_Policy_Override.gs 是同一条演进
 * 路线的下一步，不是替换关系）
 */

/**
 * === 背景 ===
 *
 * ADR-006 落地后（reminder_policy 覆盖用户创建任务时的提醒策略）实测发现：
 * 一个显式指定了 reminder_policy 的任务，仍然会收到 V1
 * （25_ReminderEngine.gs）按优先级间隔发出的独立提醒——V1 从设计上就完全
 * 不知道 reminder_policy 这个字段存在，两套机制各自运作，互不感知。
 *
 * 完整两轮架构评审见 Reminder-Engine-Consolidation_Architecture-Review.md
 * （2026-07-19，第一轮）和 Unified-Reminder-Engine_Architecture-Review.md
 * （2026-07-19，第二轮，含 Carson 三处 refinement），Carson 2026-07-19
 * 批准后实现。本 ADR 只记录最终决策，完整分析过程见这两份文档。
 *
 * === 决策 ===
 *
 * 1. Reminder OS 只保留一个提醒引擎（20_ReminderEngine.gs，原
 *    26_ReminderOffsetEngine.gs），不是两套并行的独立机制。这不是新方向
 *    ——是 92_ReminderEngine.gs（2026-07-03 拆分前的原始文件）文件头就
 *    写明的创始原则（"不允许存在第二套提醒逻辑"），V1+V2 并存是加 Offset
 *    Engine 时为了控制风险做的临时妥协，这次是把系统拉回原则，不是标新
 *    立异。
 *
 * 2. 统一引擎有两个阶段，不是两个引擎：
 *    - Pre-Due（沿用原 Offset Engine）：reminder_policy 非空时严格按它
 *      生成；为空/null 时按 task.priority 查 DEFAULT_REMINDER_POLICY_CONFIG
 *      （CONFIG 驱动，按优先级分组，取代原来不分优先级的扁平数组）。
 *    - Overdue（新，取代 V1）：任务到期且未完成时，按 task.priority 查
 *      OVERDUE_POLICY_CONFIG（interval_minutes + enabled + max_repeats），
 *      持续提醒直到完成/取消。状态复用 Task 自己的
 *      reminder_count/last_reminder_at 字段（V1 时代就在用，无需数据
 *      迁移）。
 *
 * 3. 不新建"Reminder Queue"物理表——这套系统从最早的设计文档开始就有
 *    "不存会过期的未来状态，每轮重新算"这条原则，"队列"本质上是每轮
 *    轮询时内存里临时筛出来的"现在该发的那些"，做成持久化表会违反这条
 *    既有原则，且没有真实场景需要它跨轮询存在。
 *
 * 4. Escalation（换渠道/换间隔）这次不做接口设计——ADR-003 的判断
 *    （"现在只有一个通知渠道，写接口就是纯猜测，等真实使用数据"）
 *    继续适用，不因为这次要合并引擎而改变。
 *
 * === Refinements（Carson，2026-07-19）===
 *
 * a. OVERDUE_POLICY_CONFIG 每个 priority 新增 enabled 开关，不只是
 *    interval_minutes——可以针对某个 priority 单独关闭 Overdue 阶段。
 *
 * b. Quiet Hours——发现 `_isWithinQuietHours_` 和相关配置在 Pre-Due 阶段
 *    已经建好（此前只是默认关闭），这次把两个裸的 QUIET_HOURS_START_HOUR/
 *    END_HOUR 常量重构成一个 QUIET_HOURS_CONFIG 对象（跟另外两份 CONFIG
 *    同一种"导出对象引用即可配置"模式），Overdue 阶段接入同一个判断函数，
 *    不是重新做一套。
 *
 * c. ReminderHistory 新增 policy_source 列（跟 stage 一起），区分一条
 *    提醒记录来自默认策略还是用户自定义——Pre-Due 阶段照抄触发它的 Rule
 *    的 source 字段；Overdue 阶段现在只有按 priority 分组的 CONFIG，统一
 *    记 'priority_default'，为将来"单个任务自定义 Overdue 间隔"这种可能
 *    预留取值空间，不需要再改一次表结构。
 *
 * === 后果 ===
 *
 * 正面：
 *   - 改动集中在 Reminder OS 一个项目（20_ReminderEngine.gs、
 *     11_Setup.gs、00_Project_Constitution.gs），不涉及 Personal AI Core
 *     或 Productivity OS 任何文件。
 *   - reminder_count/last_reminder_at 直接复用，存量任务不需要任何数据
 *     迁移；ReminderHistory 的两个新列允许留空，不需要回填。
 *   - Snooze 按钮（Pre-Due/Overdue 消息上都有）核实过是当前唯一的一个
 *     "未来兼容功能"，两边现在都不是真的能用（点了会静默返回错误、只是
 *     显示一句友好文案），退役 V1 不损失任何真正在运作的能力。
 *
 * 需要接受的代价（不回避）：
 *   - 25_ReminderEngine.gs 文件本身没有删除，只摘掉了触发器——按迁移
 *     计划，先观察 Overdue 阶段实际表现，确认无误后再删除文件本身，这不
 *     是这次实现的一部分，需要 Carson 后续手动确认执行。
 *   - Overdue 阶段的消息内容（"Reminded: Nx"计数+逾期视觉标记）刻意
 *     保留了 V1 原本的信息量，没有照抄 Pre-Due 阶段更简短的文案——这是
 *     刻意的设计延续，不是疏漏。
 *   - 里程类（'40000km'）等非日期 due_date 的宽松判断行为（V1 原本不受
 *     72小时提前窗口限制）这次没有复刻到 Overdue 阶段——现在没有任何
 *     真实调用方（等 Vehicle/Rider OS 真的产生这类数据），符合 ADR-003
 *     的 Progression Rule，需要时再单独评估。
 *   - 92_ReminderEngine.gs（2026-07-03 拆分前的原始文件，定义裸全局
 *     函数，理论上可能跟 25_ReminderEngine.gs 同名函数冲突）、
 *     05_SheetUtils.gs（同样疑似被 21_SheetUtils.gs 取代后遗留的旧文件）
 *     ——这两个是独立于本次决定发现的、建议清理的死代码，不在这次改动
 *     范围内，记录在案供 Carson 后续处理。
 *
 * === 2026-07-21 Hotfix（Carson 发现并修复）===
 *
 * 上线后触发器报错：TypeError: ReminderEngine.checkOffsetReminders is not
 * a function。根因：20_ReminderEngine.gs 和 25_ReminderEngine.gs 都在
 * 全局作用域声明了 var ReminderEngine = (function(){...})()——这次改名
 * 时只检查了新文件本身，没检查"按迁移计划保留下来、暂不删除"的
 * 25_ReminderEngine.gs 是否会撞名。GAS 按文件加载顺序，后加载的
 * 25_ReminderEngine.gs 覆盖了 20_ReminderEngine.gs 的 ReminderEngine
 * 绑定，20_ReminderEngine.gs 自己的全局转发函数因此实际调用到了
 * 25_ReminderEngine.gs（V1）的对象上。
 *
 * 修复：25_ReminderEngine.gs（本来就是迁移观察期内的临时保留项，不是
 * 长期要用的名字）内部变量改名 ReminderEngineV1，文件末尾的全局转发函数
 * 相应改成调用 ReminderEngineV1.checkReminders()。20_ReminderEngine.gs
 * 不需要改，它的 ReminderEngine 是往后长期使用的名字。
 *
 * 教训记录：这次审查报告本身已经点出 92_ReminderEngine.gs 存在"裸全局
 * 函数可能同名覆盖"的风险（§4 风险评估第3点），却没有把同一套检查用在
 * 这次新增的 20_/25_ 这一对文件上——下次任何"保留旧文件、只停用触发器"
 * 的迁移策略，都需要显式核对新旧文件之间有没有全局作用域的命名冲突，
 * 不能假设"没有触发器调用"就等于"完全不会被加载/不会产生副作用"。
 */
