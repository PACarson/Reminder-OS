/**
 * 00_Project_State.gs
 * Reminder OS v1.0 — 项目状态快照
 *
 * ⚠️ 快照，不是日志。
 * LAST_UPDATED: 2026-07-19 — Unified Reminder Engine（ADR-2026-07-19-007）：
 * 退役 V1（25_ReminderEngine.gs 停用触发器），Overdue 阶段并入
 * 20_ReminderEngine.gs（原 26_ReminderOffsetEngine.gs），reminder_policy
 * 和优先级默认策略、Overdue 持续提醒现在是同一个引擎的两个阶段，不是
 * 两套独立机制。完整决策记录见 00_ADR_007_Unified_Reminder_Engine.gs。
 * 2026-07-17 — 支持 Productivity OS 新增的
 * Task.reminder_policy 字段（创建任务时覆盖默认提醒策略），
 * 26_ReminderOffsetEngine.gs 的 _ensureDefaultRules_ 改名并扩展为读取
 * reminder_policy 优先于默认常量，落地时机采用窄口径（只在首次物化
 * 生效）。完整决策记录见 00_ADR_006_Reminder_Policy_Override.gs。
 * 2026-07-15 — 修复第五轮外部审计发现的 HIGH RISK 1-4、
 * MEDIUM RISK 1 共5项 + 顺带同一反模式的 occurrenceDeleteKeys、LOW
 * RISK 1（TemporalEngine Finding 3 从 Fix Later 提升为 Fix Now）；
 * 另修复同日 GAS Console 实测的3个问题（parseDueDate_ 对 Date 对象
 * 抛错、离线测试套件在 GAS 里跑会报 ReferenceError、Output.sendMessage
 * 的 error 字段在 Telegram 业务级失败时始终 undefined）。HIGH RISK 4
 * （跨项目 LockService 不生效）核实属实但无法从 Reminder OS 单个项目
 * 内解决，新增到「已知问题」。新增3份此前完全没有覆盖的测试文件
 * （SheetUtils/EventBus/Output），测试从前四轮遗留的71项（TemporalEngine
 * 43 + OffsetEngine 28）增加到115项全部通过。完整决策依据见 00_ADR_002
 * 「第五轮外部审计」和 00_ADR_004「2026-07-15 修订记录」。
 * 2026-07-11 — 拿到 Productivity OS 代码，解决第三轮
 * 外部审计遗留的 HIGH RISK 2（QueryEngine 读整张 Tasks 表的性能问题），
 * getPendingTasks() 改为从 ActiveTasks 取候选+对 Tasks 定点查两个字段；
 * 记录两个调查过程中发现的、跟 Productivity OS 有关但不是本项目能修的
 * 观察（last_reminder_at 不在官方 schema 清单里、TaskStatistics.
 * reminder_count_total 实际不会被本项目触发更新）。
 * 2026-07-10 — 修复第四轮外部审计发现的 HIGH RISK 1/2/3、
 * MEDIUM RISK 1 共4项；核实 MEDIUM RISK 2（Telegram 送达状态不确定导致
 * 的偶发重复发送）和 LOW RISK 1（Constitution 抽象层建议）属实但不适合
 * /不需要代码修复，理由见「已知问题」和 00_Project_Constitution.gs P1。
 * 2026-07-06 — 修复上一轮 HIGH RISK 2；按 Domain OS
 * Blueprint 重组全部文件；15_Setup.gs 内容不符问题已收到真实代码并替换
 * 确认；修复第一轮外部审计的 HIGH RISK 1/2、MEDIUM RISK 1/2、
 * LOW RISK 1/2 共6项；完成 Phase A（Temporal Engine）Contract 设计+
 * 实现+测试；修复第二轮外部审计的 HIGH/MEDIUM/LOW RISK 各两项，并发现
 * 修复一个更严重的既有 bug（last_reminder_at 从未被写入，提醒频率控制
 * 实际从未生效）；修复第三轮外部审计发现（分批写+失败重试、lock竞争
 * 自动重试、正则简化），核实两条审计描述与实际代码不符、一条需要跨项目
 * 数据边界评估暂不处理；记录 Phase B 的 3 个 Open Questions，刻意留待
 * Phase A 实际使用经验积累后再回答。
 */

// ============================================================
// 一、已完成
// ============================================================

