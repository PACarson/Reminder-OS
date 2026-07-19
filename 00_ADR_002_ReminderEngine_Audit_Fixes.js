/**
 * 00_ADR_002_ReminderEngine_Audit_Fixes.gs
 * Reminder OS — 架构决策记录 #002
 *
 * STATUS: Accepted
 * DATE: 2026-07-06（第一轮），后续追加审计/后续解决的核实+修复过程
 * 直接续在同一份 ADR 里（第二轮/第三轮同为 2026-07-06，第四轮
 * 2026-07-10，第三轮 HIGH RISK 2 后续解决 2026-07-11，第五轮
 * 2026-07-15）——都是同一份审计对象（ReminderEngine 及其直接依赖，
 * 第五轮起自然延伸到同一脉络的 ReminderOffsetEngine）的持续复审/延续
 * 解决，不是独立决策，没有必要拆成 ADR-002a/002b/002c/002d/002e/002f
 * 各自维护。
 */

/**
 * === 背景 ===
 *
 * Carson 提供了一份针对 2_Runtime/25_ReminderEngine.gs、2_Runtime/
 * 20_EventBus.gs 的外部审计报告（审计对象是 2026-07-06 早些时候按
 * Domain OS Blueprint 重组之后的代码），按严重程度分 HIGH/MEDIUM/LOW
 * 各两条，要求按严重程度顺序全部修复。
 *
 * === 决策：逐条核实 + 修复 ===
 *
 * HIGH RISK 1（checkReminders 循环内 O(N) 次全表扫描式 Sheet I/O）
 *   核实：属实。upsertRowByKey_ 每次调用都会 getLastRow +
 *   getRange(...).getValues() 扫一遍 key 列找行号，checkReminders 循环
 *   里每提醒一个任务就调一次，N 个任务 = N 次这样的扫描+写入。
 *   修复：循环内只更新内存对象、收集进 updatedTasks 数组，循环结束后
 *   调一次 batchUpsertRowsByKey_('Tasks','task_id',updatedTasks)。这个
 *   批量函数 21_SheetUtils.gs 里已经有（2026-06-29 为 ProjectionRebuilder
 *   的全量重建场景加的），直接复用，没有重新实现一份类似逻辑（避免 C5）。
 *   _updateReminderCount 改名 _recordReminderSent，职责收窄为"发布事件+
 *   更新内存计数"，不再直接碰 Sheet。
 *
 * HIGH RISK 2（Telegram 限流）
 *   核实：查了 Telegram 官方 Bots FAQ（core.telegram.org/bots/faq）确认：
 *   单个 chat 里发消息建议不超过每秒1条（短时间可以超一点，但持续超会
 *   收到429）；单个群组每分钟不超过20条；跨不同chat的批量通知全局大约
 *   每秒30条上限。本项目的提醒消息几乎都发到同一个 chat_id（Steven 自己
 *   的 Telegram），所以真正卡脖子的是"单聊每秒1条"这条线，不是全局
 *   30条/秒那条。
 *   修复：_sendReminder 之后加 Utilities.sleep(1000)，固定1秒节流。
 *   没有做更复杂的 per-chat/全局分别限流（比如 token bucket），因为
 *   目前场景就是单一/极少数 chat_id，复杂方案在还没出现多用户场景之前
 *   属于过度设计（P6）。如果以后 Reminder OS 真的服务多个不同 chat_id
 *   的用户，这里需要重新设计成不阻塞彼此的独立节流，到时候再做。
 *
 * MEDIUM RISK 1（Done/Snooze 按钮依赖 Core 项目的 webhook）
 *   核实：属实，而且这个耦合是架构层面的，不是这个文件能单独"修掉"的
 *   bug——webhook 注册和 callback_data 解析都发生在 Personal AI Core
 *   项目，Reminder OS 这边看不到、也管不了那边的代码。
 *   处理方式（不是"修复"，是"文档化+可诊断化"）：
 *     1. 00_Project_Constitution.gs 新增 P6，把这个跨项目契约的具体格式
 *        （'task_done:{task_id}'/'task_snooze:{task_id}'）、依赖关系
 *        （同一个 TELEGRAM_TOKEN、Core 必须实现这两种前缀的解析）明确写
 *        下来，不再是"两边心照不宣"的隐性假设。
 *     2. 1_Foundation/11_Setup.gs 的 runDiagnostics() 新增调用 Telegram
 *        getWebhookInfo（查了 core.telegram.org/bots/api 确认这是官方
 *        无参数 GET 方法，返回 WebhookInfo 对象，url 为空代表当前没有
 *        注册 webhook、在用 getUpdates/长轮询），可以在部署时或怀疑按钮
 *        失灵时手动跑一次，看 webhook 是不是真的挂着。
 *     这两步只能验证"webhook 有没有注册"，验证不了"Core 项目是否正确
 *     解析了这两种 callback_data"——那需要看 Core 项目的代码，这次没有
 *     拿到，见 00_Project_State.gs「已知问题」和「下一步」。
 *
 * MEDIUM RISK 2（全局命名空间污染风险）
 *   核实：属实。25_ReminderEngine.gs 之前所有常量和函数都平铺在全局
 *   作用域，跟 22_QueryEngine.gs/40_Output.gs 的 IIFE 写法不一致。
 *   修复：包进 var ReminderEngine = (function(){...})() IIFE，只
 *   return { checkReminders: checkReminders }。
 *
 *   ⚠️ 对审计原始建议的修正：审计建议"仅将必要的入口函数（如
 *   checkReminders）暴露给全局"——如果照字面理解成"checkReminders 只作为
 *   ReminderEngine 返回对象的属性存在"，会直接破坏触发器。GAS 的
 *   ScriptApp.newTrigger('checkReminders') 是运行时按【字符串名字】在
 *   全局作用域找一个函数声明来绑定，不会去解析 ReminderEngine.
 *   checkReminders 这种路径——真这么做的话，1_Foundation/11_Setup.gs 的
 *   createTriggers() 建出来的触发器会在每小时触发时找不到对应函数直接
 *   报错，提醒系统会整个停摆。
 *   实际做法：IIFE 内部保留完整实现，IIFE 外面单独留一个同名全局薄封装
 *   `function checkReminders() { return ReminderEngine.checkReminders(); }`，
 *   只做转发，不含业务逻辑。这是"审计的方向对，但字面建议在 GAS 环境下
 *   有一个没考虑到的平台约束"的例子——采纳了修复意图，修正了具体做法。
 *
 * LOW RISK 1（lock.waitLock 超时太短）
 *   核实：属实，原来是 5000ms。
 *   修复：延长到 30000ms。额外考虑：HIGH RISK 2 加的节流会让单次
 *   checkReminders 的正常耗时变长（每条提醒多等1秒），5秒的锁等待在这个
 *   改动之后会更容易被触发误判，所以这次不只是简单调大数字，而是重新
 *   核对了新的预期耗时量级再定的 30 秒——仍然只占 GAS 6分钟执行上限的
 *   一小部分。
 *
 * LOW RISK 2（EventBus 重复 openById）
 *   核实：属实。_sheet_() 每次调用都重新走
 *   SecureConfig.getKey('SPREADSHEET_ID') + SpreadsheetApp.openById()。
 *   修复：闭包里加 _cachedSheet，命中就直接返回，不重新打开。GAS 的
 *   Sheet 对象是"引用"不是数据快照，缓存引用不会读到过期数据，只是省掉
 *   重复打开的开销；缓存的生命周期等于本次执行，不存在跨执行脏缓存。
 *
 * === 验证方式 ===
 *
 * 6 项改动都不是只凭代码审查判断"看起来对"，而是各自写了针对性的
 * mock GAS 环境脚本跑过：
 *   - ReminderEngine：mock QueryEngine/EventBus/Output/LockService/
 *     Utilities/batchUpsertRowsByKey_，验证 batchUpsertRowsByKey_ 恰好
 *     被调 1 次（不是 N 次）、Utilities.sleep 恰好按发送次数调用、IIFE
 *     封装后 _shouldRemind 等内部函数确认不再泄漏到全局、上一轮
 *     HIGH RISK 2（due_date 提前量）的判断逻辑在这轮改动后依然正确。
 *   - EventBus：mock SpreadsheetApp，验证连续 3 次 publish() +
 *     1 次 getAllEvents() 只触发 1 次 openById，且数据仍然正确写入
 *     （证明缓存的是"引用"，行为没变）。
 *   - Setup 的 webhook 诊断：mock UrlFetchApp 分别模拟"webhook 已注册"
 *     和"webhook 未注册（url 为空）"两种响应，确认两个分支的 Logger 输出
 *     都符合预期。
 *
 * === 后果 ===
 *
 * - 2_Runtime/25_ReminderEngine.gs：结构性改动最大，从平铺全局改成 IIFE
 *   模块 + 一个薄的全局触发器转发函数；checkReminders/_recordReminderSent
 *   内部逻辑改成批量+节流。对外行为（发消息内容、按钮、事件类型）不变。
 * - 2_Runtime/20_EventBus.gs：只加了一层缓存，公开 API 和行为不变。
 * - 1_Foundation/11_Setup.gs：runDiagnostics() 新增一段 webhook 检查，
 *   createTriggers() 未改动。
 * - 00_Project_Constitution.gs：新增 P6，修订 P3（写入机制描述更新为
 *   批量），修订 P5（去掉 Setup.gs 待确认的过时标注）。
 * - MEDIUM RISK 1 严格来说没有被"消除"，只是被"文档化+加了诊断"——这是
 *   本次 6 项里唯一一条本质上无法在 Reminder OS 单个项目内彻底解决的，
 *   如实记录在 00_Project_State.gs「已知问题」，不假装它已经修好了。
 *
 *
 * ══════════════════════════════════════════════════════════════
 * 第二轮外部审计（2026-07-06，针对第一轮修复之后的代码）
 * ══════════════════════════════════════════════════════════════
 *
 * 背景：第一轮的 HIGH RISK 1 修复（批量写替代逐任务写）本身又被第二轮
 * 审计发现了新问题——批量写延后到循环结束才做，如果循环本身因为超时被
 * 打断，批量写永远不会执行。这是"修一个问题、引入另一个问题"的典型
 * 案例，第二轮的核实过程本身也是对第一轮方案的检验。
 *
 * === 逐条核实 + 处理 ===
 *
 * HIGH RISK 1（新）：执行超时导致批量写永远不执行，造成重复推送
 *   核实：属实，而且是第一轮 HIGH RISK 1 修复本身带来的新风险，不是
 *   独立于第一轮的问题。GAS 6 分钟硬上限 + Utilities.sleep(1000) 节流
 *   累积耗时，待发送任务一多，撞超时的概率就会实际存在。
 *   修复：checkReminders 从 forEach 改成 for 循环，加入时间预算
 *   （EXECUTION_TIME_BUDGET_MS=5分钟，留1分钟安全余量），每次处理前
 *   检查已耗时，接近预算就 break——但 break 之后依然执行批量写入，
 *   已处理的部分保证落盘。剩余任务留给下一次触发器，这是安全的（它们
 *   本来就还没发送成功）。
 *
 * HIGH RISK 2（新）：Output.sendMessage 失败时状态被静默错误更新
 *   核实：属实。_sendReminder 之前完全丢弃了 Output.sendMessage 的
 *   返回值，导致发送失败（网络异常/Telegram拒绝/token或chat_id失效）时
 *   系统依然照常累加 reminder_count，造成静默丢失且不会重试。
 *   修复：_sendReminder 改为返回结果；checkReminders 只在
 *   sendResult.ok 为真时才调用 _recordReminderSent、才收进批量写入
 *   列表。
 *
 * 【意外发现，不在这轮审计报告里，是写回归测试时自己测出来的】
 * _recordReminderSent（原_updateReminderCount）从最早的版本开始就只
 * 更新了 reminder_count，从来没有设置过 task.last_reminder_at——而
 * _shouldRemind 判断"距上次提醒是否超过间隔小时数"完全依赖这个字段。
 * 字段永远是空的，意味着 REMINDER_INTERVAL_HOURS 那套按优先级分级的
 * 提醒间隔（4/6/12/24小时）实际上从来没有生效过，所有任务只要满足
 * 提醒条件，每小时触发器跑一次就会重发一次。已经在 25_ReminderEngine.gs
 * 补上赋值，并写了"连续跑两次 checkReminders，第二次不应该重发"的
 * 回归测试验证。这个发现比这轮审计报告里任何一条的实际影响都大，因为
 * 它意味着提醒频率控制这个核心功能从一开始就没真正工作过，只是恰好
 * 没被之前几轮审计和我自己第一轮的测试用例覆盖到（之前的测试都是直接
 * 手动设置 last_reminder_at 来测 _shouldRemind 的判断逻辑本身，没有
 * 端到端验证过"发送成功之后这个字段真的会被写回 Sheet"这一步）。
 *
 * MEDIUM RISK 1（新）：EventBus 内存级去重在并发实例下失效
 *   核实：技术判断本身正确——_inExecIdentityCache_ 确实是单次执行的
 *   内存缓存，并发实例之间不共享，这个描述没有问题。
 *   但核实这个风险在 Reminder OS 这个项目里是否真的可能发生：
 *   Reminder OS 自己"不接 Telegram webhook"（Constitution P2），审计
 *   描述的"用户连续快速双击 Done/Snooze 按钮导致并发 webhook 回调"这个
 *   场景，处理 webhook 的是另一个项目（Personal AI Core），不是这里。
 *   Reminder OS 自己唯一会调 EventBus.publish 的地方是 checkReminders
 *   内部，而 checkReminders 本身已经被 LockService 互斥锁保护（不会
 *   有两个 checkReminders 并发跑），所以这个具体的并发场景在 Reminder
 *   OS 这份代码里目前不成立。
 *   决定不在这里实现建议的 CacheService+分布式锁方案——这是为一个当前
 *   不存在的执行路径加复杂度，违反 P6。这个发现对"如果 Personal AI
 *   Core 那份 EventBus.gs 副本也有类似的并发 publish 场景"更有意义，
 *   但那个项目的代码这次看不到，没法代为验证或修改。
 *
 * MEDIUM RISK 2（新）：单一共享 Spreadsheet 的容量/隔离风险
 *   核实：技术上是对的顾虑（Google Sheets 确实有单表容量上限），但
 *   "一张共享 Spreadsheet、每个 Domain OS 各自一个分页"不是疏漏，是
 *   00_Project_Constitution.gs P1/P2 在 2026-07-03 拆分时就明确写下的
 *   既有架构决定。改成"每个 Domain OS 各自的 Spreadsheet、动态解析
 *   ID"是一次影响整个 Personal AI 平台的架构级变动，会牵动这次看不到
 *   代码的 Personal AI Core、Productivity OS 等其他项目，不是能在
 *   Reminder OS 这一个项目里单方面决定并且改掉的事，需要跨项目评估。
 *   没有在这里改，见 00_Project_State.gs「已知问题」。
 *
 * LOW RISK 1（新）：SheetUtils 全局作用域暴露，跟已 IIFE 化的其他文件
 * 不一致
 *   核实：属实。21_SheetUtils.gs 是目前唯一还平铺在全局的"引擎风格"
 *   文件（22_QueryEngine.gs/40_Output.gs/20_EventBus.gs/
 *   25_ReminderEngine.gs 都已经是 IIFE 模块）。
 *   修复：包进 IIFE（SheetUtils 模块），对外暴露 SheetUtils.getSheet_
 *   等11个函数。跟 25_ReminderEngine.gs 的 MEDIUM RISK 2 修复不同的是，
 *   SheetUtils 的函数本来就是设计给其他文件跨文件调用的共用工具（不像
 *   ReminderEngine 的内部函数只在自己文件内用），所以这次 IIFE 化必须
 *   同步更新调用方——22_QueryEngine.gs（getSheet_/getHeaderMap_）和
 *   25_ReminderEngine.gs（isOverdue_/parseDueDate_/
 *   batchUpsertRowsByKey_）的裸调用全部改成 SheetUtils.xxx。函数内部
 *   互相调用（比如 upsertRowByKey_ 调 getSheet_）因为都在同一个 IIFE
 *   闭包里，不需要加前缀。
 *
 * LOW RISK 2（新）：单聊限流对多用户场景的非必要阻塞
 *   核实：技术上成立，但 Reminder OS 目前实际服务的是单一 chat_id
 *   （Steven 自己），"User A 的提醒阻塞 User B"这个场景现在没有 User B
 *   可以被阻塞。实现"按 chat_id 分组、只对同一 chat_id 连续发送才节流"
 *   需要额外的分组/排序逻辑，对当前不存在的场景做这个复杂度是过度设计
 *   （P6）。真的服务多个不同 chat_id 的用户时，这个优化才有实际意义，
 *   到时候再做，见 00_Project_State.gs「已知问题」。
 *
 * === 第二轮验证方式 ===
 *
 * 新写了 5 组针对性测试（mock 完整的 GAS 环境，加载真实的
 * 21_SheetUtils.gs/20_EventBus.gs/22_QueryEngine.gs/25_ReminderEngine.gs
 * 四个文件一起跑，不是孤立测试单个函数）：
 *   1. 发送失败不应更新任何状态（HIGH RISK 2）
 *   2. 发送成功应正常更新状态（回归检查，顺带测出 last_reminder_at
 *      从未被写入的问题）
 *   3. 模拟时间预算耗尽，验证提前中断 + timeBudgetExceeded 标记正确
 *      （HIGH RISK 1）
 *   4. 模拟部分处理后才耗尽预算，验证已处理部分确实被批量写入、没有
 *      因为提前中断丢失状态（HIGH RISK 1 的关键场景）
 *   5. 模拟单个任务处理时抛异常，验证不影响其他任务的处理和落盘
 *   另外补了一个"连续跑两次 checkReminders"的场景，验证 last_reminder_at
 *   修复后，第二次紧接着跑不会重复发送同一批提醒——这是直接证明
 *   "提醒频率控制现在真的生效了"的测试，不只是证明"字段有被赋值"。
 *   全部连同第一轮遗留的测试（8个原始场景 + TemporalEngine的39个 +
 *   EventBus缓存的验证）一起重跑，确认没有引入回归。
 *
 * === 第二轮后果 ===
 *
 * - 2_Runtime/25_ReminderEngine.gs：checkReminders 循环重构（forEach→
 *   for + 时间预算 + 发送结果校验 + 单任务try/catch），
 *   _recordReminderSent 补上 last_reminder_at 赋值，SheetUtils 调用
 *   全部改命名空间形式。
 * - 2_Runtime/21_SheetUtils.gs：包进 IIFE，是这几个"引擎风格"文件里
 *   最后一个完成这项改造的。
 * - 2_Runtime/22_QueryEngine.gs：调用方式同步更新，逻辑本身未变。
 * - MEDIUM RISK 1（新）、MEDIUM RISK 2（新）、LOW RISK 2（新）三条
 *   均核实属实但决定不在这里修，理由分别是"当前架构下这条路径不成立"、
 *   "需要跨项目决定，不是单项目能改的"、"当前没有对应场景，做了就是过度
 *   设计"——不是忽略，是判断过后的决定，完整理由见上。
 *
 *
 * ══════════════════════════════════════════════════════════════
 * 第三轮外部审计（2026-07-06，针对第二轮修复之后的代码）
 * ══════════════════════════════════════════════════════════════
 *
 * === 逐条核实 + 处理 ===
 *
 * HIGH RISK 1（新）：批量写本身失败会导致整批状态丢失
 *   核实：属实。第二轮把批量写挪到循环结束才做一次，但没有考虑
 *   batchUpsertRowsByKey_ 这次调用本身失败的情况（网络异常/Sheets服务
 *   暂时不可用/配额超限）——万一真的失败，这一整次执行期间已经发出去的
 *   全部提醒都不会落盘，下次触发器整批重发。
 *   修复：改成分批写（_persistBatch/BATCH_WRITE_CHUNK_SIZE=20），每凑够
 *   20个已发送的任务就写一次，不再等到循环整个结束。每批写入失败会重试
 *   一次（等5秒），重试仍失败则把受影响的 task_id 记录进日志、不让异常
 *   继续往上抛——一批写失败不该拖累循环里还没处理的后续任务。这把"单点
 *   写入失败"的影响范围从"整次执行的全部任务"缩小到"最多这一批（20个）"。
 *
 * HIGH RISK 2（新）：QueryEngine._readAllRows_ 读整张表，O(N)性能瓶颈
 *   核实：技术上属实——_readAllRows_ 确实每次都读 Tasks 表从第2行到
 *   最后一行的全部数据，包括早已完成/取消的历史任务，表越大读得越慢。
 *   没有修：审计建议的修复方式（"引入定期自动归档机制，把非PENDING的
 *   历史任务物理移动到ArchiveTasks"）如果由 Reminder OS 来做，会直接
 *   违反 00_Project_Constitution.gs P3 明确写下的数据边界——"不碰 Tasks
 *   表的其他字段，不碰 ActiveTasks/ArchiveTasks"。Tasks 表的生命周期
 *   （包括要不要归档、什么时候归档）属于 Productivity OS 的地盘，不是
 *   Reminder OS 能单方面伸手去做的事。
 *   21_SheetUtils.gs 的历史注释提到过 ActiveTasks 是"只放未完成任务"的
 *   工作台表——如果这张表已经由 Productivity OS 维护、且字段跟 Tasks
 *   兼容，Reminder OS 改成读 ActiveTasks 而不是 Tasks，理论上能绕开这个
 *   性能问题而不需要自己做归档。但这需要确认 ActiveTasks 现在是不是真的
 *   在维护、字段是否兼容（尤其是 reminder_count/last_reminder_at 这两个
 *   Reminder OS 自己写的字段，如果切换读源，写入目标要不要也跟着换，
 *   两边会不会不同步）——这些都需要看 Productivity OS 的代码才能确认，
 *   这次没有，没法代为决定，见 00_Project_State.gs「已知问题」。
 *
 * MEDIUM RISK（新，第三轮编号从这里重新数）：lock 竞争导致提醒延迟一小时
 *   核实：属实。lock.waitLock(30000) 只等30秒，如果前一次执行因为待发送
 *   任务多、跑了三四分钟，下一个整点触发器等30秒后直接放弃整次执行，
 *   该发的提醒会晚整整一小时才有机会重新判断。
 *   修复：拿不到锁时安排一次性的5分钟后延迟重试（_scheduleRetryOnce），
 *   不再干等下一个整点。用 Script Property（REMINDER_ENGINE_RETRY_
 *   PENDING）防止同一时间段内重复排队多个重试——已经有一个在等待中就
 *   不再新增。只重试一次，不做无限链式重试：重试也失败的话，就正常等
 *   下一个整点触发器，不再继续加码，避免前一个实例卡住很久时，多个后续
 *   触发器各自挂重试、叠加出一堆重复尝试。
 *
 * MEDIUM RISK（新）：11_Setup.gs 的 JSON.parse 未捕获异常
 *   核实：【审计描述跟实际代码不符】webhook 诊断里的 JSON.parse 调用
 *   本来就在 try 块内，外面有 catch(e) 兜底——用模拟"Telegram/网络返回
 *   非JSON内容（比如Cloudflare 502的HTML错误页）"的场景实测过，
 *   runDiagnostics() 正确捕获了 SyntaxError、记录成
 *   "❌ getWebhookInfo 请求失败: ..."，并且正常继续往下跑完发送测试和
 *   QueryEngine 测试，不会因为这里的异常而整个中断。没有改动代码，这条
 *   发现不成立。
 *
 * LOW RISK（新）：40_Output.gs 的 UrlFetchApp.fetch 缺少 deadline 超时参数
 *   核实：【审计建议的具体修复方式不成立】查了 Google 官方 issue
 *   tracker（Issue 36761852，"Extend or allow configurable timeout for
 *   UrlFetchApp.fetch"）和第三方技术文档确认：UrlFetchApp 目前【没有】
 *   deadline 这个参数，网上偶尔提到的 fetchTimeoutSeconds 也被明确记录
 *   为"论坛里的以讹传讹或者已废弃的东西"，实际不生效——上面那条
 *   issue 本身就是一个长期未解决的"希望官方支持可配置超时"的功能请求，
 *   不是已经存在的功能。UrlFetchApp 实际有一个约60秒的硬编码超时（不可
 *   配置，官方也没有正式文档，但行为上限就是这样），不会真的无限期挂起。
 *   如果照审计的建议加一个 deadline 参数，这个参数会被静默忽略，什么都
 *   不会发生，反而制造"已经加了超时保护"的错觉。没有做这个改动。现有的
 *   HIGH RISK 1 时间预算机制（每处理一个任务前检查累计耗时）已经是这个
 *   问题在当前 GAS 平台限制下能做到的最佳缓解——单次 fetch 最坏卡60秒，
 *   累积几次之后时间预算检查会捕捉到并提前中断，不能做到更好（GAS 没有
 *   给这个更细粒度的控制手段）。
 *
 * LOW RISK（新）：TemporalEngine 目前是"死代码"，没有调用方
 *   核实：这不是新发现的问题——00_Project_State.gs「长期方向」和
 *   00_ADR_003 的 Progression Rule 已经明确记录这是刻意决定，不是漏接。
 *   这条审计发现本质上是在重新指出一件已经透明记录过的事，没有新信息，
 *   不需要额外处理。
 *
 * LOW RISK（新）：_cleanTitle_ 正则回溯风险
 *   核实：技术上这个具体正则不太会真的指数级失控（字符类量词没有嵌套
 *   歧义，不是典型的 ReDoS 模式），审计自己的描述也只是"非必要回溯，
 *   增加计算开销"而不是"灾难性回溯"。但建议的修复（拆成两次独立
 *   replace，一次处理开头一次处理结尾）行为完全等价、几乎零成本，没有
 *   理由不做，直接改了。
 *
 * === 第三轮验证方式 ===
 *
 * 新写 4 组测试：
 *   1. 45个任务全部需要提醒时，验证批量写确实按20个一批分成3批
 *      （[20,20,5]），不是一次性写完
 *   2. 模拟批量写连续两次失败，验证 checkReminders 不会整个崩溃、
 *      重试机制确实调用了两次（1次原始+1次重试）
 *   3. 模拟拿不到锁：验证第一次失败正确排了1个重试 trigger，第二次
 *      连续失败不会叠加出第二个重试，成功执行一次之后重试标记被清除
 *   4. _cleanTitle_ 拆分正则后行为验证（头尾标点清除、中间标点保留、
 *      空值处理）
 *   另外把第二轮遗留的全部测试用新增的 PropertiesService/ScriptApp mock
 *   补全后重新跑了一遍，确认第三轮改动没有引入回归（第二轮5组+这次4组
 *   共9组端到端测试，加上第一轮8个场景+TemporalEngine 39个+EventBus
 *   缓存验证，全部通过）。
 *
 * === 第三轮后果 ===
 *
 * - 2_Runtime/25_ReminderEngine.gs：批量写改成分批+失败重试
 *   （_persistBatch），lock 竞争改成一次性延迟重试
 *   （_scheduleRetryOnce + Script Property 防重复排队）。
 * - 2_Runtime/21_SheetUtils.gs：_cleanTitle_ 正则拆成两次 replace。
 * - HIGH RISK 2（新，QueryEngine O(N)读）核实属实但不修，理由是"归档
 *   属于 Productivity OS 的数据边界，Reminder OS 不能单方面伸手"；
 *   MEDIUM/LOW 各一条（JSON.parse未捕获、UrlFetchApp deadline参数）
 *   核实后发现审计描述/建议本身跟实际情况不符，没有改动；LOW RISK
 *   （TemporalEngine死代码）是已经记录过的刻意决定，不是新问题。
 *
 * === 第四轮外部审计（2026-07-10） ===
 *
 * Carson 提供了新一轮针对 2_Runtime/25_ReminderEngine.gs、2_Runtime/
 * 20_EventBus.gs、2_Runtime/21_SheetUtils.gs、4_Integration/40_Output.gs、
 * 0_Governance/00_Project_Constitution.gs 的外部审计报告，HIGH/MEDIUM/
 * LOW 各两到三条。跟前三轮一样的方法：逐条核实是否属实，属实的按严重
 * 程度修复，不属实或不适合直接修的说明理由，不盲目照抄审计给的修复
 * 方案——这一轮有两条（MEDIUM RISK 1、HIGH RISK 3）审计给的具体修法
 * 如果照字面直接实现，会引入比原问题更麻烦的新风险，处理方式见下面
 * 对应条目。
 *
 * HIGH RISK 1（checkReminders 循环内逐条同步写 Events 表）
 *   核实：属实。_recordReminderSent 每次被调用（即每成功发送一条提醒）
 *   都会同步调 EventBus.publish，其内部是同步 appendRow()，单行 I/O。
 *   Tasks 表那条线第一轮就批量化了（HIGH RISK 1，第一轮），但 Events
 *   这条线当时没有一起改——检查了第一轮 ADR 记录，第一轮的改动范围
 *   确实只提到 Tasks 表的批量写，Events 这条线从一开始就是遗漏，不是
 *   后续哪一轮改坏的。
 *   修复：20_EventBus.gs 新增 publishBatch(eventDrafts)，一次
 *   getRange(...).setValues(...) 写入多行连续记录，取代逐条 appendRow。
 *   _recordReminderSent 改成只把事件草稿 push 进调用方传入的
 *   pendingEvents 数组（纯内存操作，不再有任何 I/O），checkReminders
 *   跟 Tasks 批量写（pendingWrite/_persistBatch）用同一套分批节奏——
 *   凑够 BATCH_WRITE_CHUNK_SIZE 或循环结束时，先 _persistBatch 再
 *   _publishPendingEvents。
 *   顺带的行为调整（有意为之，写清楚是因为不是审计要求的，是我
 *   （Claude）在实现过程中主动做的判断）：原来 EventBus.publish 抛错
 *   会导致 _recordReminderSent 提前中断，连带这条任务也不会被
 *   push 进 pendingWrite——也就是"Events 写失败会拖累 Tasks 状态也不
 *   落盘"，两者是意外耦合在一起的，不是设计出来的行为。现在两者解耦：
 *   _publishPendingEvents 内部把异常吞掉、只记日志，不会影响
 *   _persistBatch 那边已经成功的写入，理由是 Events 表本来的定位就是
 *   "尽力而为的审计记录"（20_EventBus.gs 文件头原话），不应该反过来
 *   拖累 reminder_count/last_reminder_at 这个驱动"还要不要提醒"判断
 *   的功能性状态。
 *
 * HIGH RISK 2（一次性重试 trigger 没有清理，累积逼近20个 trigger 硬配额）
 *   核实：属实。查了 GAS 平台上"一次性 trigger 执行完不会自动从
 *   ScriptApp.getProjectTriggers() 消失"这个行为——这是社区广泛报告、
 *   处理这类"续跑"trigger 的通用做法就是显式删除（不管是在下一次运行
 *   开始时删，还是任务彻底完成时删），不是本项目独有的猜测。
 *   _scheduleRetryOnce（第三轮新增）创建 trigger 之后没有任何清理逻辑，
 *   随着锁竞争反复发生，这类 trigger 会不断累积。
 *   修复：
 *     1. _scheduleRetryOnce 改名 _scheduleRetry_，创建 trigger 后把
 *        .create() 返回对象的 getUniqueId() 存进 RETRY_FLAG_KEY（这个
 *        Script Property 原本存的是时间戳字符串，纯粹当布尔标记用，现在
 *        改存 trigger 的 uniqueId，一并解决 LOW RISK 2，见下）。
 *     2. 新增 _cleanupStaleRetryTrigger_，读 RETRY_FLAG_KEY，如果有值，
 *        遍历 ScriptApp.getProjectTriggers() 找到匹配的 trigger 并
 *        ScriptApp.deleteTrigger()，然后清掉这条 Property。deleteTrigger
 *        包了 try/catch——如果 trigger 已经不存在（比如两次调用竞态），
 *        忽略即可，不应该让 checkReminders 因为清理一个"已经不在了"的
 *        trigger 而报错中断。
 *     3. _cleanupStaleRetryTrigger_ 放在 checkReminders 最开头、
 *        无条件调用——不判断这次执行是不是由重试 trigger 触发的，也不
 *        等这次执行成功拿到锁才清理。这样即使出现"重试 trigger 触发后，
 *        这次恰好又没拿到锁"（LOW RISK 2 描述的场景）的情况，那个已经
 *        完成使命的 trigger 也会在它触发的这次执行里被清理掉，不会因为
 *        这次也没拿到锁就被漏掉、继续累积。
 *     4. 1_Foundation/11_Setup.gs 的 runDiagnostics() 新增
 *        checkReminders 名下 trigger 数量检查（稳态应为1个），配合
 *        Script Property 是否有重试记录一起判断当前是否正常，作为部署
 *        时/怀疑累积时的手动排查手段——跟 MEDIUM RISK 1（第一轮）的
 *        webhook 诊断是同一种"没法自动兜底、但至少能被人工发现"的处理
 *        思路。
 *
 * HIGH RISK 3（时间预算检查粒度不够，单次 UrlFetchApp 最坏耗时可能让单次
 * 迭代自己就突破6分钟硬上限）
 *   核实：属实。EXECUTION_TIME_BUDGET_MS 的检查（第二轮引入）只发生在
 *   每次处理任务【之前】，检查通过之后才进入的这一条任务，处理过程本身
 *   （尤其是 Output.sendMessage 里的 UrlFetchApp.fetch）可能耗时接近
 *   UrlFetchApp 的平台内建上限（第三轮已查证，约60秒，不可配置）——
 *   哪怕预算检查那一刻显示"还有余量"，只要接下来这一条任务恰好撞上
 *   最坏情况，单次迭代自己就可能吃掉超过原本预留的1分钟安全余量，把
 *   总耗时推过6分钟硬上限，进程被 GAS 强制终止，已发送但还没来得及
 *   批量写入的状态会彻底丢失。
 *   另外查证了一个关联信息：GAS 官方文档说 LockService 的锁会在脚本
 *   执行结束时自动释放，但也有开发者社区反馈"如果脚本是被强制终止
 *   （而不是正常执行完/正常抛异常）的，锁有没有可靠释放存在不确定性"
 *   ——这不是本次审计报告提到的点，是我在查证过程中顺带注意到的，
 *   记在这里：如果这个不确定性真的发生（脚本因为超时被强制杀死、锁没
 *   释放），会导致下一个整点触发器也拿不到锁，跟本条修复的方向是一致
 *   的——都是"应该主动避免真的撞到6分钟硬上限"，不是两个独立问题。
 *   修复：
 *     1. EXECUTION_TIME_BUDGET_MS 不再是一个直接写死的"5分钟"，改成
 *        显式公式：硬上限(6分钟) − 最坏情况单任务耗时(UrlFetchApp最坏
 *        ~60秒 + 固定节流 + 批量持久化余量~10秒) − 额外安全垫(20秒)，
 *        算出来约等于4分29秒，比原来的5分钟更保守。用公式而不是直接
 *        改一个数字，是为了让"这个数字为什么是这个数字"能在代码里
 *        直接读出来，不需要回来翻这份 ADR 才知道 269000 是怎么来的。
 *     2. BATCH_WRITE_CHUNK_SIZE 从20降到5，缩小"已发送但未持久化"的
 *        风险窗口。这一步能做（而且做的代价可控），是因为同一轮里
 *        MEDIUM RISK 1（见下）把 _persistBatch 的单次成本从"正比于
 *        表总行数"降到"正比于本批大小"——如果没有先修 MEDIUM RISK 1，
 *        单独把 chunk size 从20调到5会让"整表读写"的次数从5次变成
 *        40次，是不划算的；两者放在同一轮一起做，互相成为对方能往前
 *        走一步的前提。
 *   ⚠️ 已知局限：这两步只能【缩小】风险窗口，不能【消除】——GAS 平台
 *   本身不提供配置/缩短 UrlFetchApp 超时的手段，也没有办法在预算检查
 *   那一刻预知"接下来这条任务会不会恰好撞上最坏情况"。这是当前 GAS
 *   平台限制下能做到的合理程度的缓解，跟第三轮 LOW RISK（UrlFetchApp
 *   deadline参数不存在）那条的结论是一致的。
 *
 * MEDIUM RISK 1（batchUpsertRowsByKey_ 每次调用都整表读+整表写，分批
 * 持久化时被重复调用多次，成本正比于表总行数而不是本批大小）
 *   核实：属实。batchUpsertRowsByKey_ 每次调用确实会
 *   getRange(2,1,lastRow-1,numCols).getValues() 读整张表、合并字段后
 *   getRange(2,1,existingRows.length,numCols).setValues(...) 整表写回，
 *   _persistBatch 分批调用它（第三轮引入，每批最多20个已发送任务写
 *   一次）意味着这个"整表读+整表写"的成本会在同一次 checkReminders
 *   执行里被重复付出多次。
 *   审计给的修复建议是"在内存中完成所有分批计算和状态累加，整个执行
 *   周期结束前只读写一次"——评估后【没有照字面实现这个建议】，理由：
 *   这等于把持久化改回第二轮"循环结束才写一次"的做法，而第三轮 HIGH
 *   RISK 1 已经明确论证过并改掉了这个做法（一次性写入失败/被中断，
 *   会导致整批状态全部丢失）；如果为了消除"重复整表读写"而重新引入
 *   "单点写入失败牵连全部"的风险，是拿一个已经修好的问题去换这个
 *   性能问题，不划算。
 *   进一步评估了"缓存一次读取结果、跨多次分批调用重复使用"这个折中
 *   方案，也没有采用：Reminder OS 和 Productivity OS 是两个独立的 GAS
 *   项目，各自的 LockService 互不感知对方，本项目的锁只保证"同一时间
 *   只有一个 checkReminders 在跑"，不能阻止 Productivity OS（或用户
 *   直接在 Sheet UI 操作）在 checkReminders 执行期间（分批持久化跨越
 *   好几分钟）并发修改 Tasks 表。如果缓存一份"现有行数据"跨多次调用
 *   重用、最后再整表覆写，一旦 Productivity OS 在这期间改了某个不相关
 *   字段（比如用户改了任务标题），本项目基于缓存旧数据的整表覆写会把
 *   那次改动悄悄覆盖掉——等于用"偶发重复提醒"的性能问题去换"偶发数据
 *   丢失"的正确性问题，同样不划算。
 *   实际修复：21_SheetUtils.gs 新增 batchUpdateFieldsByKey_，操作形状
 *   跟 batchUpsertRowsByKey_ 不同——只读 keyHeader 这一列定位行号（不读
 *   其余列），只对实际要改的字段做单元格级 setValue()（不做整行/整表
 *   setValues()），不支持"找不到就插入"（找不到记进返回值的 notFound
 *   数组，交给调用方判断）。这样读的宽度从 numCols 列降到1列，写的范围
 *   从"整张表"降到"本批实际改动的单元格"，两者都不再随表的总行数/
 *   总列数线性增长；同时因为每次调用仍然是【当次】重新读1列（不跨调用
 *   缓存），也仍然保留了"基于足够新鲜的数据做判断"这个安全性质——
 *   跟上一段分析的两个被否决方案的关键区别就在这里。_persistBatch 改
 *   调这个新函数，batchUpsertRowsByKey_ 本身不变，继续保留给真正需要
 *   "找不到就插入"语义的场景（比如以后真的有整表重建需求）。
 *
 * MEDIUM RISK 2（_sendReminder 网络抖动可能导致"已送达但状态未落盘"的
 * 偶发重复发送）
 *   核实：属实。Output.sendMessage 已经设置 muteHttpExceptions:true
 *   （非2xx状态码不会抛异常，会正常返回），但如果 Telegram 已经收到
 *   并处理了请求（消息确实已经送达），只是返回响应的路上网络抖动/超时，
 *   UrlFetchApp.fetch 仍然会抛异常，进 catch 分支返回 {ok:false}——
 *   checkReminders 据此判定"发送失败"，不更新 reminder_count/
 *   last_reminder_at，下次触发器会重新判定需要提醒，造成重复发送。
 *   评估是否能在代码层面修复，查证了两个关键事实：
 *     1. UrlFetchApp 没有任何手段区分"请求根本没打到"（DNS失败/连接被
 *        拒绝，消息确定没发出去）和"打到了、处理了，但响应丢了"（消息
 *        可能已经送达）——没有请求ID，没有"查询这次请求实际状态"的
 *        旁路接口。
 *     2. 查了 Telegram Bot API 的官方 GitHub issue tracker：
 *        "Idempotence for method calls"是一个长期开放、至今没有实现的
 *        feature request——sendMessage 这类方法调用不支持幂等键/去重
 *        token，Telegram 服务端没有提供"同一个请求重复发送只生效一次"
 *        的机制。
 *   两个平台（GAS 和 Telegram Bot API）都不提供解决这个问题所需的手段，
 *   不是本项目代码层面能修的问题——这跟第三轮"UrlFetchApp deadline参数
 *   不存在"那条性质类似：审计指出的现象是真的，但建议隐含的"这能被修好"
 *   前提不成立。
 *   处理方式（不是"修复"，是"业务层面接受+诊断增强"，采纳的正是审计
 *   建议本身给出的方向）：40_Output.gs 的 catch 分支新增
 *   ambiguousDelivery:true 标记，跟其他明确的业务失败（比如 Telegram
 *   明确返回 chat not found）区分开，方便以后翻日志排查偶发重复发送时
 *   一眼看出是不是这种"响应丢失"情况。这个标记只是诊断辅助，不改变
 *   "发送失败就不更新状态"这个既有判断逻辑，也不会减少重复发送本身的
 *   概率——完整认定见 00_Project_State.gs「已知问题」。
 *
 * LOW RISK 1（00_Project_Constitution.gs 对 Tasks 表结构强耦合，违反
 * 开闭原则，建议引入抽象层/数据字典映射）
 *   核实：技术观察本身没错——_shouldRemind/_buildReminder 等确实是围绕
 *   task_id/priority/status/due_date 这些字段名硬编码的。但这不是一个
 *   新问题，也不是这次审计发现的：00_Project_Constitution.gs P1 从
 *   2026-07-03 拆分时就明确写了"未来 Property/Finance/Vehicle OS 只要
 *   往共享 Spreadsheet 写自己的表，这个项目加一段'也查那张表'的逻辑，
 *   就能复用同一套提醒/通知机制"——这是一个已经想清楚、已经落笔的方案，
 *   只是方向跟这次审计建议的"抽象一层通用接口"不一样。
 *   评估是否应该改用审计建议的方案：没有采纳，按
 *   00_ADR_003_Reminder_OS_V2_Vision_Evaluation.gs 里的 Progression
 *   Rule（不为还没出现的真实需求预先设计）——在 Property/Finance/
 *   Vehicle OS 里任何一个真的接入之前，没有第二个真实案例可以验证
 *   "抽象接口该长什么形状"才是对的，现在设计出来的任何通用接口都是
 *   凭空猜的，猜错的代价（接入第一个真实新 Domain OS 时发现抽象层设计
 *   跟实际需求对不上，需要推翻重来）不比"现在不抽象、以后加一段查询
 *   逻辑"更小。这跟 00_ADR_004 里"决定不为 Foundation 模块另开
 *   ADR-005"的理由是同一类判断。
 *   处理方式：00_Project_Constitution.gs P1 补充一段"2026-07-10 核实"
 *   记录这次复审的结论，不改变 P1 原有方案本身。
 *
 * LOW RISK 2（锁竞争时，如果第一次重试本身也遇到锁竞争，不会安排第二次
 * 重试，导致延迟接近整点触发器的一小时周期，重试机制在这种场景下形同
 * 虚设）
 *   核实：属实，逐步走查了 _scheduleRetryOnce/RETRY_FLAG_KEY 的完整
 *   状态机确认：RETRY_FLAG_KEY 只有在 checkReminders【成功拿到锁】之后
 *   才会被清掉。如果第一次重试（5分钟后触发）本身也因为前一个实例还没
 *   跑完而拿不到锁，会再次进入"拿不到锁"的分支，此时标记还在（因为这次
 *   同样没有走到"清掉标记"那一步），于是被当成"已经排过重试了"直接
 *   放弃，不会安排第二次重试——变成要等下一个整点触发器，最坏延迟接近
 *   整整一小时，第三轮引入这个重试机制本来要解决的问题在这种场景下
 *   基本没解决。
 *   修复：把"布尔标记、只重试1次"改成"计数器、最多重试
 *   MAX_RETRY_ATTEMPTS(=2)次"——RETRY_COUNT_KEY 记录当前这一轮锁竞争
 *   已经重试了几次，只在成功拿到锁之后才清零，达到上限才真正放弃退回
 *   等下一个整点。这个数值本身是折中，不是精确计算出来的：没有做成
 *   "无限重试直到成功"，因为那样会失去锁竞争约束原本要防的东西（同一个
 *   函数的执行互相越叠越多，第三轮引入"只重试1次"就是为了避免这个）；
 *   2次覆盖了"两次都刚好撞上"这种更极端的场景，但仍然是有限次数，
 *   具体数字见 00_Project_State.gs「下一步」，按实际观察到的运行情况
 *   可以调整。
 *   这条修复用的 RETRY_FLAG_KEY 跟 HIGH RISK 2 的 trigger 清理共享同一个
 *   Script Property（现在存 trigger 的 uniqueId），两条修复在实现上是
 *   交织在一起的，不是各自独立的两处改动——具体设计见
 *   2_Runtime/25_ReminderEngine.gs 里 RETRY_FLAG_KEY/RETRY_COUNT_KEY/
 *   _cleanupStaleRetryTrigger_/_scheduleRetry_ 几处的注释。
 *
 * === 第四轮验证方式 ===
 *
 * 用 Node.js 的 vm 模块搭了一套 mock GAS 环境（SpreadsheetApp/Sheet/
 * Range 用内存二维数组模拟，PropertiesService 用内存对象模拟，ScriptApp
 * 的 trigger 用带 uniqueId 的数组模拟且 deleteTrigger 对不存在的 id 会
 * 报错——特意模拟这个报错行为，是为了验证 _cleanupStaleRetryTrigger_
 * 的 try/catch 真的有必要、真的生效；UrlFetchApp/LockService 的行为
 * 可以按测试场景注入），把这四个改动过的 .gs 文件源码原样加载进去跑，
 * 不是重新拿 JS 实现一遍"我觉得代码应该做的事"再测那份实现。
 *
 * 新写 6 组针对第四轮改动的场景测试：
 *   1. 12条提醒全部发送成功（batch chunk size=5，应该分3批 5+5+2）时，
 *      验证 Events 表的写入调用次数等于批数（3次），不是逐条12次调用，
 *      且不再出现旧版的单行 appendRow 调用
 *   2. 完整模拟"锁竞争→重试1→仍然锁竞争→重试2→仍然锁竞争→放弃"这一条
 *      链路：验证每一步 trigger 是否被正确创建/清理、Script Property
 *      里的 trigger id 和重试计数是否符合预期、达到 MAX_RETRY_ATTEMPTS
 *      后确实不再继续排队、且最终锁恢复可用时能正常执行并清空所有
 *      重试相关状态
 *   2b. 单独验证清理一个已经不存在的 trigger id 不会抛出未捕获异常
 *   3a. 直接从源码摘出 EXECUTION_TIME_BUDGET_MS/BATCH_WRITE_CHUNK_SIZE/
 *      MAX_RETRY_ATTEMPTS 的定义原样求值，验证算出来的具体数值符合预期
 *      方向（预算比原来更保守、chunk size比原来更小、重试次数比原来更多），
 *      不是凭感觉看代码"觉得对"
 *   3b. 模拟第3条任务处理耗时暴涨（模拟 UrlFetchApp 撞上最坏情况），验证
 *      预算检查在下一次迭代开始前正确生效、提前中断循环，已处理的3条
 *      状态确实落盘，未处理的不会被误改
 *   4. 200行的大表场景下，验证批量持久化不再出现"整表读"/"整表写"
 *      （只有 QueryEngine 既有的1次整表读，属于不在本轮修改范围内的
 *      已知行为），改成"只读1列定位行号"+"逐字段定点 setValue"，且最终
 *      数据结果本身是对的（200行全部正确更新，未改动字段没有被误覆盖）
 *   4b. 单独验证 batchUpdateFieldsByKey_ 对不存在的 key 不会静默 append
 *      新行，而是记进 notFound
 *   5. 验证 Output.sendMessage 在 UrlFetchApp 抛异常时标记
 *      ambiguousDelivery:true，在 Telegram 明确返回业务失败时不标记
 *      （对照组，确认标记不会被滥用到所有失败情况上）
 * 全部 39 个断言通过。
 *
 * 另外新写 8 组回归测试，覆盖前三轮已经修复、这次改动路径上有交叉的
 * 关键行为，确认没有被破坏：REMINDER_ADVANCE_HOURS 提前量判断、
 * last_reminder_at 确实落盘（第二轮那个"从未生效"的 bug 不能重新出现）、
 * 发送失败时不更新任何状态、单任务异常不拖累其他任务、OVERDUE 24小时
 * 强制间隔、简单的单次锁竞争重试链路端到端可用、EventBus 原有的单条
 * publish() 不受 publishBatch 新增影响、_persistBatch 失败重试机制在
 * 换成新的 batchUpdateFieldsByKey_ 之后依然按预期工作。全部 18 个断言
 * 通过。
 *
 * === 第四轮后果 ===
 *
 * - 2_Runtime/25_ReminderEngine.gs：_recordReminderSent 不再直接调
 *   EventBus.publish，改为写入 pendingEvents 缓冲区；新增
 *   _cleanupStaleRetryTrigger_；_scheduleRetryOnce 改名 _scheduleRetry_
 *   并支持有限次数重试；EXECUTION_TIME_BUDGET_MS 改为公式推导；
 *   BATCH_WRITE_CHUNK_SIZE 20→5；_persistBatch 改调
 *   batchUpdateFieldsByKey_。
 * - 2_Runtime/20_EventBus.gs：新增 publishBatch，原 publish 不变。
 * - 2_Runtime/21_SheetUtils.gs：新增 batchUpdateFieldsByKey_，原
 *   batchUpsertRowsByKey_ 不变。
 * - 4_Integration/40_Output.gs：catch 分支新增 ambiguousDelivery 诊断
 *   标记，不改变原有返回结构。
 * - 1_Foundation/11_Setup.gs：runDiagnostics() 新增 trigger 数量检查。
 * - 0_Governance/00_Project_Constitution.gs：P1 新增核实记录（结论
 *   不变），P3 更新为定点字段更新+Events批量发布的描述。
 * - MEDIUM RISK 2（Telegram 送达状态不确定导致的偶发重复发送）核实属实
 *   但受限于 GAS 和 Telegram Bot API 两个平台都不提供解决所需的手段，
 *   只做诊断增强，业务层面接受为"至少送达一次"语义下的偶发代价；
 *   LOW RISK 1（Constitution 抽象层建议）核实后确认不是新问题，是已有
 *   决定的重新核实，结论不变，理由见 P1 的核实记录和 Progression Rule。
 *
 * === 第三轮 HIGH RISK 2 后续解决（2026-07-11） ===
 *
 * 背景：第三轮外部审计（2026-07-06）指出 QueryEngine._readAllRows_ 每次
 * 被 getPendingTasks() 调用都会读整张 Tasks 表（含全部历史 DONE/
 * CANCELLED 任务），核实属实，但当时评估"正确的修法（归档）需要移动/
 * 删除 Tasks 表的行，会越界碰 Productivity OS 拥有的数据"，同时提到
 * "ActiveTasks 表如果真的由 Productivity OS 维护成只放未完成任务，可能
 * 是更好的方向，但需要看 Productivity OS 的代码才能确认"——当时没有
 * 这份代码，记成已知问题搁置。Carson 这次提供了 Productivity OS 的完整
 * 代码，可以正式评估并解决。
 *
 * 核实 ActiveTasks 的真实机制（不是从命名或注释推测，是逐个函数看过
 * Productivity OS 的 10_ProjectionEngine.gs 后确认的）：
 *   1. TASK_CREATED 时，projectTaskCreated_ 在同一次调用里先 upsert
 *      Tasks，再 upsert ActiveTasks（后者包了 try/catch，失败不影响
 *      前者）——两张表同步更新，不是定时批处理、也不是最终一致。
 *   2. TASK_COMPLETED/TASK_CANCELLED 时，projectTaskCompleted_ 等函数
 *      更新 Tasks 的 status 之后，会把 ActiveTasks 里对应的行整行删除
 *      （deleteRowByKey_）。TASK_UPDATED 时，如果任务更新前的状态已经是
 *      终态，不会重新把它塞回 ActiveTasks。
 *   3. 结论：ActiveTasks 任何时刻都精确等于"当前非终态任务集合"，体量
 *      只随"现在有多少未完成任务"变化，不随历史任务数增长——这正是
 *      getPendingTasks() 需要的数据形状。
 *   4. 13_ActiveTasksEngine.gs 的 runDailyArchive（每日归档）操作的是
 *      Tasks→ArchiveTasks 这条线，不是 ActiveTasks——文件头明确写
 *      "归档后 Tasks 里对应行加 archived=true 标记，不物理删除...物理
 *      删除会让 rebuildAllProjections() 失去重建依据"。也就是说 Tasks
 *      表本身永远不会变小，这是 Productivity OS 自己的既有决定，不是
 *      本项目能改、也不需要改的地方——本项目的修复目标是"不因为 Tasks
 *      变大而变慢"，不是"让 Tasks 变小"。
 *
 * 核实 reminder_count/last_reminder_at 能不能整体搬去 ActiveTasks（评估
 * "干脆只读写 ActiveTasks，完全不碰 Tasks"这个更彻底方案时发现的两个
 * 阻塞点，决定了不能这样做）：
 *   1. 10_ProjectionEngine.gs 里，凡是涉及 ActiveTasks 的投影函数都明确
 *      跳过 reminder_count 这一列（原文注释"ActiveTasks 不需要
 *      reminder_count（工作台不展示这列），跳过"）——也就是说即使
 *      ActiveTasks 的表结构上有这一列，Productivity OS 自己也从不维护
 *      它，本项目如果读它会读到过时/无意义的值。
 *   2. 26_AnalyticsEngine.gs 的 computeStatistics 接收"已终结+未终结的
 *      全量 task"，用其中的 reminder_count 算 avg_reminder_count，被
 *      25_DashboardEngine.gs 的仪表盘展示——这个统计必须覆盖已完成的
 *      任务才有意义（"平均要提醒几次任务才会做完"），如果本项目改成
 *      只把 reminder_count 写在 ActiveTasks，任务一完成对应行就被
 *      Productivity OS 的投影逻辑删除，这个字段的值会跟着消失，
 *      Productivity OS 这个既有统计功能会失真（永远显示0）。这不是
 *      本项目愿不愿意承担的问题，是会实际破坏 Productivity OS 一个
 *      已经在用的功能，不能做。
 *   结论：reminder_count/last_reminder_at 的权威数据必须继续留在
 *   Tasks，读边界可以扩大到 ActiveTasks，写边界不能跟着挪。
 *
 * 修复：
 *   1. 21_SheetUtils.gs 新增 batchReadFieldsByKey_——只读 keyHeader 这
 *      一列定位行号，对给定的一批 key 只定点读取指定的字段，不读整表
 *      其余列。是 batchUpdateFieldsByKey_（第四轮新增，写版本）的读
 *      版本，同一个思路。
 *   2. 22_QueryEngine.gs 的 getPendingTasks() 改成两步：① 用
 *      _readAllRows_(ActiveTasks) 取候选任务（这一步仍然是"整表读"，
 *      但 ActiveTasks 体量小、只随当前活跃任务数增长，读整张小表没有
 *      问题——O(N) 问题的本质是"N 会不会跟着历史无限增长"，不是"能不能
 *      整表读"本身）；② 用 batchReadFieldsByKey_ 对候选任务的 task_id
 *      去 Tasks 定点取 reminder_count/last_reminder_at（只读1列定位+
 *      对候选任务定点取2个字段，成本正比于候选任务数和 Tasks 总行数的
 *      1列宽度，不再正比于 Tasks 总行数×总列数）。
 *   3. status 过滤条件保持"严格等于 PENDING"不变——核实了 Productivity
 *      OS 的 20_TaskEngine.gs，任务创建时状态永远是 'PENDING'，代码里
 *      没有任何路径会产生 'IN_PROGRESS'/'WAITING'（Constitution 里
 *      "ActiveTasks 只存 PENDING/IN_PROGRESS/WAITING"的表述目前是
 *      预留的、还没有被用到的可能性）。如果照 ActiveTasks 的字面定义
 *      把候选条件放宽成"非终态"，会在未来 Productivity OS 真的用上
 *      IN_PROGRESS/WAITING 那天，让 Reminder OS 开始提醒以前从不提醒
 *      的任务——这是一个产品行为决定，不应该作为性能修复的副作用悄悄
 *      发生，所以没有放宽，行为跟改动前完全一致，只是数据来源变了。
 *   4. getCompletedTasks()/getTaskById() 没有跟着改——本项目目前没有
 *      任何调用方，不在 checkReminders 每小时都会跑的路径上。给不会被
 *      调用的代码做同样的优化没有实际收益，只会增加"两个函数为什么
 *      处理方式不一样"的解释负担，等真的有功能会调用它们时再照这次的
 *      思路处理。
 *   5. 00_Project_Constitution.gs P3 正式修订（不是追加说明）：原文
 *      "只读 Tasks 表...不碰 ActiveTasks/ArchiveTasks"这句话本身不再
 *      准确，必须改字——这跟本文件之前几轮"边界没变，只是实现细节变了"
 *      的情况不同，这次是边界本身变了，按 Constitution 自己的原则
 *      （宪法应该反映真实边界，不是历史记录），需要修订原文，不是加
 *      批注。
 *
 * ⚠️ 没有做、且明确评估过为什么不做：
 *   - 没有让 Reminder OS 改写 ActiveTasks（哪怕只是 reminder_count 这
 *     一列）——会破坏 26_AnalyticsEngine.gs 的统计功能，见上面的核实
 *     过程。
 *   - 没有去改 Productivity OS 的任何代码（比如让它的 Projection 也
 *     同步 reminder_count 到 ActiveTasks，或者把 last_reminder_at
 *     补进它的官方 schema 清单）——这些改动如果要做，应该由 Carson
 *     决定、在 Productivity OS 自己的治理流程里做，不是 Reminder OS
 *     这边能单方面决定的事，本项目仍然保持"只读它、不要求它改任何东西"
 *     这个最小侵入的关系。
 *   - 没有实现"整表归档/物理搬迁 Tasks 里的旧数据"——这从一开始就不是
 *     本项目能做的事（Constitution P3 的写边界从没变过），而且
 *     Productivity OS 自己已经有 ArchiveTasks 这套机制、也已经明确
 *     决定不物理删除 Tasks 里的行，本项目没有理由、也没有权限去动这
 *     部分。
 *
 * 调查过程中发现两个跟本次修复相关、但不是 Reminder OS 的 bug、本项目
 * 也没有能力独立核实或修复的情况，只做记录，见
 * 00_Project_State.gs「已知问题」：
 *   - last_reminder_at 不在 Productivity OS 的 15_Setup.gs 官方 schema
 *     清单里，但 11_ProjectionRebuilder.gs 的 deriveFromEvent 确实在
 *     处理这一列——两边不完全同步。本项目从最早版本起就假设这一列
 *     存在且可写，一直正常工作，大概率是当初手动加到 Sheet 里的，但
 *     无法从代码历史里确认。
 *   - TaskStatistics.reminder_count_total 依赖 REMINDER_SENT 事件触发
 *     Productivity OS 自己的 ProjectionEngine.dispatch，但 Reminder OS
 *     是独立 GAS 项目，发布事件这个动作不会跨项目触发 Productivity OS
 *     的 dispatch 链路——这个统计字段可能从设计出来就没有被真实的提醒
 *     行为更新过。
 *
 * === 第三轮 HIGH RISK 2 后续解决 —— 验证方式 ===
 *
 * 沿用同一套 mock GAS 环境，新增了 ActiveTasks 表的模拟，并且把测试
 * 夹具换成跟 Productivity OS 的 15_Setup.gs 逐字段对齐的真实表头（不再
 * 用之前几轮测试里简化过的8列版本）——这个换血过程本身也倒查出前四轮
 * 测试用的简化 schema 跟真实情况有出入，借这个机会把所有涉及
 * checkReminders() 端到端流程的测试夹具都统一成真实 schema，避免"测试
 * 通过但跟真实表结构对不上"这种虚假的安全感。
 *
 * 新写3组场景测试：① 用1000条历史任务+3条当前任务构造"体量悬殊"的
 * Tasks/ActiveTasks，验证只返回3条候选、reminder_count/last_reminder_at
 * 正确从 Tasks 补全、且没有发生"多列×多行"的整表读、对 Tasks 的定点
 * 字段读取次数只等于"候选数×字段数"不随历史任务数增长；② ActiveTasks
 * 和 Tasks 数据出现不一致（Tasks 里根本没有 ActiveTasks 提到的
 * task_id）时优雅降级为"无提醒历史"，不抛异常，且记录警告日志；③ 端到
 * 端跑一次完整的 checkReminders()，确认间隔判断（用从 Tasks 定点取到的
 * last_reminder_at）仍然正确、最终 reminder_count 写回 Tasks 而不是
 * ActiveTasks、ActiveTasks 全程没有被写入任何数据。
 * 新写1组回归测试：ActiveTasks 表不存在时（比如 Productivity OS 还没
 * 跑过 setupSheets()），不抛异常，优雅降级为空候选列表。
 * 前四轮遗留的全部测试（换用真实 schema 重新构造夹具后）一并重跑，
 * 全部通过，确认这次改动没有影响前四轮已经修好的任何行为。
 *
 * === 第三轮 HIGH RISK 2 后续解决 —— 后果 ===
 *
 * - 2_Runtime/22_QueryEngine.gs：新增 ACTIVE_TASKS_SHEET 常量；
 *   getPendingTasks() 改为"ActiveTasks 取候选 + Tasks 定点补两个字段"
 *   两步流程；getCompletedTasks()/getTaskById() 不变。
 * - 2_Runtime/21_SheetUtils.gs：新增 batchReadFieldsByKey_，其余不变。
 * - 0_Governance/00_Project_Constitution.gs：P3 正式修订读边界描述
 *   （"只读 Tasks...不碰 ActiveTasks"→"读 ActiveTasks 取候选+对 Tasks
 *   定点查两个字段"），P1 同步更新表述，写边界（只写 Tasks 的两个字段）
 *   不变。
 * - 本项目对 Productivity OS 数据的读取范围从"Tasks 一张表"扩大为
 *   "Tasks + ActiveTasks 两张表"，仍然是纯只读关系，没有新增任何写入
 *   目标，没有要求 Productivity OS 修改任何代码。
 * - 发现两处跟 Productivity OS 自身相关、本项目无法独立确认或修复的
 *   情况（last_reminder_at 官方 schema 缺失、TaskStatistics.
 *   reminder_count_total 可能从未被真实触发过），记录在
 *   00_Project_State.gs「已知问题」，留给 Carson 判断是否需要在
 *   Productivity OS 那边跟进。
 *
 *
 * ══════════════════════════════════════════════════════════════
 * 第五轮外部审计（2026-07-15）+ 同日 GAS Console 实测问题
 * ══════════════════════════════════════════════════════════════
 *
 * 背景：第四轮（2026-07-10）+ 第三轮 HIGH RISK 2 后续解决（2026-07-11）
 * 之后，到这次审计（2026-07-15）之间，项目发生了两件不在本 ADR 记录范围
 * 内、但读者需要知道存在的事：① 新增了完整的 Offset Reminder Engine
 * （2_Runtime/26_ReminderOffsetEngine.gs + 5_Testing/
 * 50_ReminderOffsetEngine_Tests.gs），经过多轮设计精化，引入了 Project
 * Constitution P8/P9 两条新原则；② 对 1_Foundation/12_TemporalEngine.gs
 * 做了一次独立的 UEF 架构评审（2026-07-12），4条 LOW 发现里3条
 * （Finding 1/2/4）在2026-07-13被修复，第4条（Finding 3，Object.freeze）
 * 当时 disposition 是 Fix Later，本轮审计重新独立发现了同一个问题（见下
 * LOW RISK 1），予以采纳、提升为 Fix Now，完整过程见
 * 00_ADR_004_Temporal_Engine_Design.gs「2026-07-15 修订记录」。这两件事
 * 本身都没有被追加进本 ADR 或 00_Project_State.gs/00_File_Map.gs——这是
 * 一处已知的文档缺口，本轮修复顺手发现但没有回填，见 00_Project_State.gs
 * 本轮条目末尾和本节末尾的说明。
 *
 * 第五轮审计报告本身覆盖 20_EventBus.gs/21_SheetUtils.gs/
 * 25_ReminderEngine.gs/26_ReminderOffsetEngine.gs/12_TemporalEngine.gs
 * 共4个 HIGH + 1个 MEDIUM + 1个 LOW，要求按严重程度顺序全部修复。
 *
 * === 逐条核实 + 处理 ===
 *
 * HIGH RISK 1（26_ReminderOffsetEngine.gs checkOffsetReminders，幂等
 * 判断在到期时间改早时误判为"已处理"）
 *   核实：属实。resolved_fire_ats 原本按 channel 存"上一次为这个
 *   channel 算出的 fireAt"，判重逻辑是
 *   fireAt.getTime() <= lastResolved.getTime() 就跳过——这个单向比较
 *   隐含"同一个 channel 再次算出的 fireAt 只会不变或变大"，只在"任务
 *   到期时间不变或后移"时成立。用户把一个已经解决过的、还在 pending 的
 *   任务的到期时间改早，重新算出的 fireAt 会跟着变小，反而满足"<=上次"，
 *   被误判成已处理而跳过，用户收不到新到期时间对应的提醒。
 *   修复：resolved_fire_ats 每个 channel 存的值，语义改成"上次解决这个
 *   channel 时，effectiveDue（任务到期时间）是多少"，判重逻辑改成直接
 *   比对 effectiveDue 是否等于上次记录的值——到期时间没变就不重复处理，
 *   变了（不管改早还是改晚）都判定需要重新评估，交给 fireAt 相关的时间
 *   判断决定现在要不要真的发送。字段名（resolved_fire_ats）本身没有改，
 *   只改存的值和比较方式——改列名是数据迁移级别的变动，不是这次修复的
 *   必要部分。
 *
 * HIGH RISK 2（20_EventBus.gs publishBatch，"先读行数再写入"两步非
 * 原子，三个独立项目共享 Events 表时可能互相覆盖）
 *   核实：属实。publishBatch 用 sheet.getLastRow()+1 算起始行、一次
 *   setValues() 写连续多行——Reminder OS/Personal AI Core/
 *   Productivity OS 三个独立 Apps Script 项目共享同一张 Events 表，
 *   任何一个项目在这两步之间插入自己的写入，都会让本次算出的起始行
 *   过期，后写入的这一批把那次并发写入的内容覆盖掉。
 *   修复：改成逐行调用 appendRow()——GAS 官方文档明确 appendRow 是
 *   原子操作（"prevents issues where a user asks for the last row, and
 *   then writes to that row, and an intervening mutation occurs"），
 *   服务端在处理这次调用的当下才决定"当前实际的最后一行是哪一行"，不
 *   依赖调用方之前缓存的行号，天然避免这种竞态。本文件的单条 publish()
 *   一直用的就是 appendRow，历次审计都没有点名过这个问题，是同一个
 *   平台保证在起作用，间接印证了这个修法的方向。代价：从"1次
 *   setValues() 写N行"退化成"最多N次 appendRow() 各写1行"——两个调用方
 *   的批量节奏都是 BATCH_WRITE_CHUNK_SIZE=5，单次 flush 最多5次同步
 *   调用，拿这点可接受的性能回退换掉数据丢失风险。
 *   ⚠️ 范围边界：这只保证 Reminder OS 自己这一侧的写入不再因为"读跟写
 *   不是原子的一步"而丢数据；如果 Personal AI Core / Productivity OS
 *   各自的 EventBus 副本内部也用类似 getLastRow()+setValues() 的写法，
 *   那两个项目自己的这条线仍然需要各自去修，本项目看不到那两个项目的
 *   代码，也没有办法替它们改。
 *
 * HIGH RISK 3（21_SheetUtils.gs batchReadFieldsByKey_，逐格
 * getValue() 反模式）
 *   核实：属实。命中的每个 key、要读的每个字段都各自单独调一次
 *   sheet.getRange(rowNum, col).getValue()，同步网络调用次数是命中数×
 *   字段数的乘积。
 *   修复：先算出命中的所有行号、要读的所有列号各自的 [min,max] 包络，
 *   一次 getValues() 把这个矩形区域整体读进内存（代价是可能顺带读到
 *   命中key之间、字段之间用不上的行/列，但比起"每个单元格各一次调用"，
 *   用一次范围读换掉 O(N) 次调用远远划算），再在内存里按偏移量取值。
 *   I/O 调用次数从"命中数×字段数"降到最多2次（定位行号1次+整块取值
 *   1次）。这个函数之前没有专属测试覆盖过（22_QueryEngine.gs 是唯一
 *   调用方，但 mocks.js 对 QueryEngine 用的是简化 mock，没有真的走到
 *   这个函数），借这次修复顺手新增 5_Testing/50_SheetUtils_Tests.gs
 *   补上（范围只覆盖这次改到的三个函数，不是 SheetUtils 全量覆盖，见
 *   该文件文件头）。
 *
 * HIGH RISK 4（25_ReminderEngine.gs checkReminders /
 * 26_ReminderOffsetEngine.gs checkOffsetReminders，LockService 不能
 * 跨 standalone 项目生效）
 *   核实：属实。两个引擎都用 LockService.getScriptLock() 提供互斥
 *   保障，但 Script Lock 只在当前脚本项目内部起作用，无法阻止 Personal
 *   AI Core（处理 Telegram 按钮回调）或 Productivity OS 在本项目执行
 *   期间并发写共享的 Tasks/ReminderRules/Events 等表。
 *   评估审计给的两条修法，都没有采纳：
 *     1. 在共享 Spreadsheet 里建一张专属锁定表，各项目写入前互相
 *        协调——需要 Personal AI Core 和 Productivity OS 也同步实现
 *        并遵守同一套协议，本项目单方面加锁对那两个项目的写入没有任何
 *        约束力，等于只加复杂度不加保护，是虚假的安全感。本项目这次
 *        也看不到那两个项目的代码，没有办法替它们改，也没法验证它们
 *        是否会配合。
 *     2. 把三个项目都迁移成绑定在同一 Spreadsheet 下的容器绑定脚本，
 *        以启用 LockService.getDocumentLock()——这是牵动全平台三个
 *        项目的部署架构变动，不是能在 Reminder OS 这一个项目里单方面
 *        决定的事。
 *   没有在代码层面"修复"，只在两处加锁点（checkReminders/
 *   checkOffsetReminders）补充了详细注释说明这个评估过程。跟 MEDIUM
 *   RISK 1（第四轮）处理 Tasks 表同一类跨项目并发风险时的判断一致：
 *   现有的按需定点单元格写入（batchUpdateFieldsByKey_/
 *   batchReadFieldsByKey_ 只碰实际要改的字段，不整行/整表覆写）已经是
 *   在没有跨项目锁的前提下能做到的合理缓解，真正的解决需要一次跨三个
 *   项目的协调决定，记录进 00_Project_State.gs「已知问题」，不假装
 *   已经修好。
 *
 * MEDIUM RISK 1（26_ReminderOffsetEngine.gs checkOffsetReminders，
 * staleRuleIds 独立于批量 flush 机制之外，函数末尾逐个同步调用
 * deleteRowByKey_）
 *   核实：属实。失效规则的删除被排除在分批 flush 机制之外，函数末尾用
 *   forEach 循环逐个调用 deleteRowByKey_，每次调用都各自完整地开表+读
 *   表头+扫 key 列定位，一旦本轮累积的失效规则较多，会在函数收尾阶段
 *   集中拖慢执行、逼近超时。
 *   修复：① staleRuleIds 改名 ruleDeletes，挪到跟其余五个批量累加数组
 *   （occUpserts/historyInserts/occDeletes/pendingEvents/ruleUpdates）
 *   一起最先声明，flush/flushIfNeeded 也跟着提前，循环期间用同一套
 *   节奏分批处理，不再有"循环内不批、循环外一次性处理"的不一致；②
 *   21_SheetUtils.gs 新增 batchDeleteRowsByKey_：只读 keyHeader 这一列
 *   一次，定位给定的一批 key 各自对应哪一行，按行号【降序】依次
 *   deleteRow()（降序是必须的，不是风格选择——deleteRow 物理删除一行后
 *   下面所有行的行号都会整体减一，按升序删会删错行），_persistBatch_
 *   的 ruleDeleteIds 处理改调这个新函数，不再逐个 key 各自开表定位。
 *   ⚠️ 顺带修复（不在审计报告原文里，但是同一个函数内完全相同的
 *   反模式，而且触发频率更高）：_persistBatch_ 里
 *   occurrenceDeleteKeys（每条 occurrence 无论 sent/failed归档/
 *   cancelled 都会走到这里）用的是一模一样的"逐个 key 调
 *   deleteRowByKey_"形状，一并换成 batchDeleteRowsByKey_，没有留一个
 *   显而易见会被下一次审计重新点名的姊妹问题。
 *
 * LOW RISK 1（12_TemporalEngine.gs parseRule，Schedule Model 的不可变
 * 约定没有运行时强制）
 *   核实：属实——但这不是一个全新发现。这条其实就是 2026-07-12 UEF
 *   架构评审的 Finding 3，Disposition 当时就是 Confirmed，但优先级
 *   评估是 Fix Later（跟同一份评审的 Finding 1/2 不同——1/2 是"不修就
 *   可能放行不合法输入"的 Contract 缺口，Finding 3 是"已经承诺的不
 *   可变约定没有运行时兜底"，严重度本身评级 LOW，且评审当时
 *   TemporalEngine 还没有任何真实调用方，"多个模块共享同一个 schedule
 *   引用"这个风险还没实际发生，按 Progression Rule 不必抢在真实需要
 *   出现前动手），所以没有跟 Finding 1/2 一起在 2026-07-13 那次补丁
 *   里改，完整过程见 00_ADR_004_Temporal_Engine_Design.gs 对应条目。
 *   这次审计报告重新独立点名同一个问题，评估后确认架构评审当时的结论
 *   依然成立（"一行、对现有测试零影响"），予以采纳，从 Fix Later 提升
 *   为 Fix Now，详细的"为什么现在提升"理由见 ADR-004「2026-07-15
 *   修订记录」，不在这里重复。
 *   修复：parseRule 返回前 Object.freeze(schedule)。sloppy mode（GAS
 *   默认运行时、Node 沙盒 eval 这份文件时也是）下对冻结对象赋值会
 *   静默失败、不抛错，不会让现有调用方意外收到新异常。
 *
 * === 2026-07-15 GAS Console 实测问题（不在审计报告里，是部署后手动跑
 * checkOffsetReminders/runReminderOffsetEngineTests/checkReminders 三个
 * 入口时从 Execution log 里发现的）===
 *
 * 问题A（21_SheetUtils.gs parseDueDate_，TypeError:
 * raw.match is not a function）
 *   核实：属实，且是这次新增的 26_ReminderOffsetEngine.gs 暴露出的
 *   既有假设漏洞，不是 OffsetEngine 自己的新 bug。parseDueDate_ 假设
 *   raw 一定是字符串，直接调 raw.match(...)——但 Google Sheets 对
 *   日期/日期时间格式的单元格，getValues() 会直接返回原生 Date 对象。
 *   25_ReminderEngine.gs 的 isOverdue_ 一直是安全的，因为它在调用这里
 *   之前先 String(dueDateRaw) 过；但 26_ReminderOffsetEngine.gs 的
 *   _resolveEffectiveDueDatetime_ 是把 task.due_datetime/task.due_date
 *   直接传进来，不经过这层转换——两个调用方的调用约定本身就不一致，
 *   parseDueDate_ 之前没出过问题只是因为唯一的调用方（isOverdue_）
 *   恰好总是先转字符串，不是因为这个函数本身是安全的。
 *   修复：parseDueDate_ 加一个 Date 类型直接返回的分支（拷贝一份，不
 *   回传调用方传入的原始引用），非 Date 的输入才按原逻辑走字符串
 *   解析。按"任意 Sheet 单元格原始值的实际形状"把这个共用函数本身
 *   加固，不是只在 _resolveEffectiveDueDatetime_ 调用前补一个
 *   String() 转换来绕过——后者只能保证这一个调用方不出问题，前者能
 *   保证以后任何直接传 Date 对象进来的新调用方都不出问题。用原始报错
 *   堆栈的场景（task.due_date 是原生 Date 对象、没有
 *   due_datetime/due_time）复现过，确认改完不再抛错。
 *
 * 问题B（5_Testing/50_ReminderOffsetEngine_Tests.gs resetAll，
 * ReferenceError: global is not defined）
 *   核实：属实，但根因不是"忘了兼容 GAS 环境"，是这份测试套件设计上就
 *   只能通过 Node 沙盒（run_offset_tests.js + mocks.js）运行——见文件
 *   头部说明——被直接贴进 Apps Script 编辑器手动运行了。即使把
 *   resetAll 里的 global 换成某个 GAS 侧的等价写法，紧接着
 *   __resetStore/__seedSheet 等 mock 函数依然不存在（整套 mock 只
 *   存在于 mocks.js，从未被加载进 GAS 项目），不是换一个全局对象名字
 *   能解决的。
 *   处理方式（不是"让它能在GAS里跑"，是"给清楚的报错，别再让人在深埋
 *   的地方撞见一个指向不明的 ReferenceError"）：
 *   runReminderOffsetEngineTests 开头新增环境检测，检测不到 Node 沙盒
 *   特征（global 或 global.__resetStore）时，直接 throw 一个说明"这
 *   份套件只能通过 node run_offset_tests.js 运行"的 Error，Logger.log
 *   同步输出。
 *
 * 问题C（4_Integration/40_Output.gs sendMessage，调用方日志打出
 * "error=undefined"）
 *   核实：属实。Telegram API 返回业务级失败（body.ok===false，比如
 *   "Bad Request: chat not found"）时，sendMessage 原来是直接 return
 *   body——也就是原样转发 Telegram 的失败响应，用的是
 *   error_code/description 两个字段。但同一个函数其余三条失败路径
 *   （缺 token/缺 chat_id/catch块）统一用的是 {ok:false, error:'...'}
 *   形状。25_ReminderEngine.gs 的 checkReminders、
 *   26_ReminderOffsetEngine.gs 的 checkOffsetReminders 读的都是
 *   sendResult.error，对 Telegram 业务级失败这条最常见的路径来说永远
 *   是 undefined——不是日志拼接的字符串写错了，是从一开始这个分支的
 *   返回值就没有这个字段。
 *   修复：这个分支 return 之前补一个 error 字段（优先取
 *   description，没有的话退化成 error_code），不删除原始的
 *   error_code/description（不丢信息，只是补齐调用方依赖的统一字段）。
 *
 * === 第五轮验证方式 ===
 *
 * 4个 Node 沙盒测试套件（run_sheetutils_tests.js/run_eventbus_tests.js/
 * run_output_tests.js/run_offset_tests.js，可以用新增的
 * run_all_tests.js 一次性全部跑）+ 1个 GAS 原生套件
 * （50_TemporalEngine_Tests.gs，设计上贴进 GAS 编辑器直接跑，这次改动
 * 后额外在 Node 里补跑一次 Logger mock 版本做二次确认），全部通过，共
 * 115 个断言（TemporalEngine 45 + SheetUtils 18 + EventBus 12 +
 * Output 8 + OffsetEngine 32）：
 *   - TemporalEngine：原有43个断言 + 新增2个（Object.isFrozen 直接
 *     验证、对冻结对象赋值静默失败不生效）。
 *   - OffsetEngine：原有28个断言 + 新增4个（场景F：到期时间改早、且
 *     改早前该 channel 已经 resolve 过，验证不再被误判为已处理；场景F
 *     对照组：紧接着不改期再poll一次，确认没有连带破坏"没改期就不
 *     重发"这个基本幂等性）。
 *   - SheetUtils（全新，此前完全没有专属测试文件）：18个断言，覆盖
 *     parseDueDate_ 的 Date 对象兼容（含"不应该抛错"和"返回值是拷贝
 *     不是同一个引用"两层）、batchReadFieldsByKey_ 用故意不连续的
 *     命中行验证包络读取不会读串数据、batchDeleteRowsByKey_ 用故意
 *     跳着删的行验证降序删除不会因为行号错位而删错行。
 *   - EventBus（全新）：12个断言，验证 publishBatch 改成 appendRow
 *     循环之后基本正确性不受影响（数据映射、顺序、连续两次调用不互相
 *     覆盖、identity 去重继续生效）——注意"改了之后并发场景真的不会
 *     丢数据"这件事本身不是单元测试能验证的，这里验证的是重写没有
 *     引入基本正确性回归，不是验证了并发安全性本身。
 *   - Output（全新）：8个断言，直接复现"error=undefined"这个具体
 *     报错场景并验证修复后 error 字段正确。
 *   顺手发现并修复 run_offset_tests.js 里硬编码的4个文件路径是上一次
 *   会话沙盒的绝对路径（/home/claude/work/output/*.gs），换个环境就
 *   读不到文件，本身是这套测试基础设施的一个可移植性 bug——改成相对
 *   本文件自身所在目录动态拼接。
 *
 * === 第五轮后果 ===
 *
 * - 1_Foundation/12_TemporalEngine.gs：parseRule 返回前新增
 *   Object.freeze(schedule)。
 * - 2_Runtime/20_EventBus.gs：publishBatch 内部实现从
 *   getLastRow()+setValues() 改成逐行 appendRow()，对外行为/签名不变。
 * - 2_Runtime/21_SheetUtils.gs：parseDueDate_ 新增 Date 类型兼容分支；
 *   batchReadFieldsByKey_ 内部实现改成包络 getValues()+内存查找，对外
 *   行为/签名不变；新增 batchDeleteRowsByKey_。对外暴露函数数量从13个
 *   增加到14个。
 * - 2_Runtime/25_ReminderEngine.gs：checkReminders 的 LockService
 *   调用点新增注释说明 HIGH RISK 4 的评估过程，逻辑本身未改。
 * - 2_Runtime/26_ReminderOffsetEngine.gs：checkOffsetReminders 的
 *   resolved_fire_ats 语义变更（存到期时间快照而非fireAt）；
 *   ruleDeletes/occurrenceDeleteKeys 改用批量删除；LockService 调用点
 *   新增 HIGH RISK 4 评估注释。
 * - 4_Integration/40_Output.gs：sendMessage 在 Telegram 业务级失败
 *   分支新增 error 字段补齐，不改变其余返回结构。
 * - 5_Testing/：新增 50_SheetUtils_Tests.gs/50_EventBus_Tests.gs/
 *   50_Output_Tests.gs 三份此前完全没有覆盖的测试文件（范围只覆盖这次
 *   改到的函数，不是这三个源文件的全量覆盖，各自文件头有说明）；
 *   50_ReminderOffsetEngine_Tests.gs 新增场景F；
 *   50_TemporalEngine_Tests.gs 新增2个断言。run_offset_tests.js 路径
 *   可移植性修复；新增 run_sheetutils_tests.js/run_eventbus_tests.js/
 *   run_output_tests.js/run_all_tests.js。
 * - HIGH RISK 4（跨项目 LockService 不生效）没有被"修复"，只是被更
 *   清楚地"文档化"——这是本轮6项里唯一一条本质上无法在 Reminder OS
 *   单个项目内解决的，如实记录在 00_Project_State.gs「已知问题」，不
 *   假装已经修好，跟第一轮 MEDIUM RISK 1（webhook 依赖）、第四轮
 *   MEDIUM RISK 2（Telegram送达状态不确定）是同一类处理方式。
 * - ⚠️ 已知文档缺口（不是这轮修复的一部分，如实记录）：
 *   00_File_Map.gs/00_Project_State.gs 在这轮之前就已经不包含 Offset
 *   Reminder Engine（2_Runtime/26_ReminderOffsetEngine.gs）的完整设计
 *   历史——该功能是在第四轮（2026-07-10/11）之后、这次审计
 *   （2026-07-15）之前新增的，经过多轮设计精化，但那个过程没有被记录
 *   进这两份文件。这次只在 File Map 里为该文件和它的测试文件补了
 *   【最小占位记录】（标注了"非完整设计历史"），没有尝试回填完整的
 *   设计过程——那需要重新过一遍设计文档和历次精化的完整上下文，不是
 *   这次审计修复顺手能做的事，建议单独排一次任务处理。
 */
