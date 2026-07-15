/**
 * 25_ReminderEngine.gs   [原 92_ReminderEngine.gs — 2026-07-06 按 Domain OS
 * Blueprint 迁入 2_Runtime/。承担 Decision（_shouldRemind/_isOverdue）+
 * Execution（checkReminders/_buildReminder/_sendReminder）两种角色，
 * 另外会触发 Runtime/Event（EventBus.publishBatch，2026-07-10前是逐条
 * publish，见第四轮 HIGH RISK 1）和 Runtime/Projection
 * （SheetUtils.batchUpdateFieldsByKey_，2026-07-10前是
 * batchUpsertRowsByKey_，见第四轮 MEDIUM RISK 1）。这是本项目的核心域
 * 引擎，不拆成多个文件——原因见 00_ADR_001_Domain_OS_Blueprint_Adoption.txt。]
 *
 * 🐛 2026-07-06 第一轮外部审计修复（HIGH RISK 1/2、MEDIUM RISK 2、
 * LOW RISK 1，核实属实后采纳，完整决策依据见
 * 00_ADR_002_ReminderEngine_Audit_Fixes.txt）：
 * 1. HIGH RISK 1：checkReminders 循环里之前每提醒一个任务就立刻调
 *    upsertRowByKey_（O(N) 次全表扫描式 Sheet I/O）。改成循环里只更新
 *    内存、收集需要落盘的任务，循环结束后批量写回。
 *    ⚠️ 这个批量写回的设计后来在第二轮审计被发现有新问题，见下方
 *    「第二轮外部审计修复」HIGH RISK 1。
 * 2. HIGH RISK 2：_sendReminder 之间加 Utilities.sleep(1000)，避免撞
 *    Telegram 限流。
 * 3. MEDIUM RISK 2：全部逻辑和常量包进 IIFE（ReminderEngine 模块），
 *    只留 checkReminders 一个全局薄封装供 GAS 触发器绑定（触发器按字符串
 *    名字找全局函数，绑定不到 IIFE 属性）。
 * 4. LOW RISK 1：lock.waitLock 从 5000ms 延长到 30000ms。
 *
 * 🐛 2026-07-06 第二轮外部审计修复（HIGH RISK 1/2、LOW RISK 1 关联，
 * 核实属实后采纳，完整决策依据见
 * 00_ADR_002_ReminderEngine_Audit_Fixes.txt 文末补充记录）：
 * 1. HIGH RISK 1（新）：第一轮把 Sheet 写入挪到循环结束后一次性批量写，
 *    解决了 O(N) I/O 问题，但引入了新风险——如果发送数量多、
 *    Utilities.sleep 节流累积耗时长，checkReminders 有可能撞上 GAS 6
 *    分钟执行硬上限被强制终止，此时循环外的批量写入永远不会执行，
 *    已经发出去的 Telegram 消息的状态（reminder_count/last_reminder_at）
 *    完全没有落盘，下一次触发器会重复提醒。
 *    修复：加入时间预算机制（EXECUTION_TIME_BUDGET_MS），循环内每次
 *    处理前检查已耗时，接近上限就提前中断循环——但中断之后仍然立即执行
 *    已处理任务的批量写入，不会因为提前中断就跳过落盘。剩余未处理任务
 *    留给下一次触发器，这是安全、正确的行为（这些任务本来就还没发送，
 *    下次再判断一次不是 bug）。
 * 2. HIGH RISK 2（新）：Output.sendMessage 遇到 Telegram API 报错/网络
 *    异常时会返回 {ok:false,...} 而不是 throw，但 _sendReminder 之前
 *    直接丢弃了这个返回值，导致哪怕消息实际发送失败（用户封锁了 Bot、
 *    chat_id 失效、token 异常等），系统依然会照常累加 reminder_count、
 *    误以为已经送达，造成静默丢失且不会重试。
 *    修复：_sendReminder 改为返回 Output.sendMessage 的结果；
 *    checkReminders 只有在 sendResult.ok 为真时才调用
 *    _recordReminderSent、才把任务收进批量写入列表——发送失败的任务
 *    完全不改状态，下次触发器会正常重试。
 * 3. 顺带加固：循环内每个任务的处理包了一层 try/catch，单个任务处理
 *    异常（比如某条脏数据导致 _buildReminder 抛错）不会拖垮整批已经
 *    处理成功、还没来得及批量写入的任务。这不是这轮审计直接点名的问题，
 *    是跟上面两条一起重构这段循环时顺手加固的，跟"时间预算提前中断也要
 *    保证已处理的落盘"是同一个"部分失败不能让已成功的也陪葬"的思路。
 *
 * ⚠️ 关联但没有在这个文件改的项（第二轮审计还提到但不在这里）：
 * SheetUtils 的函数调用从这轮起改成 SheetUtils.xxx 的命名空间形式（原来
 * 是裸调用 isOverdue_/parseDueDate_/batchUpsertRowsByKey_），因为
 * 21_SheetUtils.gs 这次也包进了 IIFE（第二轮审计 LOW RISK 1），完整
 * 说明见 21_SheetUtils.gs 自己的文件头。
 *
 * 🐛 2026-07-06 第三轮外部审计修复（HIGH RISK 1新、MEDIUM RISK 3，核实
 * 属实后采纳，完整决策依据见 00_ADR_002_ReminderEngine_Audit_Fixes.gs
 * 文末补充记录）：
 * 1. HIGH RISK 1（新）：第二轮把批量写延后到循环结束才做一次，但如果
 *    这一次 batchUpsertRowsByKey_ 本身失败（网络异常/Sheets服务暂时
 *    不可用/配额超限），这一整次执行期间已经发出去的全部提醒都不会
 *    落盘，下次触发器会整批重发。改成分批写（每凑够20个就写一次，见
 *    _persistBatch/BATCH_WRITE_CHUNK_SIZE），把单点写入失败的影响范围
 *    从"整次执行"缩小到"最多这一批"；每批失败会重试一次，重试仍失败
 *    则记录清楚哪些 task_id 受影响，不让异常继续往上抛、拖累后续任务。
 * 2. MEDIUM RISK 3：lock.waitLock(30000) 拿不到锁时，之前是直接放弃、
 *    干等下一个整点触发器，最坏情况会让本该发送的提醒晚整整一小时。
 *    改成安排一次性的5分钟后延迟重试（_scheduleRetryOnce），用 Script
 *    Property 防止同一时间段内重复排队多个重试。只重试一次，不做无限
 *    链式重试。
 * ⚠️ 这轮审计另外两条（MEDIUM RISK: 11_Setup.gs 的 JSON.parse 未捕获；
 * LOW RISK: 40_Output.gs 缺 UrlFetchApp 超时参数）核实后发现跟实际代码
 * 不符，没有改动，理由见 00_Project_State.gs「已知问题」。
 *
 * 🐛 2026-07-10 第四轮外部审计修复（HIGH RISK 1/2/3、MEDIUM RISK 1，核实
 * 属实后采纳，完整决策依据见 00_ADR_002_ReminderEngine_Audit_Fixes.txt
 * 「第四轮」）：
 * 1. HIGH RISK 1（新）：checkReminders 循环里每发送成功一条提醒，就立刻
 *    调 _recordReminderSent → EventBus.publish → 同步 appendRow 写一行
 *    到 Events 表——Tasks 表那条线第一轮就批量化了，但 Events 这条线
 *    一直没有跟着改，是本该一起做但当时没做的遗漏。改成 _recordReminderSent
 *    只把事件草稿塞进内存数组 pendingEvents，不再直接调 EventBus.publish；
 *    checkReminders 跟 Tasks 批量写用同一套分批节奏（凑够
 *    BATCH_WRITE_CHUNK_SIZE 或循环结束）调 EventBus.publishBatch() 一次性
 *    写入多行。副作用（有意为之，不是疏漏）：以前 EventBus.publish 抛错
 *    会连带导致这条任务的 Tasks 状态也不落盘（两者耦合在同一个函数调用
 *    里）；现在两者解耦——Events 是"尽力而为的审计记录"（这是
 *    20_EventBus.gs 文件头自己的定位），不应该拖累"reminder_count/
 *    last_reminder_at 有没有正确落盘"这个功能上更关键的状态，完整理由见
 *    _publishPendingEvents 的注释。
 * 2. HIGH RISK 2（新）：_scheduleRetryOnce 建的一次性重试 trigger，执行完
 *    之后不会自动从 ScriptApp.getProjectTriggers() 消失，需要显式删除，
 *    否则会持续累积、逼近单项目最多20个已安装 trigger 的硬配额，导致
 *    包括正常的每小时 checkReminders 在内的所有 trigger 都无法创建。
 *    改成 _scheduleRetry_ 创建 trigger 时把返回的 uniqueId 存进
 *    Script Property；新增 _cleanupStaleRetryTrigger_，在 checkReminders
 *    最开头无条件调用，删掉上一次留下的 trigger。
 * 3. HIGH RISK 3（新）：EXECUTION_TIME_BUDGET_MS 的检查只发生在每次处理
 *    任务【之前】，但 UrlFetchApp.fetch 没有可配置超时，最坏情况单次调用
 *    能卡住约60秒（第三轮已查证，GAS 平台限制）——如果检查通过之后才
 *    进入的这一条任务恰好撞上最坏情况，单次循环迭代本身就可能把总耗时
 *    推过6分钟硬上限，进程被 GAS 强制终止，此时已经发出去但还没来得及
 *    批量写入的任务状态会彻底丢失。改成显式按"硬上限 − 最坏情况单任务
 *    耗时 − 安全垫"重新推导 EXECUTION_TIME_BUDGET_MS（不是简单改小一个
 *    数字），并把 BATCH_WRITE_CHUNK_SIZE 从20降到5，缩小"已发送但未
 *    持久化"的风险窗口——这一步能做到（而不是继续保持20不变），是因为
 *    同一轮里 MEDIUM RISK 1 把持久化本身的成本大幅降低了，更频繁地
 *    持久化不再意味着更频繁的整表读写。完整推导见下方
 *    EXECUTION_TIME_BUDGET_MS 的注释。这个风险只能缓解、不能消除——
 *    GAS 平台本身不提供配置 UrlFetchApp 超时的手段。
 * 4. MEDIUM RISK 1：_persistBatch 之前调 SheetUtils.batchUpsertRowsByKey_，
 *    每次调用都整表读+整表写，成本随 Tasks 表总行数增长，而不是随本批
 *    实际改动的行数增长——5批×100条更新会把整张表重复读写5次。改成调
 *    新增的 SheetUtils.batchUpdateFieldsByKey_（只读 key 列定位行号、
 *    只对实际改动的字段做定点 setValue()），完整理由（包括为什么没有
 *    简单地"整个执行只读写一次"）见 21_SheetUtils.gs 文件头。
 * ⚠️ 这轮审计另外两条：
 *  - MEDIUM RISK 2（_sendReminder 网络抖动导致的偶发重复发送）：核实
 *    属实，但 UrlFetchApp 和 Telegram Bot API 都不提供区分"没发出去"
 *    和"发出去了但响应丢失"的手段，也没有幂等键机制，没有办法在代码层面
 *    真正修复，按审计建议本身的方向在业务层面接受，只在 40_Output.gs
 *    加了诊断标记，理由见那边文件头和 00_Project_State.gs「已知问题」。
 *  - LOW RISK 1（00_Project_Constitution.gs 对 Tasks 表结构强耦合，
 *    建议抽象层）：核实后发现不是新问题——00_Project_Constitution.gs
 *    的 P1 已经明确记录了不同的、经过深思的方案（新 Domain OS 接入时
 *    "加一段查询逻辑"，不是"抽象一层通用接口"），这次审计建议的做法
 *    跟既有架构决定相反。按 00_ADR_003...里的 Progression Rule（不为
 *    还没出现的真实需求预先设计），维持 P1 现状，不引入抽象层，详见
 *    00_ADR_002_ReminderEngine_Audit_Fixes.txt「第四轮」。
 *
 * Reminder OS v1.0（原 JARVIS CORE v2.0 — Phase 1, Module 2）
 *
 * 全部任务的统一提醒系统。不允许存在第二套提醒逻辑。
 *
 * ⚠️ 2026-07-03 拆分说明：Reminder OS 现在是独立项目，定位是"全平台共享
 * 的时间与通知服务"（见 Personal AI Core 项目 00_Project_Constitution.gs
 * 的 D2/D5）——不是 Productivity OS 专属，未来 Property/Finance/Vehicle
 * OS 的到期提醒也会用这一套，不会各自重复造轮子。
 * 拆分时只有两处因为依赖的函数换了地方而不得不改，判断逻辑本身当时逐字
 * 未动。
 *
 * ✅ 2026-07-06（早些时候）：_shouldRemind 的判断逻辑 HIGH RISK 2
 * （缺少 due_date 临近性判断，注意这是【最早那一轮】审计的编号，跟上面
 * 两轮 ReminderEngine/EventBus 审计的 HIGH RISK 1/2 是三件不同的事，
 * 编号都撞了，务必对照日期和 ADR 编号，不要只看"HIGH RISK N"这个标签）
 * 已修复，见 00_Project_State.txt「已完成」。REMINDER_INTERVAL_HOURS
 * 数值本身未变。
 *
 * due_date 字段两种格式：
 *   'YYYY-MM-DD'  → 日期类，直接判断是否过期，也能算距今多久
 *   '40000km'     → 里程类（保养用），暂时无法判断是否过期/距今多久
 *                    （需要 Rider OS 当前里程数据，等 RiderConnector 接好）
 */