/**
 * - 2026-07-03：从 Personal AI Core 物理拆分为独立项目。92_ReminderEngine.gs
 *   只改了 2 处（getPendingTasks() → QueryEngine.getPendingTasks()；
 *   _materializeTaskRow_(...) → upsertRowByKey_('Tasks', ...)，因为原来
 *   调的那两个函数所在的文件不在本项目了），判断逻辑逐字未改。
 *
 * - 2026-07-06：修复 HIGH RISK 2。_shouldRemind 新增 _hoursUntilDue 判断+
 *   REMINDER_ADVANCE_HOURS 常量（默认 72 小时，Claude 选的默认值，未逾期
 *   且距 due_date 超过这个提前量时直接不提醒）；里程类 due_date（'40000km'）
 *   维持原行为不受影响，等 RiderConnector 接好再处理。REMINDER_INTERVAL_HOURS
 *   数值未变。详见 2_Runtime/25_ReminderEngine.gs 的 "2026-07-06 bugfix" 注释。
 *
 * - 2026-07-06：全部文件按 Domain OS Blueprint（Governance/Foundation/
 *   Runtime/Intelligence/Integration/Testing）重新组织到对应文件夹+新编号，
 *   00_File_Map.gs 全面重写，00_Project_Constitution.gs 新增 P5，新增
 *   00_ADR_001_Domain_OS_Blueprint_Adoption.gs 记录采用理由和具体判断。
 *   GAS 是扁平命名空间、没有 import，重命名/挪动文件不影响任何调用关系，
 *   这次改动纯粹是物理位置+文件名+文档，不涉及任何函数签名或调用方式变化。
 *
 * - 2026-07-06：收到 15_Setup.gs 真实代码，确认打包时那份内容确实是误把
 *   12_QueryEngine.txt 复制进去了。已用真实代码替换 1_Foundation/11_Setup.gs
 *   里之前那份反推重建版。真实版 runDiagnostics() 比重建版多做了
 *   SPREADSHEET_ID / TELEGRAM_TOKEN 各自独立的存在性检查，且是逐条
 *   Logger.log 输出诊断信息的风格，不返回结构化对象——File_Map/README
 *   当初对这个文件行为的文字描述本身没有问题，纯粹是 zip 打包时这一个
 *   文件被顶替了。
 *
 * - 2026-07-06：修复外部审计对 2_Runtime/25_ReminderEngine.gs、
 *   2_Runtime/20_EventBus.gs 的新一轮发现，按严重程度全部处理，完整决策
 *   依据见 00_ADR_002_ReminderEngine_Audit_Fixes.gs：
 *   · HIGH RISK 1：checkReminders 循环里不再逐任务调 upsertRowByKey_
 *     （O(N)次全表扫描式 Sheet I/O），改成循环内只更新内存、结束后
 *     batchUpsertRowsByKey_ 一次性批量写回。
 *   · HIGH RISK 2：_sendReminder 之间加 Utilities.sleep(1000)，避免撞
 *     Telegram 单聊天每秒最多1条消息的限流（已查官方 Bots FAQ 核实限额）。
 *   · MEDIUM RISK 1：这个耦合本身没法从 Reminder OS 单边"修掉"（webhook
 *     注册和 callback 解析都在 Personal AI Core 项目）——补的是文档约束
 *     （00_Project_Constitution.gs 新增 P6）和诊断可达性检查
 *     （1_Foundation/11_Setup.gs 的 runDiagnostics() 新增 getWebhookInfo
 *     检查）。这条严格说是"降低风险+文档化"，不是"消除风险"，见下面
 *     「已知问题」。
 *   · MEDIUM RISK 2：25_ReminderEngine.gs 全部逻辑和常量包进 IIFE
 *     （ReminderEngine 模块），不再平铺全局。对审计原始建议做了修正：
 *     checkReminders 必须保留一个薄的全局函数转发，因为 GAS 触发器按
 *     字符串名字找全局函数绑定，找不到 IIFE 返回对象的属性。
 *   · LOW RISK 1：lock.waitLock 从 5000ms 延长到 30000ms（HIGH RISK 2
 *     的节流会让单次执行变长，5秒等待太容易误判"前一个没跑完"而跳过）。
 *   · LOW RISK 2：20_EventBus.gs 的 _sheet_() 新增惰性缓存，同一次执行内
 *     不再重复 SpreadsheetApp.openById。
 *   全部6项改动都用 mock GAS 环境跑过针对性验证（批量写入次数、节流调用
 *   次数、IIFE 封装后内部函数不再泄漏到全局、webhook 诊断两种分支），
 *   不是只凭代码审查判断"看起来对"。
 *
 * - 2026-07-06：完成 Phase A（Temporal Engine）的 A0（Contract 设计，
 *   00_ADR_004_Temporal_Engine_Design.gs）+ A1（实现，
 *   1_Foundation/12_TemporalEngine.gs）。Gate Review 5点确认（时间基准/
 *   错误处理约定/测试矩阵/性能上限/调用关系）+ 4条精化（Immutable/Pure
 *   Function/timezone 参数取舍/Dependency Rule）全部并入 ADR-004。
 *   实现过程中发现并修了一个真实 Contract 漏洞：every_n_days 原本没有
 *   锚点日期，同一条规则从不同时间点查询会得到不一致结果——补上了必填
 *   的 start_date 字段，回写进 ADR-004（没有绕开 Contract 直接在代码里
 *   悄悄兼容）。5_Testing/50_TemporalEngine_Tests.gs 覆盖完整 Test
 *   Matrix（含闰年、世纪年边界、月份溢出跳过、fromTime/untilTime精确
 *   命中、parseRule非法输入、Immutable验证、Reminder/Finance/Vehicle
 *   三种视角消费者验证），39项测试全部通过。
 *   决定不另开 00_ADR_005（Foundation Module Rules）——一是这条建议里
 *   把 22_QueryEngine.gs 归为 Foundation 层是事实错误（实际是 Runtime/
 *   Query，而且它本来就会读 Sheet，跟"禁止碰 Sheet"直接冲突）；二是
 *   目前只有 Temporal Engine 一个 Foundation 新模块，"所有 Foundation
 *   模块都要遵守"这句话现在只有一个真实案例支撑，属于 Progression Rule
 *   要避免的"为还不存在的未来模块预先定规则"，理由见 ADR-004。
 *
 * - 2026-07-06：修复第二轮外部审计对 25_ReminderEngine.gs/20_EventBus.gs/
 *   21_SheetUtils.gs 的发现（HIGH/MEDIUM/LOW 各两条），完整依据见
 *   00_ADR_002_ReminderEngine_Audit_Fixes.gs 的「第二轮外部审计」章节：
 *   · HIGH RISK 1（新）：checkReminders 的批量写延后到循环结束，如果
 *     执行因超时被打断，批量写永远不会执行——这是上一轮 HIGH RISK 1
 *     修复本身带来的新风险。加了时间预算机制，接近6分钟上限就提前
 *     中断循环，但中断前已处理的任务仍然保证批量写入。
 *   · HIGH RISK 2（新）：_sendReminder 之前丢弃了 Output.sendMessage
 *     的返回值，发送失败时依然照常更新提醒状态，造成静默丢失。改成
 *     只有确认发送成功才更新状态。
 *   ⚠️【意外发现，不在审计报告里，写回归测试时自己测出来的、影响比
 *   这轮任何一条审计发现都大】_recordReminderSent 从最早的版本开始就
 *   只更新了 reminder_count，从来没有设置过 last_reminder_at——导致
 *   REMINDER_INTERVAL_HOURS 按优先级分级的提醒间隔（4/6/12/24小时）
 *   实际上从来没有生效过，所有任务只要满足提醒条件，每小时触发器跑
 *   一次就会重发一次。已修复，并新增"连续跑两次checkReminders，第二次
 *   不应该重发"的回归测试验证。
 *   · LOW RISK 1（新）：21_SheetUtils.gs 包进 IIFE（是最后一个还没
 *     IIFE 化的"引擎风格"文件），22_QueryEngine.gs/25_ReminderEngine.gs
 *     的调用方式同步改成 SheetUtils.xxx 命名空间形式。
 *   MEDIUM RISK 1（新）、MEDIUM RISK 2（新）、LOW RISK 2（新）核实
 *   属实但决定不修，理由见「已知问题」。
 *   新写 5 组端到端测试（发送失败/发送成功/时间预算耗尽/部分处理后
 *   耗尽预算仍保证已处理部分落盘/单任务异常不拖累整批），加上
 *   "连续两次执行"的回归测试，第一轮遗留的全部测试（8个原始场景+
 *   TemporalEngine 39个+EventBus缓存验证）一并重跑确认无回归。
 *
 * - 2026-07-06：修复第三轮外部审计发现，完整依据见
 *   00_ADR_002_ReminderEngine_Audit_Fixes.gs 的「第三轮外部审计」章节：
 *   · HIGH RISK 1（新）：批量写本身如果失败（网络异常/Sheets服务不可用/
 *     配额超限），第二轮"循环结束后写一次"的做法会导致整批状态丢失。
 *     改成分批写（每20个已发送任务写一次），单批失败重试一次，不让
 *     异常拖累其他批次。
 *   · MEDIUM（新）：lock 竞争会让提醒延迟一整小时。改成拿不到锁时安排
 *     一次性5分钟后重试，用 Script Property 防止重复排队。
 *   · LOW（新）：_cleanTitle_ 的正则拆成两次独立 replace，消除审计指出
 *     的（其实影响很小的）回溯疑虑，改动几乎零成本。
 *   核实后发现两条审计描述跟实际代码不符，没有改动：11_Setup.gs 的
 *   JSON.parse 其实一直有 try/catch 包着（实测模拟非JSON响应，
 *   runDiagnostics 正确捕获并继续执行）；40_Output.gs 建议加的
 *   UrlFetchApp "deadline" 参数经查证根本不存在（查了 Google 官方
 *   issue tracker #36761852，这是个长期未实现的功能请求，UrlFetchApp
 *   实际有约60秒不可配置的内建超时）。HIGH RISK 2（新，QueryEngine
 *   读整张表的性能问题）核实属实但不修——正确的修法（归档）会让
 *   Reminder OS 越界碰 Productivity OS 拥有的 Tasks/ArchiveTasks 表，
 *   违反 Constitution P3。
 *   新写4组测试（分批写验证、批量写失败重试验证、lock重试排队去重
 *   验证、正则拆分验证），第二轮遗留的5组测试补上新增的
 *   PropertiesService/ScriptApp mock 后重新跑通，确认无回归。
 *
 * - 2026-07-10：修复第四轮外部审计发现，完整依据见
 *   00_ADR_002_ReminderEngine_Audit_Fixes.gs 的「第四轮外部审计」章节：
 *   · HIGH RISK 1（新）：checkReminders 循环里每发送成功一条提醒就立刻
 *     调 EventBus.publish（同步单行 appendRow）写 Events 表——Tasks 表
 *     那条线第一轮就批量化了，Events 这条线一直没跟上，是本该一起做
 *     但当时没做的遗漏。新增 EventBus.publishBatch，改成跟 Tasks 批量写
 *     用同一套分批节奏。
 *   · HIGH RISK 2（新）：_scheduleRetryOnce 建的一次性重试 trigger，
 *     执行完不会自动从 ScriptApp.getProjectTriggers() 消失，需要显式
 *     删除，否则持续累积会逼近单项目最多20个已安装 trigger 的硬配额。
 *     新增 _cleanupStaleRetryTrigger_，在 checkReminders 最开头无条件
 *     调用，删掉上一次留下的 trigger；11_Setup.gs 的 runDiagnostics()
 *     同步新增 trigger 数量检查。
 *   · HIGH RISK 3（新）：EXECUTION_TIME_BUDGET_MS 的检查只发生在每次
 *     处理任务之前，UrlFetchApp.fetch 最坏情况单次卡住约60秒（第三轮已
 *     查证的 GAS 平台限制）不受这个检查约束，理论上可能让单次循环迭代
 *     自己就撞上6分钟硬上限。改成显式按"硬上限−最坏情况单任务耗时−
 *     安全垫"重新推导预算（不是简单改小数字），配合 MEDIUM RISK 1
 *     把持久化成本降下来后，同步把 BATCH_WRITE_CHUNK_SIZE 从20降到5，
 *     缩小"已发送但未持久化"的风险窗口。这个风险只能缓解、不能消除，
 *     GAS 平台本身不提供配置 UrlFetchApp 超时的手段。
 *   · MEDIUM RISK 1：_persistBatch 之前调用的 batchUpsertRowsByKey_
 *     每次都整表读+整表写，成本随 Tasks 表总行数增长——5批×100条更新
 *     会把整张表重复读写5次。21_SheetUtils.gs 新增
 *     batchUpdateFieldsByKey_，只读 key 列定位行号、只对实际改动的字段
 *     做单元格级定点写入，成本正比于本批大小，不再随表总行数增长。
 *   ⚠️ 这轮审计另外两条，核实属实但不适合/不需要代码修复：
 *   · MEDIUM RISK 2（_sendReminder 网络抖动导致偶发重复发送）：查证
 *     UrlFetchApp 没有任何手段区分"没发出去"和"发出去了但响应丢失"，
 *     Telegram Bot API 的 sendMessage 也不支持幂等键（官方 Bot API 的
 *     issue tracker 上这是一个至今没有实现的 open feature request）。
 *     两个平台都不提供解决这问题所需的手段，按审计建议本身的方向在
 *     业务层面接受，只在 40_Output.gs 加了 ambiguousDelivery 诊断标记，
 *     方便以后翻日志排查。见下面「已知问题」。
 *   · LOW RISK 1（00_Project_Constitution.gs 对 Tasks 表结构耦合，
 *     建议抽象层）：核实后发现不是新问题——Constitution P1 已经明确
 *     记录了不同的、经过深思的方案（新 Domain OS 接入时"加一段查询
 *     逻辑"，不是抽象一层通用接口），这次审计建议的做法方向相反。按
 *     Progression Rule 维持 P1 现状，见
 *     00_Project_Constitution.gs P1 的 2026-07-10 核实记录。
 *   4组新场景测试（Events批量写节奏、trigger清理+有限次数重试、时间
 *   预算提前中断、批量持久化只读写必要范围）+ notFound边界情况，加上
 *   8组回归测试（提前量判断/last_reminder_at落盘/发送失败不改状态/
 *   单任务异常隔离/OVERDUE间隔/简单锁重试链路/EventBus单条publish不受
 *   影响/_persistBatch失败重试）全部通过，确认无回归。
 *
 * - 2026-07-11：拿到 Productivity OS 代码，解决第三轮外部审计遗留的
 *   HIGH RISK 2（QueryEngine._readAllRows_ 读整张 Tasks 表历史行的性能
 *   问题），完整依据见 00_ADR_002_ReminderEngine_Audit_Fixes.gs「第三轮
 *   HIGH RISK 2 后续解决」：
 *   · 确认 ActiveTasks 由 Productivity OS 的 10_ProjectionEngine.gs 在
 *     每次 TASK_CREATED/UPDATED/COMPLETED/CANCELLED 时同步维护（不是
 *     定时批处理），永远只含当前非终态任务，体量只随"当前未完成任务数"
 *     增长，不随历史任务数增长。
 *   · 确认 ActiveTasks 不含 reminder_count 的实时数据（Productivity OS
 *     自己的投影逻辑明确跳过这一列），且
 *     26_AnalyticsEngine.gs 的"平均提醒次数"统计依赖 Tasks 全量任务
 *     （含已完成）的 reminder_count 历史值——这两点决定了 reminder_count/
 *     last_reminder_at 不能整体搬去 ActiveTasks，权威数据必须继续留在
 *     Tasks。
 *   · 21_SheetUtils.gs 新增 batchReadFieldsByKey_（只读 key 列定位行号、
 *     对给定的一批 key 定点读取指定字段，是 batchUpdateFieldsByKey_ 的
 *     读版本）；22_QueryEngine.gs 的 getPendingTasks() 改成两步：①从
 *     ActiveTasks 取候选任务列表（便宜，体量小）；②对候选列表的
 *     task_id，用 batchReadFieldsByKey_ 从 Tasks 定点取 reminder_count/
 *     last_reminder_at（不读 Tasks 其余列，也不碰候选列表之外的历史行）。
 *   · getCompletedTasks()/getTaskById() 没有跟着改——本项目目前没有
 *     调用方，继续读全量 Tasks，理由见 22_QueryEngine.gs 文件头。
 *   · 00_Project_Constitution.gs P3 正式修订（不是补充）："只读 Tasks...
 *     不碰 ActiveTasks/ArchiveTasks"这句原文已经不准确，改成"读
 *     ActiveTasks 取候选 + 对 Tasks 定点查两个字段"，写边界不变。
 *   · 过程中发现两个跟本次修复相关、但不在本次修复范围内的情况，记在
 *     下面「已知问题」：Productivity OS 的 15_Setup.gs schema 定义里
 *     Tasks/ActiveTasks 都没有 last_reminder_at 这一列，但
 *     11_ProjectionRebuilder.gs 却在处理这一列；TaskStatistics.
 *     reminder_count_total 这个统计字段实际上不会被本项目发送的
 *     REMINDER_SENT 事件更新到。
 *   3组新场景测试（大表下验证不整表读、ActiveTasks/Tasks 数据不一致时
 *   优雅降级、端到端流程验证 reminder_count 正确写回 Tasks 而不是
 *   ActiveTasks）+ 1组新回归测试（ActiveTasks 不存在时优雅降级不崩溃），
 *   加上前四轮遗留的全部测试（第四轮换用 Productivity OS 真实 schema
 *   重新构造夹具后）一并重跑，全部通过，确认无回归。
 *
 * - 2026-07-15：修复第五轮外部审计发现（HIGH RISK 1-4、MEDIUM RISK 1）+
 *   同日 GAS Console 实测的3个问题，完整依据见
 *   00_ADR_002_ReminderEngine_Audit_Fixes.gs 的「第五轮外部审计」章节：
 *   · HIGH RISK 1：26_ReminderOffsetEngine.gs 的幂等判断改成比对到期
 *     时间快照而非 fireAt 大小，修复"到期时间改早会被误判成已处理"的
 *     bug。
 *   · HIGH RISK 2：20_EventBus.gs 的 publishBatch 从
 *     getLastRow()+setValues() 改成逐行 appendRow()（GAS 保证原子），
 *     消除三个独立项目共享 Events 表时的静默覆盖风险。
 *   · HIGH RISK 3：21_SheetUtils.gs 的 batchReadFieldsByKey_ 从逐格
 *     getValue() 改成一次包络 getValues()+内存查找。
 *   · HIGH RISK 4：核实属实、无法从 Reminder OS 单个项目内解决，见下面
 *     「已知问题」新增条目，不假装已经修好。
 *   · MEDIUM RISK 1：26_ReminderOffsetEngine.gs 的 ruleDeletes 并入
 *     批量 flush 节奏，21_SheetUtils.gs 新增 batchDeleteRowsByKey_
 *     取代逐个 deleteRowByKey_；顺带发现并修复同一个函数里完全相同
 *     反模式的 occurrenceDeleteKeys（触发频率更高）。
 *   · LOW RISK 1：这条其实是 2026-07-12 TemporalEngine 架构评审
 *     Finding 3，当时 disposition 是 Fix Later，这次审计重新点名，
 *     予以采纳提升为 Fix Now——12_TemporalEngine.gs 的 parseRule 现在
 *     Object.freeze 返回的 schedule。完整提升理由见 00_ADR_004
 *     「2026-07-15 修订记录」。
 *   ⚠️ 同日另修复3个不在审计报告里、是部署后手动跑
 *   checkOffsetReminders/runReminderOffsetEngineTests/checkReminders
 *   三个入口从 Execution log 里发现的问题：
 *   · 21_SheetUtils.gs 的 parseDueDate_ 假设 raw 一定是字符串，遇到
 *     Sheets 日期格式单元格返回的原生 Date 对象会抛
 *     "TypeError: raw.match is not a function"——加了 Date 类型直接
 *     返回的分支。
 *   · 50_ReminderOffsetEngine_Tests.gs 的 resetAll 用了 Node 专属的
 *     global，直接贴进 GAS 编辑器跑会报 ReferenceError——这份套件设计
 *     上只能走 Node 沙盒，改成显式检测环境+给可操作的报错。
 *   · 40_Output.gs 的 sendMessage 在 Telegram 业务级失败时原样转发
 *     Telegram 的 error_code/description，没有补上其余分支都有的
 *     error 字段，导致两个引擎读 sendResult.error 永远是
 *     undefined——补上了这个字段，不删除原始字段。
 *   新增3份此前完全没有覆盖的测试文件（5_Testing/50_SheetUtils_Tests.gs/
 *   50_EventBus_Tests.gs/50_Output_Tests.gs，范围只覆盖这次改到的
 *   函数，各自文件头有说明），50_ReminderOffsetEngine_Tests.gs 新增
 *   场景F（到期时间改早的回归测试），50_TemporalEngine_Tests.gs 新增
 *   Object.freeze 验证。测试总数从71（TemporalEngine 43 + OffsetEngine
 *   28）增加到115，全部通过——4个 Node 沙盒套件可以用新增的
 *   run_all_tests.js 一次性跑完。顺手修复 run_offset_tests.js 里硬编码
 *   的上一次会话沙盒绝对路径，改成相对本文件目录动态拼接，否则换个
 *   环境就读不到文件。
 *   ⚠️ 已知文档缺口：00_File_Map.gs/00_Project_State.gs（本文件）在
 *   这轮之前就已经不包含 Offset Reminder Engine（第四轮之后新增，经过
 *   多轮设计精化）的完整设计历史，也不包含 2026-07-12 TemporalEngine
 *   架构评审本身的记录。这次只在 File Map 里补了最小占位记录，没有
 *   回填完整设计过程——需要单独排一次任务，重新过一遍设计文档和历次
 *   精化的完整上下文才能做，不是这次审计修复顺手能完成的。
 *
 * - 2026-07-17：支持 Productivity OS 新增的 Task.reminder_policy 字段
 *   （用户创建任务时可以直接覆盖默认提醒策略），完整跨项目架构审查+
 *   Carson 决策记录见 00_ADR_006_Reminder_Policy_Override.gs。
 *   26_ReminderOffsetEngine.gs 的 _ensureDefaultRules_ 改名
 *   _ensureRulesFromPolicy_ 并扩展：taskIdsWithRules 未命中时先读
 *   task.reminder_policy 决定生成默认规则还是用户覆盖的规则，为 null 时
 *   行为逐字节不变（旧名字保留 @deprecated wrapper）。stats 新增
 *   overrideRulesCreated 字段。落地时机是窄口径——只在首次物化那一刻生效，
 *   不引入持续 Rebuild（Carson 决定，理由是保持职责边界和现有引擎的成本
 *   模型，不是单纯省扫描次数）。"不要提前提醒"（reminder_policy.offsets=[]）
 *   不影响 25_ReminderEngine.gs（V1）的到期提醒，两者继续完全独立。
 *   50_ReminderOffsetEngine_Tests.gs 新增场景 G/H/I + _offsetToMinutes_
 *   的纯函数测试。本次改动完全不涉及 Personal AI Core、Connector Layer、
 *   12_TemporalEngine.gs、22_QueryEngine.gs。
 *
 * - 2026-07-19：Unified Reminder Engine——上一条实测发现 V1（按到期临近
 *   度持续提醒）和 V2（reminder_policy 驱动的一次性提前提醒）互相独立，
 *   显式覆盖了 reminder_policy 的任务仍然会收到 V1 的独立提醒。完整两轮
 *   架构评审见 Reminder-Engine-Consolidation_Architecture-Review.md +
 *   Unified-Reminder-Engine_Architecture-Review.md，正式决策记录见
 *   00_ADR_007_Unified_Reminder_Engine.gs，Carson 2026-07-19 批准后实现。
 *
 *   26_ReminderOffsetEngine.gs 改名 20_ReminderEngine.gs（内部模块变量
 *   ReminderOffsetEngine 同步改名 ReminderEngine，trigger 绑定的全局
 *   函数名 checkOffsetReminders 保留不改，降低连带范围）。DEFAULT_
 *   REMINDER_OFFSETS_MINUTES（不分优先级的扁平数组）改成按 priority
 *   分组的 DEFAULT_REMINDER_POLICY_CONFIG。新增 OVERDUE_POLICY_CONFIG
 *   （interval_minutes/enabled/max_repeats，按 priority 分组，数值沿用
 *   V1 REMINDER_INTERVAL_HOURS 已验证过的 4h/6h/12h/24h 分级）。新增
 *   Overdue 阶段（_processOverdueStage_），状态复用 task.reminder_count/
 *   last_reminder_at（V1 时代就在用的字段，无需数据迁移），写入机制沿用
 *   V1 的 SheetUtils.batchUpdateFieldsByKey_('Tasks', ...)。两个阶段共用
 *   同一把锁、同一次 checkOffsetReminders() 轮询、同一个每5分钟触发器。
 *   两处 Carson refinement 顺带落地：QUIET_HOURS_START_HOUR/END_HOUR 两个
 *   裸变量重构成 QUIET_HOURS_CONFIG 对象（Overdue 阶段接入同一套既有
 *   Quiet Hours 判断，不是重新做一套）；ReminderHistory 新增
 *   stage/policy_source 两列（11_Setup.gs 新增
 *   migrateSchemaReminderHistoryStages() 迁移函数）。
 *
 *   11_Setup.gs 的 createTriggers() 不再挂 checkReminders（V1 的每小时
 *   触发器）——25_ReminderEngine.gs 文件本身没删，按迁移计划先观察
 *   Overdue 阶段实际表现，确认无误后再手动删除文件，不是这次实现的一
 *   部分。00_Project_Constitution.gs 的 P2（触发器描述）/P3（写入方
 *   变更说明）/P4（REMINDER_INTERVAL_HOURS 数值去向）同步修订。
 *
 *   50_ReminderOffsetEngine_Tests.gs 改名 50_ReminderEngine_Tests.gs
 *   （run_offset_tests.js 改名 run_reminder_tests.js），新增场景
 *   A2（priority缺失落到MEDIUM）/J（Overdue基础发送）/K（间隔未到不重发）
 *   /L（enabled=false不发送）/M（max_repeats到上限不发送）/N（Overdue
 *   遇到Quiet Hours不发送），全部71项测试通过（真实执行，非仅语法检查）。
 *
 *   顺手发现两个建议清理、但不在本次改动范围内的死代码文件：
 *   92_ReminderEngine.gs（2026-07-03 拆分前的原始文件，定义裸全局函数，
 *   理论上可能跟 25_ReminderEngine.gs 同名函数冲突）、05_SheetUtils.gs
 *   （疑似被 21_SheetUtils.gs 取代后遗留）。
 *
 * - 2026-07-21（hotfix，Carson 发现并修复）：上线后
 *   checkOffsetReminders 触发器报错 TypeError:
 *   ReminderEngine.checkOffsetReminders is not a function——
 *   20_ReminderEngine.gs 和 25_ReminderEngine.gs 都声明了全局的
 *   var ReminderEngine，后加载的 25_ReminderEngine.gs 覆盖了前者的绑定。
 *   这正是上面那条"92_ReminderEngine.gs 可能同名冲突"提醒本该覆盖、却
 *   没有实际检查到的同一类风险，只是撞在了 25_/20_ 这一对文件上，不是
 *   92_。修复：25_ReminderEngine.gs（迁移观察期内的临时保留项）内部变量
 *   改名 ReminderEngineV1，20_ReminderEngine.gs 不用改。完整记录见
 *   00_ADR_007_Unified_Reminder_Engine.gs 的"2026-07-21 Hotfix"章节。
 */

// ============================================================
// 二、进行中
// ============================================================

/**
 * （暂无）
 */

// ============================================================
// 三、已知问题
// ============================================================

/**
 * - 【持续存在，不是能单边修掉的 bug】MEDIUM RISK 1：Done/Snooze 按钮的
 *   callback_data 处理依赖 Personal AI Core 项目注册了 Telegram webhook、
 *   且用同一个 TELEGRAM_TOKEN 正确解析 task_done:/task_snooze: 协议。
 *   这次只做了文档约束（00_Project_Constitution.gs P6）和 webhook 注册
 *   状态的诊断（runDiagnostics()），但没法从 Reminder OS 这边验证 Core
 *   项目是否真的正确处理了这两种 callback_data——如果两边协议后续单方面
 *   改动，这里不会有任何自动报错，只能靠人工核对两边代码。
 *
 * - "接V3改EventBus.publish"这条旧 TODO：这次核实，代码（现
 *   2_Runtime/25_ReminderEngine.gs 的 _recordReminderSent，2026-07-06
 *   从 _updateReminderCount 改名，见 ADR-002）确实已经在调
 *   EventBus.publish('REMINDER_SENT', ...)。跟这条笔记本身的猜测一致——
 *   大概率是旧记录跟代码脱节（drift），不是真的还有未解决的部分。
 *   具体原意我这边没法进一步确认，如果 Carson 记得当时想解决的是什么、
 *   现在代码没覆盖到，可以更新/删掉这一条；不然可以考虑直接清掉。
 *
 * - 【第二轮审计核实属实、决定不修，理由见 ADR-002「第二轮外部审计」】
 *   · MEDIUM RISK 1：EventBus 内存级去重在并发实例下确实会失效，但
 *     Reminder OS 自己不接 webhook、checkReminders 自身已被锁保护，
 *     这个具体并发场景在本项目不成立。对 Personal AI Core 那份副本
 *     可能更相关，但那个项目的代码看不到。
 *   · MEDIUM RISK 2：单一共享 Spreadsheet 的容量/隔离顾虑技术上成立，
 *     但这是 Constitution P1/P2 既有的架构决定，不是疏漏。改成多
 *     Spreadsheet 动态解析是影响全平台的架构变动，需要跨项目评估，
 *     不是能在 Reminder OS 一个项目里单方面改的。
 *   · LOW RISK 2：单聊限流对多用户的非必要阻塞，技术上成立，但
 *     Reminder OS 目前只服务单一 chat_id，没有"User B"可以被阻塞，
 *     实现差分限流是对不存在场景的过度设计。真的服务多用户时再做。
 *
 * - 【第三轮审计核实属实、决定不修，理由见 ADR-002「第三轮外部审计」】
 *   · HIGH RISK 2：QueryEngine._readAllRows_ 每次都读 Tasks 表全部
 *     历史行，表越大越慢，这个顾虑是真的。但"归档"这个正确修法需要
 *     移动/删除 Tasks 表里的行，会直接越界碰 Productivity OS 拥有的
 *     数据（Constitution P3 明确说 Reminder OS 不碰 ActiveTasks/
 *     ArchiveTasks）。21_SheetUtils.gs 里提到的 ActiveTasks 表如果真的
 *     由 Productivity OS 维护成"只放未完成任务"，未来切换成读那张表
 *     可能是更好的方向——但需要确认它现在是否真的在维护、字段是否
 *     兼容（尤其 reminder_count/last_reminder_at 这两个 Reminder OS
 *     自己写的字段要不要跟着换写入目标），这些都要看 Productivity OS
 *     的代码才能确认，这次没有拿到。如果 Carson 能提供 Productivity OS
 *     关于 ActiveTasks 的代码，我可以评估切换的可行性。
 *
 *     ✅ 2026-07-11 已解决：拿到 Productivity OS 代码，确认 ActiveTasks
 *     由 10_ProjectionEngine.gs 实时同步维护、真的只含非终态任务，已
 *     切换 getPendingTasks() 改用 ActiveTasks 取候选+对 Tasks 定点查
 *     reminder_count/last_reminder_at，见「已完成」和
 *     00_ADR_002_ReminderEngine_Audit_Fixes.txt「第三轮 HIGH RISK 2
 *     后续解决」。这一条从"已知问题"移除。
 *
 * - 【第四轮审计核实属实、决定不修/无法从代码层面消除，理由见
 *   ADR-002「第四轮外部审计」】
 *   · MEDIUM RISK 2：_sendReminder 发消息时，如果 Telegram 已经收到并
 *     处理（消息已送达），但返回响应的路上网络抖动/超时，UrlFetchApp
 *     会抛异常，本项目会把这次当发送失败处理，不更新提醒状态，下次
 *     触发器可能重复发送。已查证 UrlFetchApp 没有任何手段区分"没发出去"
 *     和"发出去了但响应丢失"，Telegram Bot API 的 sendMessage 也不支持
 *     幂等键/去重 token（这是官方 Bot API issue tracker 上一个至今没有
 *     实现的 open feature request）——两个平台都不提供解决这个问题
 *     所需的手段，不是本项目代码层面能修的问题。已经按审计建议本身的
 *     方向在业务层面接受这是"至少送达一次"语义下的偶发代价，
 *     40_Output.gs 的 catch 分支加了 ambiguousDelivery 标记，方便以后
 *     翻日志时把这种情况跟其他真实发送失败区分开，仅此而已。
 *
 * - 【2026-07-11 拿到 Productivity OS 代码后发现，不是 Reminder OS 自身
 *   的 bug，记录下来是因为跟本项目的正确性间接相关，值得 Carson 知道】
 *   · last_reminder_at 这一列不在 Productivity OS 的 15_Setup.gs 的
 *     schema 定义里（setupSheets()/repairSheetHeaders() 都没提到这一列，
 *     Tasks/ActiveTasks/ArchiveTasks 三张表都没有），但
 *     11_ProjectionRebuilder.gs 的 deriveFromEvent 处理 REMINDER_SENT
 *     事件时，确实会计算并预期写入这一列（stateMap[...].last_reminder_at
 *     = p.sent_at || event.timestamp）。这说明 Productivity OS 那边的
 *     "官方 schema 清单"和"实际被依赖的字段"之间存在一处没有互相同步的
 *     缺口——本项目从第一天起就假设 Tasks 表实际存在 last_reminder_at
 *     这一列（历次审计和测试都是这么假设的，也一直工作正常，没有出现过
 *     "写不进去"的迹象），但本项目自己的 11_Setup.gs 从未创建过这一列，
 *     Productivity OS 的 setupSheets() 官方清单里也没有——大概率是当初
 *     手动加的，具体是谁、什么时候加的，两边的代码历史都查不出来。这
 *     不是本项目能确认或修复的问题（本项目没有、也不应该有修改 Tasks
 *     表结构的权限），只是如实记录这处发现，供 Carson 判断要不要去
 *     Productivity OS 那边把 schema 清单补齐。
 *   · TaskStatistics.reminder_count_total 这个统计字段，设计意图是靠
 *     REMINDER_SENT 事件增量维护（10_ProjectionEngine.gs 明确有对应的
 *     dispatch 分支），但 Reminder OS 是完全独立的 GAS 项目，自己发布
 *     REMINDER_SENT 事件到共享 Events 表这个动作，不会触发 Productivity
 *     OS 自己的 EventBus.publish→ProjectionEngine.dispatch 链路（那条链路
 *     只在 Productivity OS 自己的执行上下文里同步触发，不会跨项目
 *     感知另一个项目写入共享 Sheet 的动作）。也就是说，除非
 *     Productivity OS 自己内部还有别的路径会调用这个 dispatch 分支，
 *     否则这个统计字段实际上不会被真实的提醒发送行为更新，可能从设计
 *     出来就没真正生效过。这也不是本项目能确认或修复的问题（不涉及
 *     Reminder OS 拥有的任何数据），只是如实记录。
 *
 * - 【第五轮审计核实属实、无法从 Reminder OS 单个项目内解决，理由见
 *   ADR-002「第五轮外部审计」HIGH RISK 4】
 *   · checkReminders（25_ReminderEngine.gs）/checkOffsetReminders
 *     （26_ReminderOffsetEngine.gs）都用 LockService.getScriptLock()
 *     提供互斥保障，但 Script Lock 只在当前脚本项目内部起作用，无法
 *     阻止 Personal AI Core（处理 Telegram 按钮回调）或 Productivity
 *     OS 在本项目执行期间并发写共享的 Tasks/ReminderRules/Events 等表。
 *     审计给的两条修法（跨项目共享锁定表 / 三个项目迁移成同一 Spreadsheet
 *     下的容器绑定脚本以用 LockService.getDocumentLock()）都需要
 *     Personal AI Core 和 Productivity OS 同步配合或迁移，不是能在
 *     Reminder OS 一个项目里单方面决定并且改掉的事，这次也看不到那两个
 *     项目的代码去确认可行性。现有的按需定点单元格写入
 *     （batchUpdateFieldsByKey_/batchReadFieldsByKey_ 只碰实际要改的
 *     字段，不整行/整表覆写，见 MEDIUM RISK 1「第四轮」）已经是在没有
 *     跨项目锁的前提下能做到的合理缓解。如果 Carson 想真正关掉这条风险，
 *     需要拉上 Personal AI Core / Productivity OS 一起定协议或评估迁移
 *     可行性，具体需要什么见「下一步」。
 *
 * - 【已知文档缺口，2026-07-15 修复第五轮审计时顺手发现，不是本次修复
 *   范围内的事】00_File_Map.gs 和本文件在第四轮（2026-07-10/11）之后、
 *   第五轮审计（2026-07-15）之前，都没有跟上项目的实际进展——期间新增
 *   了完整的 Offset Reminder Engine（2_Runtime/26_ReminderOffsetEngine.gs
 *   + 5_Testing/50_ReminderOffsetEngine_Tests.gs，经过多轮设计精化，
 *   引入了 Project Constitution P8/P9），也做过一次独立的 TemporalEngine
 *   UEF 架构评审（2026-07-12）。这次只在 File Map 里为 OffsetEngine
 *   相关文件补了最小占位记录，没有回填完整的设计历史。
 */