var ReminderEngine = (function () {

  var REMINDER_INTERVAL_HOURS = {
    CRITICAL: 4,
    HIGH: 6,
    MEDIUM: 12,
    LOW: 24,
    OVERDUE: 24 // R4: 逾期强制每24小时重复，不管原本优先级
  };

  // 未逾期时，距 due_date 还剩多久（小时）才允许开始提醒，默认72小时/
  // 3天，可调整，不影响下面的判断逻辑。
  var REMINDER_ADVANCE_HOURS = 72;

  // Telegram 单聊限流是每秒最多1条消息，本项目的提醒几乎都发到同一个
  // chat_id，所以每发一条就等这么久，用固定1秒节流，不做更复杂的
  // per-chat/全局分别限流（P6，多用户/多chat场景真的出现了再升级——
  // 第二轮审计 LOW RISK 2 也提到这点，评估后维持现状，见
  // 00_Project_State.txt「已知问题」的说明）。
  var TELEGRAM_SEND_THROTTLE_MS = 1000;

  // lock.waitLock 的等待上限。HIGH RISK 2 的节流会让单次 checkReminders
  // 正常耗时变长，等待太短容易让下一小时触发器误判"前一个没跑完"而
  // 整段跳过。
  var LOCK_WAIT_MS = 30000;

  // 🐛 第二轮 bugfix（2026-07-06，HIGH RISK 1）：单次 checkReminders 的
  // 时间预算上限。GAS 单次执行硬上限是6分钟。
  //
  // 🐛 第四轮 bugfix（2026-07-10，HIGH RISK 3新，核实属实后采纳）：原来
  // 直接写死"5分钟，留1分钟余量"，但循环里的时间预算检查只发生在【每次
  // 处理任务之前】——检查通过之后才进入的这一条任务，处理过程本身
  // （尤其是 Output.sendMessage 里的 UrlFetchApp.fetch）可能耗时很久，
  // 这段耗时不受预算检查约束。UrlFetchApp 没有可配置超时，最坏情况单次
  // 调用可能卡住约60秒（第三轮已查证，GAS 平台限制，见下方"已知限制"）。
  // 也就是说哪怕预算检查那一刻显示"还有1分钟余量"，只要接下来这一条
  // 任务恰好撞上最坏情况，单次迭代自己就可能吃掉超过1分钟，把总耗时
  // 推过6分钟硬上限——进程被强制终止，已发送但还没批量写入的状态会
  // 彻底丢失。改成显式从"硬上限 − 最坏情况单任务耗时 − 安全垫"倒推预算，
  // 而不是直接调整一个数字：
  //   最坏情况单任务耗时 = UrlFetchApp 最坏情况(~60秒)
  //                       + 固定节流(TELEGRAM_SEND_THROTTLE_MS)
  //                       + 批量持久化/单次重试的余量(~10秒，第四轮
  //                         MEDIUM RISK 1 之后持久化成本已经big大幅降低，
  //                         这里仍然保守估计)
  //   额外安全垫 = 20秒，覆盖 GAS 自身触发调度/收尾（比如 finally 里的
  //                lock.releaseLock()）的不确定开销
  // 这样算出来预算比原来的"5分钟"更保守（约4分29秒），预留的余量明确
  // 对应"接下来最坏还能再发生什么"，而不是一个凭感觉留出来的整数。
  //
  // ⚠️ 已知限制：这个改动只能【缩小】风险窗口，不能【消除】——GAS 平台
  // 本身不提供配置/缩短 UrlFetchApp 超时的手段，也没有办法在预算检查
  // 时预知"下一条任务会不会恰好撞上60秒最坏情况"。配合 BATCH_WRITE_
  // CHUNK_SIZE 下调（见下方），把"万一真的被强制终止"时可能丢失状态的
  // 任务数量也一起降到最多几条，是这轮能做到的合理程度的缓解。
  var HARD_EXECUTION_LIMIT_MS = 6 * 60 * 1000; // GAS 时间触发器执行硬上限，平台常量，不可配置
  var WORST_CASE_SINGLE_TASK_MS = 60 * 1000 + TELEGRAM_SEND_THROTTLE_MS + 10 * 1000;
  var EXTRA_SAFETY_MARGIN_MS = 20 * 1000;
  var EXECUTION_TIME_BUDGET_MS = HARD_EXECUTION_LIMIT_MS - WORST_CASE_SINGLE_TASK_MS - EXTRA_SAFETY_MARGIN_MS;

  // 🐛 第三轮 bugfix（2026-07-06，MEDIUM RISK 3）：拿不到锁时，不再干等
  // 下一个整点触发器（最坏情况会晚整整一小时），改成安排一次性的延迟
  // 重试。
  //
  // 🐛 第四轮 bugfix（2026-07-10，LOW RISK 2，核实属实后采纳）：
  // RETRY_FLAG_KEY 原来存的是一个时间戳字符串，纯粹当布尔标记用，且只有
  // 【成功拿到锁】之后才会清掉。这会导致一种场景失效：第一次重试（5分钟
  // 后）如果本身也遇到锁竞争（比如前一个实例跑得比预期久），会再次走进
  // "拿不到锁"的分支，此时标记还在（因为这次也没能成功拿到锁去清掉它），
  // 于是被当成"已经排过重试了"直接放弃，不会安排第二次重试——变成要等
  // 下一个整点触发器，最坏延迟接近整整一小时，重试机制在这种场景下形同
  // 虚设。改成计数器（RETRY_COUNT_KEY），上限 MAX_RETRY_ATTEMPTS 次，
  // 只在成功拿到锁之后才清零；同时 RETRY_FLAG_KEY 改为存这次创建的
  // trigger 的 uniqueId（不再是时间戳），配合 HIGH RISK 2 的
  // _cleanupStaleRetryTrigger_ 使用。没有改成"无限重试直到成功"——那样
  // 会失去锁竞争约束原本要防的东西（同一个函数的执行互相越叠越多），
  // 有限次数的放宽是折中，不是彻底解决。
  var RETRY_FLAG_KEY = 'REMINDER_ENGINE_RETRY_TRIGGER_ID'; // 存 trigger uniqueId，见 _scheduleRetry_
  var RETRY_COUNT_KEY = 'REMINDER_ENGINE_RETRY_COUNT';
  var RETRY_DELAY_MINUTES = 5;
  var MAX_RETRY_ATTEMPTS = 2;

  // 🐛 第三轮 bugfix（2026-07-06，HIGH RISK 1新）：批量写不再等循环整个
  // 结束才做一次——那样如果最后这一次批量写入本身失败（网络异常/Sheets
  // 服务暂时不可用/配额超限/锁死），会导致这一整次执行期间已经发出去的
  // 全部提醒都没有落盘状态，下次触发器整批重发。改成每凑够
  // BATCH_WRITE_CHUNK_SIZE 个就写一次，把"单点写入失败"的影响范围从
  // "整次执行"缩小到"最多这一批"。
  //
  // 🐛 第四轮 bugfix（2026-07-10，HIGH RISK 3新关联，核实属实后采纳）：
  // 从20下调到5，进一步缩小"已发送但未持久化"的风险窗口（配合上面
  // EXECUTION_TIME_BUDGET_MS 的调整，两者是同一个 HIGH RISK 3 问题的
  // 两个互补缓解手段）。第三轮定20的时候，_persistBatch 调的是
  // batchUpsertRowsByKey_，每次调用成本正比于 Tasks 表总行数——调小
  // chunk size 会让"整表读写"的次数变多，是不划算的。这次
  // MEDIUM RISK 1 把持久化换成了 batchUpdateFieldsByKey_（成本正比于
  // 本批大小，不是表总行数，见 21_SheetUtils.gs），更频繁地持久化不再
  // 意味着更频繁的整表读写，才有空间把 chunk size 调小。没有调到1
  // （每发一条就立刻持久化）：batchUpdateFieldsByKey_ 仍然需要读一次
  // key 列来定位行号，调到1会让"读 key 列"这个动作重复次数从"批数"
  // 变成"发送条数"，在提醒条数很多的场景下会白白多付出这部分开销；5是
  // 一个折中——明显收窄风险窗口，同时没有让持久化调用次数增长到跟
  // 发送条数一样多。
  var BATCH_WRITE_CHUNK_SIZE = 5;

  /**
   * 🐛 第三轮 bugfix（2026-07-06，HIGH RISK 1新，核实属实后采纳）：把
   * 批量写封装成独立函数，失败时重试一次，重试仍失败就记录清楚哪些
   * task_id 的状态没能落盘（发出去的提醒可能会在下次触发器重发），但
   * 不把异常继续往上抛——一批写失败不应该拖累循环里后续还没处理的任务，
   * 也不应该让整个 checkReminders 直接崩掉。
   *
   * 🐛 第四轮 bugfix（2026-07-10，MEDIUM RISK 1，核实属实后采纳）：改调
   * SheetUtils.batchUpdateFieldsByKey_ 而不是 batchUpsertRowsByKey_，
   * 完整理由见 21_SheetUtils.gs 文件头。这里只需要多处理一种新情况：
   * notFound——理论上不应该发生（task_id 是几分钟前 QueryEngine.
   * getPendingTasks() 刚读出来的，几分钟后在同一张表里应该还在），如果
   * 真的出现，值得留一条日志，不能静默吞掉，但也不应该让整批持久化
   * 因此失败——用日志记录，不 throw。
   */
  function _persistBatch(tasksToWrite) {
    if (!tasksToWrite || tasksToWrite.length === 0) return;
    var payload = tasksToWrite.map(function (t) {
      return {
        task_id: t.task_id,
        reminder_count: t.reminder_count,
        last_reminder_at: t.last_reminder_at
      };
    });
    try {
      var result = SheetUtils.batchUpdateFieldsByKey_('Tasks', 'task_id', payload);
      if (result && result.notFound && result.notFound.length > 0) {
        Logger.log('[ReminderEngine] ⚠️ 以下 task_id 在 Tasks 表里找不到对应行（可能被并发' +
          '删除/改动），提醒已发出但状态未落盘: ' + result.notFound.join(','));
      }
    } catch (e) {
      Logger.log('[ReminderEngine] 批量写入失败，5秒后重试一次: ' + e.message);
      try {
        Utilities.sleep(5000);
        SheetUtils.batchUpdateFieldsByKey_('Tasks', 'task_id', payload);
      } catch (e2) {
        Logger.log('[ReminderEngine] ❌ 批量写入重试后仍然失败，以下 task_id 的提醒已发出但' +
          '状态未落盘，下次触发器可能重复提醒: ' +
          tasksToWrite.map(function (t) { return t.task_id; }).join(',') + ' — ' + e2.message);
      }
    }
  }

  /**
   * 🐛 第四轮 bugfix（2026-07-10，HIGH RISK 1新，核实属实后采纳）：跟
   * _persistBatch 并列的批量发布，取代循环内逐条调用 EventBus.publish。
   * 失败时只记日志、不重试、不往上抛——Events 是"尽力而为的审计记录"
   * （见 20_EventBus.gs 文件头对 Events 表用途的定位），不应该反过来
   * 影响 _persistBatch 那边已经成功落盘的 reminder_count/
   * last_reminder_at（那才是驱动"还要不要提醒"判断的功能性状态）。这
   * 两个函数在 checkReminders 里的调用顺序是先 _persistBatch 再
   * _publishPendingEvents，就是为了保证哪怕 Events 这边真的失败，
   * 功能性状态已经先一步安全落盘。
   */
  function _publishPendingEvents(pendingEvents) {
    if (!pendingEvents || pendingEvents.length === 0) return;
    try {
      EventBus.publishBatch(pendingEvents);
    } catch (e) {
      Logger.log('[ReminderEngine] ⚠️ Events 审计记录批量写入失败（不影响 Tasks 状态，已经' +
        '落盘的 reminder_count/last_reminder_at 不会因此回滚）: ' + e.message);
    }
  }

  /**
   * 🐛 第四轮 bugfix（2026-07-10，HIGH RISK 2，核实属实后采纳）：删掉
   * _scheduleRetry_ 建的那个一次性重试 trigger。GAS 的一次性 trigger
   * （.after() 创建）执行完之后不会自动从 ScriptApp.getProjectTriggers()
   * 消失，需要显式 deleteTrigger，否则会持续累积，逼近单项目最多20个
   * 已安装 trigger 的硬配额（这是 GAS 平台公开、被广泛报告的行为，处理
   * 这类"续跑" trigger 的通用做法就是在下一次运行开始时显式删除旧的，
   * 不是本项目特有的 bug，也不是猜测）。
   *
   * 无条件放在 checkReminders 最开头调用——不管这次执行本身是不是由
   * 重试 trigger 触发的，也不管这次执行最终会不会成功拿到锁。这样即使
   * 出现"重试 trigger 触发后，这次恰好又没能拿到锁"（LOW RISK 2 描述的
   * 场景）的情况，那个已经完成使命的 trigger 也会在它触发的这次执行里
   * 被清理掉，不会因为这次也没拿到锁就被漏掉、继续累积。
   *
   * deleteTrigger 包了 try/catch：如果 trigger 已经不存在了，忽略即可，
   * 不应该让 checkReminders 因为清理一个早就该消失的 trigger 而报错
   * 中断正常流程。
   */
  function _cleanupStaleRetryTrigger_() {
    var props = PropertiesService.getScriptProperties();
    var triggerId = props.getProperty(RETRY_FLAG_KEY);
    if (!triggerId) return;

    try {
      var triggers = ScriptApp.getProjectTriggers();
      for (var i = 0; i < triggers.length; i++) {
        if (triggers[i].getUniqueId() === triggerId) {
          ScriptApp.deleteTrigger(triggers[i]);
          Logger.log('[ReminderEngine] 清理了一个已完成使命的一次性重试 trigger: ' + triggerId);
          break;
        }
      }
    } catch (e) {
      Logger.log('[ReminderEngine] 清理重试 trigger 时出错（忽略，不影响本次执行）: ' + e.message);
    }
    props.deleteProperty(RETRY_FLAG_KEY);
  }

  /**
   * 🐛 第三轮 bugfix（2026-07-06，MEDIUM RISK 3，核实属实后采纳）：拿不到
   * 锁时安排一次性延迟重试，而不是干等下一个整点。
   *
   * 🐛 第四轮 bugfix（2026-07-10，LOW RISK 2/HIGH RISK 2，核实属实后
   * 采纳）：从"布尔标记、只重试1次"改成"计数器、最多重试
   * MAX_RETRY_ATTEMPTS 次"，完整原因见上方 RETRY_FLAG_KEY/RETRY_COUNT_KEY
   * 的注释。新建的 trigger 会把 uniqueId 存进 RETRY_FLAG_KEY，供
   * _cleanupStaleRetryTrigger_ 在下一次执行时清理。
   */
  function _scheduleRetry_() {
    var props = PropertiesService.getScriptProperties();
    var attemptCount = Number(props.getProperty(RETRY_COUNT_KEY) || '0');

    if (attemptCount >= MAX_RETRY_ATTEMPTS) {
      Logger.log('[ReminderEngine] 已经重试了 ' + attemptCount + ' 次仍拿不到锁，不再继续排队，' +
        '等下一个整点触发器');
      props.deleteProperty(RETRY_COUNT_KEY);
      return;
    }

    var trigger = ScriptApp.newTrigger('checkReminders')
      .timeBased()
      .after(RETRY_DELAY_MINUTES * 60 * 1000)
      .create();

    props.setProperty(RETRY_FLAG_KEY, trigger.getUniqueId());
    props.setProperty(RETRY_COUNT_KEY, String(attemptCount + 1));
    Logger.log('[ReminderEngine] 已安排第 ' + (attemptCount + 1) + ' 次重试，' +
      RETRY_DELAY_MINUTES + ' 分钟后');
  }

  /**
   * 🐛 第二轮 bugfix（2026-07-06，HIGH RISK 1/2，核实属实后采纳）：
   * 1. 时间预算：循环内每次处理前检查已耗时，接近 EXECUTION_TIME_BUDGET_MS
   *    就提前 break，但 break 之后依然执行批量写入——已处理的部分永远
   *    会落盘，不会因为提前中断就丢失状态。剩余未处理任务留给下一次
   *    触发器，这是安全的（它们本来就还没发送）。
   * 2. 发送结果校验：只有 Output.sendMessage 返回 {ok:true,...} 时才
   *    调 _recordReminderSent、才把任务加进批量写入列表。发送失败
   *    （网络异常/Telegram API 拒绝/token或chat_id无效）的任务完全不
   *    改状态，下次触发器会正常重新判断、重新尝试。
   * 3. 单任务 try/catch：某一条任务处理时抛异常，不影响其他任务的处理
   *    和已处理任务的批量落盘。
   *
   * 🐛 第三轮 bugfix（2026-07-06，HIGH RISK 1新/MEDIUM RISK 3，核实属实
   * 后采纳）：
   * 4. 拿不到锁时安排一次性延迟重试，不再干等下一个整点触发器；成功拿到
   *    锁后清掉重试计数（不管这次执行是不是重试触发的，只要正常跑起来
   *    了，就没有必要再保留"还有重试等着"这个状态）。
   * 5. 批量写改成分批，不再等循环整个结束才写一次——把"最后一次写入
   *    失败"的影响范围从"整次执行的全部任务"缩小到"最多这一批"。
   *
   * 🐛 第四轮 bugfix（2026-07-10，HIGH RISK 1/2/3、MEDIUM RISK 1，核实
   * 属实后采纳，完整决策依据见文件头和
   * 00_ADR_002_ReminderEngine_Audit_Fixes.txt「第四轮」）：
   * 6. 最开头无条件调 _cleanupStaleRetryTrigger_()，清理上一次重试留下的
   *    一次性 trigger（HIGH RISK 2）。
   * 7. 新增 pendingEvents，跟 pendingWrite 用同一套分批节奏——凑够
   *    BATCH_WRITE_CHUNK_SIZE 或循环结束时，先 _persistBatch（Tasks
   *    状态，功能性更关键）再 _publishPendingEvents（Events 审计记录，
   *    尽力而为）（HIGH RISK 1）。
   * 8. EXECUTION_TIME_BUDGET_MS 改成显式推导、BATCH_WRITE_CHUNK_SIZE
   *    从20降到5（HIGH RISK 3，完整推导见两个常量各自的注释）。
   * 9. _persistBatch 内部改调 SheetUtils.batchUpdateFieldsByKey_，不再是
   *    batchUpsertRowsByKey_（MEDIUM RISK 1，完整理由见 21_SheetUtils.gs）。
   */
  function checkReminders() {
    _cleanupStaleRetryTrigger_();

    // ⚠️ 范围说明（外部审计 HIGH RISK 4，2026-07-15 核实属实，评估后未在
    // 代码层面"修复"）：下面这把锁只保证本项目自己的 checkReminders 不会
    // 并发跑两次，不能阻止 Personal AI Core / Productivity OS 在本次
    // 执行期间并发写共享的 Tasks 表——LockService 不跨 standalone 项目
    // 生效，是平台限制。完整评估理由（两条审计建议的修法为什么都没有
    // 单方面实施）见 26_ReminderOffsetEngine.gs checkOffsetReminders 里
    // 对应位置的注释，这里是同一个结论，不重复展开。跟这条风险相关的
    // 既有缓解措施是 MEDIUM RISK 1 修复引入的
    // SheetUtils.batchUpdateFieldsByKey_（只对实际改动的字段做定点
    // setValue，不整行/整表覆写），见 21_SheetUtils.gs 文件头和
    // 00_ADR_002_ReminderEngine_Audit_Fixes.txt「第四轮」。
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(LOCK_WAIT_MS);
    } catch (e) {
      Logger.log('[ReminderEngine] 前序 checkReminders 实例尚未执行完毕，跳过本次执行');
      _scheduleRetry_();
      return { checked: 0, sent: 0 };
    }

    PropertiesService.getScriptProperties().deleteProperty(RETRY_COUNT_KEY);

    var startedAt = Date.now();
    try {
      var tasks = QueryEngine.getPendingTasks();
      var sentCount = 0;
      var failedCount = 0;
      var pendingWrite = [];  // 累积到 BATCH_WRITE_CHUNK_SIZE 就写一批，不是等到最后
      var pendingEvents = []; // 🐛 第四轮新增：Events 记录跟 pendingWrite 同步分批，见上方 7
      var timeBudgetExceeded = false;
      var processedCount = 0;

      for (var i = 0; i < tasks.length; i++) {
        if (Date.now() - startedAt > EXECUTION_TIME_BUDGET_MS) {
          timeBudgetExceeded = true;
          Logger.log('[ReminderEngine] 时间预算耗尽（' + processedCount + '/' + tasks.length +
            ' 已处理），提前中断循环，剩余任务留给下一次触发器');
          break;
        }
        processedCount++;

        var task = tasks[i];
        try {
          if (_shouldRemind(task)) {
            var message = _buildReminder(task);
            var sendResult = _sendReminder(task, message);

            if (sendResult && sendResult.ok) {
              _recordReminderSent(task, pendingEvents);
              pendingWrite.push(task);
              sentCount++;
            } else {
              failedCount++;
              Logger.log('[ReminderEngine] 发送失败，不更新状态，留待下次重试: task_id=' +
                task.task_id + ' error=' + (sendResult && sendResult.error) +
                (sendResult && sendResult.ambiguousDelivery ?
                  '（送达状态不确定，可能已实际送达，见 40_Output.gs 说明）' : ''));
            }

            Utilities.sleep(TELEGRAM_SEND_THROTTLE_MS); // 不管发送成功与否都要节流
          }
        } catch (taskErr) {
          Logger.log('[ReminderEngine] 处理单个任务时出错，跳过这一条，不影响其他任务: task_id=' +
            task.task_id + ' error=' + taskErr.message);
        }

        if (pendingWrite.length >= BATCH_WRITE_CHUNK_SIZE) {
          _persistBatch(pendingWrite);
          pendingWrite = [];
          _publishPendingEvents(pendingEvents);
          pendingEvents = [];
        }
      }

      // 写掉最后不满一批的剩余部分（循环正常结束或时间预算提前退出都会走到这里）。
      // 先 Tasks 状态、后 Events 审计记录——理由见 _publishPendingEvents 的注释。
      _persistBatch(pendingWrite);
      _publishPendingEvents(pendingEvents);

      return {
        checked: tasks.length,
        sent: sentCount,
        failed: failedCount,
        timeBudgetExceeded: timeBudgetExceeded
      };
    } finally {
      lock.releaseLock();
    }
  }

  /**
   * 判断 due_date 是否已经过期。
   * 本次修改（2026-06-27，外部审计MEDIUM RISK 7，核实属实后采纳）：
   * 实际逻辑在 21_SheetUtils.gs 的 isOverdue_()/parseDueDate_()，这里
   * 只剩一层委托。2026-07-06 第二轮审计后 SheetUtils 包进了 IIFE，调用
   * 方式改成 SheetUtils.isOverdue_(...)。
   */
  function _isOverdue(task) {
    return SheetUtils.isOverdue_(task.due_date);
  }

  function _shouldRemind(task) {
    var overdue = _isOverdue(task);

    // 未逾期 且 距 due_date 还早于 REMINDER_ADVANCE_HOURS 时，直接不
    // 提醒。里程类/无法解析的 due_date（_hoursUntilDue 返回 null）维持
    // 原行为不受影响。
    if (!overdue) {
      var hoursUntilDue = _hoursUntilDue(task);
      if (hoursUntilDue !== null && hoursUntilDue > REMINDER_ADVANCE_HOURS) {
        return false;
      }
    }

    var bucket = overdue ? 'OVERDUE' : task.priority;
    var intervalHours = REMINDER_INTERVAL_HOURS[bucket] || 24;

    if (!task.last_reminder_at) {
      return true;
    }

    var hoursSince = (Date.now() - new Date(task.last_reminder_at).getTime()) / 3600000;
    return hoursSince >= intervalHours;
  }

  /**
   * 距 due_date 还有多少小时（未来为正数，已过期为负数）。
   * 里程类（'40000km'）或无法解析的 due_date 返回 null。
   * 复用 SheetUtils.parseDueDate_，不重复实现（避免 C5）。
   */
  function _hoursUntilDue(task) {
    if (!task.due_date) return null;
    var raw = String(task.due_date).trim();
    if (/km$/i.test(raw)) return null;
    var due = SheetUtils.parseDueDate_(raw);
    if (!due || isNaN(due.getTime())) return null;
    return (due.getTime() - Date.now()) / 3600000;
  }

  function _buildReminder(task) {
    var overdue = _isOverdue(task);
    var statusLabel = overdue ? 'OVERDUE' : task.status;
    var icon = overdue ? '🔴' : '🟡';

    var lines = [];
    lines.push(icon + ' TASK REMINDER');
    lines.push('');
    lines.push('Title: ' + task.title);
    lines.push('Status: ' + statusLabel);

    if (task.due_date) {
      lines.push('Due: ' + task.due_date);
    }
    if (task.reminder_count > 0) {
      lines.push('Reminded: ' + task.reminder_count + 'x');
    }

    return lines.join('\n');
  }

  /**
   * ⚠️ MEDIUM RISK 1（最早那一轮审计）关联说明：下面这两个 inline
   * button 的 callback_data（task_done:/task_snooze:）依赖【另一个
   * 项目】（Personal AI Core）注册了 Telegram webhook 并解析——本项目
   * 自己不接 webhook，完整契约见 00_Project_Constitution.gs P6。
   *
   * 🐛 第二轮 bugfix（2026-07-06，HIGH RISK 2）：现在返回
   * Output.sendMessage 的结果，不再丢弃——调用方（checkReminders）需要
   * 这个返回值判断发送是否真的成功，才能决定要不要更新提醒状态。
   */
  function _sendReminder(task, message) {
    var keyboard = {
      inline_keyboard: [[
        { text: '✅ Done', callback_data: 'task_done:' + task.task_id },
        { text: '⏰ Snooze 1h', callback_data: 'task_snooze:' + task.task_id }
      ]]
    };
    return Output.sendMessage(task.chat_id, message, keyboard);
  }

  /**
   * 只负责把 REMINDER_SENT 事件草稿塞进内存缓冲区 + 更新内存里的
   * task.reminder_count/last_reminder_at，不直接写 Sheet/Events——实际
   * 的批量写入在 checkReminders() 里凑够 BATCH_WRITE_CHUNK_SIZE 或循环
   * 结束时统一处理（见 _persistBatch/_publishPendingEvents），且只有
   * 发送真正成功时才会调用这个函数（第二轮 HIGH RISK 2 修复）。
   *
   * 🐛 bugfix（2026-07-06，自己测试时发现，不在任何一轮外部审计报告里）：
   * 这个函数（原名_updateReminderCount）从最早的版本开始就只更新了
   * reminder_count，从来没有设置过 task.last_reminder_at！而
   * _shouldRemind 判断"距上次提醒是否超过间隔小时数"完全依赖这个字段——
   * 字段永远是空的，意味着 _shouldRemind 里 "if (!task.last_reminder_at)
   * return true" 这一行永远成立，REMINDER_INTERVAL_HOURS 那套按优先级
   * 分级的间隔（4/6/12/24小时）实际上从来没生效过，包括 OVERDUE 的
   * "强制每24小时"（R4）也一样——所有任务只要满足提醒条件，每小时触发器
   * 跑一次就会重发一次，不看上次到底是什么时候提醒的。
   * 影响范围：从最早的 92_ReminderEngine.gs 到现在，历经好几轮审计
   * （包括我自己第一轮的 mock 测试）都没抓到，因为之前的测试都是直接在
   * 测试用的 task 对象上手动设 last_reminder_at 来验证 _shouldRemind 的
   * 判断逻辑本身没问题（这部分测试结论仍然成立），但没有端到端验证过
   * "发送成功之后，这个字段真的会被写回 Sheet"这一步——这次为了验证
   * HIGH RISK 2（发送结果校验）新增的回归测试，顺带测出了这个更大的
   * 问题。现在补上赋值。
   *
   * 🐛 第四轮 bugfix（2026-07-10，HIGH RISK 1，核实属实后采纳）：不再
   * 直接调 EventBus.publish（同步单行 appendRow），改成把事件草稿 push
   * 进调用方传入的 pendingEvents 数组，由 checkReminders 统一批量
   * flush（EventBus.publishBatch）。副作用（有意为之）：这个函数现在
   * 是纯内存操作，不再有任何 I/O、不会抛出 Sheet 相关异常——以前如果
   * EventBus.publish 抛错，会导致下面两行更新 task 字段的代码executes不到，
   * 连带这条任务的 Tasks 状态也不会进 pendingWrite；现在两者不再耦合，
   * 完整理由见 _publishPendingEvents 的注释。
   *
   * @param {object} task
   * @param {object[]} pendingEvents  调用方传入的缓冲数组，本函数会往里 push
   */
  function _recordReminderSent(task, pendingEvents) {
    pendingEvents.push({
      type: 'REMINDER_SENT',
      payload: { task_id: task.task_id, sent_at: new Date().toISOString() },
      chatId: task.chat_id,
      source: 'ReminderEngine'
    });
    task.reminder_count = (task.reminder_count || 0) + 1;
    task.last_reminder_at = new Date().toISOString();
  }

  return {
    checkReminders: checkReminders
  };
})();

/**
 * GAS 的时间触发器（ScriptApp.newTrigger('checkReminders')）是按字符串
 * 名字在全局作用域找一个函数声明来绑定，不能绑定到
 * ReminderEngine.checkReminders 这种 IIFE 返回对象的属性。这个薄封装是
 * 唯一必须留在全局作用域的入口，纯转发，不含任何业务逻辑，也是
 * 1_Foundation/11_Setup.gs 的 createTriggers() 唯一认识的名字，不能改名。
 */
function checkReminders() {
  return ReminderEngine.checkReminders();
}