// ============================================================
// 四、下一步
// ============================================================

/**
 * 优先级 P2（这次改动留下的判断，建议过一遍）：
 *   1. REMINDER_ADVANCE_HOURS 默认给了 72 小时（3天），是 Claude 选的，
 *      不是从你的文档/代码反推出来的既定值——按你实际提醒习惯调整这个
 *      数字即可，不影响判断逻辑本身。
 *   2. 如果想要「CRITICAL 提前更久开始提醒、LOW 提前更短」这种按优先级
 *      分开的提前量（而不是现在的单一全局值），是个可以照
 *      REMINDER_INTERVAL_HOURS 结构做的小改动，这次按 bug 报告里描述的
 *      最小范围先没做（P6，不做额外扩展）。
 *   3. 这次 blueprint 重组里，21_SheetUtils.gs 和 25_ReminderEngine.gs
 *      都是横跨多个 blueprint 子分类、没有拆分成更小的文件——理由和具体
 *      考虑见 00_ADR_001_Domain_OS_Blueprint_Adoption.gs，如果你希望拆得
 *      更细，可以再单独排。（25_ReminderEngine.gs 内部现在包进了 IIFE，
 *      物理文件数没变，见 00_ADR_002_ReminderEngine_Audit_Fixes.gs）
 *   4. Domain OS Blueprint 是跨项目的平台级约定，权威定义按惯例应该也记
 *      一份在 Personal AI Core 的 00_Project_Constitution.gs——这次没有
 *      该项目的文件，只更新了 Reminder OS 自己这份，需要的话把 Core 项目
 *      文件也发我，我再同步过去。
 *   5. 如果想彻底关掉 MEDIUM RISK 1（而不是只做文档约束+诊断），需要把
 *      Personal AI Core 项目里处理 task_done:/task_snooze: 这两种
 *      callback_data 的代码也发我核对，确认协议双方真的对齐——单看
 *      Reminder OS 这边的代码没法验证这件事。
 *   6. 1_Foundation/12_TemporalEngine.gs 现在没有任何调用方，是刻意的
 *      （见 00_ADR_003 Progression Rule），不是漏接。真的需要"每周一
 *      提醒我"这类 recurring 提醒时，下一步是 Phase B（Reminder
 *      Scheduler）——但要等到那时候再单独设计，不是现在顺手就接上。
 *   7. 第四轮新增两个数值，都是 Claude 按推导/折中选的，不是从你的
 *      文档/代码反推出来的既定值，按实际观察到的运行情况调整即可，不
 *      影响判断逻辑本身：
 *      - BATCH_WRITE_CHUNK_SIZE=5（原20）：折中——明显收窄"已发送但未
 *        持久化"的风险窗口，同时没让持久化调用次数增长到跟发送条数
 *        一样多。如果实际提醒条数一直很大（比如经常一次触发要发几十上
 *        百条），可以适当调大；如果几乎不会同时有超过5条待发，也可以
 *        调小甚至改成每发一条就持久化一次。
 *      - MAX_RETRY_ATTEMPTS=2（原隐含1）：折中——覆盖"两次都刚好撞上
 *        锁竞争"这种更极端场景，但仍然是有限次数，没有做成无限重试。
 *        如果实际观察到 checkReminders 经常需要跑很久（导致连续几次
 *        重试都撞上），可以考虑调大，但要注意这不是免费的——重试次数
 *        越多，锁竞争没解决时的总占用时间越长。
 *
 * 优先级 P3（架构演进）：
 *   8. 接入其他 Domain OS 的提醒需求时（比如 Property OS 的房租到期），
 *      在 checkReminders() 里加一段查询对应共享表的逻辑，参照现在查
 *      Tasks 表的写法。不需要新建 Bridge/Library 依赖。
 *   9. 如果想真正关掉 HIGH RISK 4（跨项目 LockService 不生效，见「已知
 *      问题」），需要 Personal AI Core / Productivity OS 的代码或至少
 *      配合——要么三个项目一起实现并遵守同一套共享锁定表协议，要么评估
 *      三个项目迁移成同一 Spreadsheet 下容器绑定脚本的可行性（影响面
 *      更大，涉及三个项目各自的部署方式）。跟 MEDIUM RISK 1（第一轮，
 *      webhook 依赖）性质相同：单看 Reminder OS 这边的代码没法验证或
 *      推进这件事。
 *   10. 00_File_Map.gs/本文件目前只用最小占位记录带过了 Offset Reminder
 *      Engine（2_Runtime/26_ReminderOffsetEngine.gs）的完整设计历史和
 *      2026-07-12 TemporalEngine 架构评审——如果想让这两份治理文档重新
 *      完整覆盖项目实际状态，需要单独排一次任务，把设计文档
 *      （Reminder-OS_Time-Based-Reminder-Engine_Design-Proposal.md）和
 *      历次精化的完整过程重新过一遍再写，不是顺手能做的事。
 */

// ============================================================
// 五、长期方向（讨论中，非既定计划）
// ============================================================

/**
 * Current: V1（单一 ReminderEngine，只认 due_date + priority 这一种规则
 *          形状，2026-07-06 完成 HIGH/MEDIUM/LOW 六项审计修复后的版本）
 *          + Phase A（Temporal Engine，通用日期规则计算，1_Foundation/
 *          12_TemporalEngine.gs，已实现，39项测试全部通过）——但 Phase A
 *          目前【没有任何东西在调用它】，V1 的实际提醒逻辑
 *          （25_ReminderEngine.gs）完全没有改动，跟 Temporal Engine
 *          还没有任何连接。
 * Future:  Phase B（Reminder Scheduler）——把 Temporal Engine 接到
 *          Reminder OS 自己的 recurring 提醒场景，让"每周一提醒我"这类
 *          规则真正能用
 * Status:  Phase A = Done（Contract + 实现 + 测试）。Phase B = 未开始，
 *          按 Progression Rule，不因为 Phase A 做完就自动开始，需要先
 *          有实际需求驱动。Phase B 有 3 个 Open Questions 已经记录（规则
 *          存哪、怎么接 checkReminders、missed occurrence 怎么恢复），
 *          刻意先不回答，见 00_ADR_003_Reminder_OS_V2_Vision_Evaluation.gs
 *          Phase B 条目——下次要写 Phase B 设计前必须先回来过一遍这三个
 *          问题，用 Phase A 的实际使用经验回答，不是现在凭空猜。
 *
 * 完整构想、评估、Phase A→F 路线图、Progression Rule、Exit Criteria，
 * 见 00_ADR_003_Reminder_OS_V2_Vision_Evaluation.gs；Phase A 的具体
 * Contract，见 00_ADR_004_Temporal_Engine_Design.gs。不在这里重复列出。
 * 这一节只保证一件事：Current 里写了什么，就真的有对应的 .gs 文件和
 * 测试；没写的（Phase B 及之后），就真的还没有一行代码。
 */
