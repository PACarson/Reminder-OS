/**
 * 20_ReminderEngine.gs   [原 26_ReminderEngine.gs — 2026-07-19
 * 按 Unified Reminder Engine 决定改名，见下方最新条目]
 * Reminder OS — 统一提醒引擎（Pre-Due + Overdue 两个阶段）
 *
 * 【2026-07-19 新增，ADR-2026-07-19-007，Carson 批准，Unified Reminder
 * Engine】退役 25_ReminderEngine.gs（V1）——这次不是"再加一个功能"，是把
 * V1 唯一还没被 V2 覆盖的能力（任务逾期未完成，按优先级间隔持续提醒直到
 * 完成）搬进本文件，变成 Pre-Due 之外的第二个阶段，共用同一个触发器、
 * 同一次轮询、同一套发送/重试/节流机制。完整决策记录见
 * 00_ADR_007_Unified_Reminder_Engine.gs，架构评审见
 * Unified-Reminder-Engine_Architecture-Review.md（Carson 2026-07-19
 * 批准，含三处 refinement：OVERDUE_POLICY_CONFIG 加 enabled 开关、
 * Quiet Hours 复用既有机制、ReminderHistory 加 policy_source）。
 *
 * 本次改动：
 *   - DEFAULT_REMINDER_OFFSETS_MINUTES（扁平数组）→
 *     DEFAULT_REMINDER_POLICY_CONFIG（按 priority 分组），_ensureRulesFromPolicy_
 *     取默认值时改成查 task.priority 对应的分组。
 *   - 新增 OVERDUE_POLICY_CONFIG（按 priority 分组，含 enabled/
 *     interval_minutes/max_repeats）。
 *   - 新增 Overdue 阶段：_processOverdueStage_()，复用
 *     _resolveEffectiveDueDatetime_/_isWithinQuietHours_/_buildKeyboard_，
 *     状态落在 Task 自己的 reminder_count/last_reminder_at 字段上（V1
 *     已经在用、已经有真实历史数据的字段，不新建表、不需要数据迁移），
 *     写法沿用 V1 的 SheetUtils.batchUpdateFieldsByKey_('Tasks', ...)。
 *   - ReminderHistory 的 _toHistoryRecord_ 新增 stage（'pre_due'|
 *     'overdue'）和 policy_source（'auto_default'|'user_override'|
 *     'priority_default'）两个字段——表结构改动见 11_Setup.gs。
 *   - checkOffsetReminders() 主循环末尾追加调用 Overdue 阶段，两个阶段
 *     共用同一把 LockService 锁、同一次 EXECUTION_TIME_BUDGET_MS 预算。
 *   - 顶层触发器函数保留旧名字 checkOffsetReminders()（不改函数名，只改
 *     它做的事）——11_Setup.gs 的 createTriggers() 不需要跟着改触发器
 *     绑定的名字，降低这次改动的连带范围。
 *
 * 25_ReminderEngine.gs 保留文件本身、只摘掉它的每小时触发器（见
 * 11_Setup.gs）——按迁移计划先观察，确认本文件的 Overdue 阶段行为符合
 * 预期之后再删除那个文件，不是这次改动的一部分。
 *
 * 【2026-07-17 新增，ADR-2026-07-17-006，Carson 批准】支持 Productivity OS
 * 新增的 Task.reminder_policy 字段——用户创建任务时可以直接覆盖默认提醒
 * 策略（"remind me 30 minutes before"这类短语，解析在 Productivity OS 那边，
 * 见该项目 06_TaskIntentParser.gs/09_TemporalParser.gs）。原 _ensureDefaultRules_
 * 改名 _ensureRulesFromPolicy_ 并扩展：taskIdsWithRules 未命中时，先读
 * task.reminder_policy 决定生成默认规则还是用户覆盖的规则，reminder_policy
 * 为 null 时行为跟改动前逐字节一致。旧名字保留一个只返回规则数组的
 * @deprecated wrapper，防止任何直接引用旧名字/旧返回形状的外部代码被
 * 打破。完整决策记录见 00_ADR_006_Reminder_Policy_Override.gs；决定
 * "只在首次物化生效、不引入持续 Rebuild"，本文件改动因此只集中在
 * _ensureRulesFromPolicy_ 这一个函数，checkOffsetReminders 主循环的其余
 * 部分（Occurrences/History 处理、Quiet Hours、重试）不受影响。
 *
 * 设计依据：Reminder-OS_Time-Based-Reminder-Engine_Design-Proposal.md
 * （§3 Data Model / §4 Lifecycle / §5 Scheduling Algorithm / §10）。这里
 * 只是实现，设计理由不重复贴，只在"写代码时才暴露出来、设计文档没预见到"
 * 的地方加注释。
 *
 * 职责边界（00_Project_Constitution.gs P9）：只回答"该在什么时候就一个
 * 已经存在的 task 发通知"，不碰 task 数据本身（只读 task_id、chat_id、
 * due_date/due_time/due_datetime、status、priority，从不写回 Productivity
 * OS 的表——唯一例外是 reminder_count/last_reminder_at 这两个字段，
 * V1 时代就已经是 Reminder OS 有限写权限的一部分，见 P3），不知道会议、
 * 日历、忙闲状态。
 *
 * 不依赖 12_TemporalEngine.gs——offset 是"到期时间减一个量"的简单减法，
 * 不是 recurrence 计算，ADR-004 已经明确排除"提前N天/N小时提醒"这类逻辑
 * 属于 Temporal Engine 的范围（design doc §0）。
 *
 * 🔧 实现阶段发现的设计细化（相对 design doc §3 的偏离，写代码时才看得
 * 出来，纸面设计阶段看不出来，所以记在这里而不是回去默默改设计文档）：
 *
 * 1. 去掉了 occurrence_id，ReminderOccurrences 和 ReminderHistory 都
 *    直接用 idempotency_key 当主键——idempotency_key（rule_id+channel+
 *    到分钟精度的 fire_at）天然唯一，多一个 occurrence_id 是冗余的第二套
 *    身份。
 *
 * 2. design doc §3 原来说"判重要同时查 Occurrences 和 History"——写代码
 *    时发现这行不通：21_SheetUtils.gs 的 batchReadFieldsByKey_ 即使是
 *    "定点查询"，读取量依然正比于目标表的【总行数】（它自己文件头写明：
 *    "这一步的读取量仍然正比于 sheetName 的总行数"），不是正比于要查的
 *    key 数量。ReminderHistory 设计上就是无限增长的表，如果每一轮 poll
 *    都去查它的 key 列，等于重新制造一次 HIGH RISK 2（Tasks 表那次）已经
 *    修过的同一类问题，只是换了张表、换了个引擎。
 *
 *    改法：ReminderRules 新增 resolved_fire_ats 字段（JSON，
 *    {channel: 上一次为这个 channel 解决掉的 fire_at}）。判断"这个
 *    (rule, channel, fire_at) 还要不要处理"只需要拿这一轮已经读进内存的
 *    rule 对象比一下时间戳，不需要多查任何表。History 因此变成纯只写——
 *    poll 的热路径完全不读它，不管它长多大都不影响每一轮的读取成本，比
 *    design doc 原方案更彻底地满足了 §3 本来就想要的"Hot Table 有界"。
 *
 *    ReminderOccurrences 仍然会被查（判断"这个 fire_at 是不是已经有一条
 *    正在处理中/等重试的 in-flight 记录"），但这张表本身有界（非终态才
 *    留在这里），查它没有 History 那个问题。
 *
 *    🐛 2026-07-15 修订（外部审计 HIGH RISK 1，核实属实后采纳）：上面
 *    "{channel: 上一次为这个 channel 解决掉的 fire_at}"这句已过时。
 *    实际存的语义改成"{channel: 上一次解决掉这个 channel 时，
 *    effectiveDue 是多少}"——原方案直接比较 fire_at 大小，隐含"到期时间
 *    只会不变或后移"的假设，任务到期时间被改早时会被新算出的、更小的
 *    fire_at 误判成"已经处理过"而跳过。字段名（resolved_fire_ats）保留
 *    不变，只改存的值和比较方式，完整理由见 checkOffsetReminders 里
 *    对应改动点的注释。
 *
 * 依赖假设（design doc §2 Open Item 1，尚未拿到 Productivity OS 代码
 * 验证）：_resolveEffectiveDueDatetime_ 把"读哪个到期字段"收在一个函数
 * 里，due_datetime/due_date+due_time/纯 due_date 三种可能都试一遍，
 * schema 一旦确认，只需要改这一个函数。
 */

var ReminderEngine = (function () {

  // ---------- Config（Constitution P8：能用命名常量就不建 SecureConfig；
  // design doc §3 决策）----------

  var RULES_SHEET = 'ReminderRules';
  var OCCURRENCES_SHEET = 'ReminderOccurrences';
  var HISTORY_SHEET = 'ReminderHistory';

  // 【2026-07-19 变更，Unified Reminder Engine】design doc §3 原来的默认
  // offset 是一个不分 priority 的扁平数组；这次改成按 priority 分组
  // （你这次 prompt 举的数值：LOW -30min／MEDIUM -1h／HIGH -2h+-30min／
  // CRITICAL -1天+-2h+-30min）。取某个 task 的默认值时用 task.priority
  // 查这个 CONFIG，查不到（priority 是空值或不认识的字符串）落到 MEDIUM，
  // 见 _lookupPriorityConfig_。
  var DEFAULT_REMINDER_POLICY_CONFIG = {
    LOW:      { offsets_minutes: [30] },
    MEDIUM:   { offsets_minutes: [60] },
    HIGH:     { offsets_minutes: [120, 30] },
    CRITICAL: { offsets_minutes: [1440, 120, 30] }
  };

  // 【2026-07-19 新增，Unified Reminder Engine，Overdue 阶段】任务逾期
  // 未完成时的持续提醒策略，按 priority 分组，数值直接沿用
  // 25_ReminderEngine.gs（V1）REMINDER_INTERVAL_HOURS 已经验证过的分级
  // （4h/6h/12h/24h），只是换算成分钟、挪到这个统一的 CONFIG 形状里，
  // 不是重新设计新数字。
  //   enabled: 这个 priority 要不要有 Overdue 阶段——2026-07-19
  //     refinement（Carson），false 时这个 priority 的任务逾期后完全
  //     不会进入下面的判断，即使已经逾期也不提醒。
  //   interval_minutes: 每隔多久重复一次。
  //   max_repeats: 最多提醒几次，null = 不限（跟 V1 现状行为一致）。
  var OVERDUE_POLICY_CONFIG = {
    LOW:      { enabled: true, interval_minutes: 1440, max_repeats: null },
    MEDIUM:   { enabled: true, interval_minutes: 720,  max_repeats: null },
    HIGH:     { enabled: true, interval_minutes: 360,  max_repeats: null },
    CRITICAL: { enabled: true, interval_minutes: 240,  max_repeats: null }
  };

  // design doc §5：Quiet Hours，24小时制本地时间。startHour/endHour 都是
  // null 表示关闭（跟上面同一个"哨兵值当开关"的约定）。暂不启用——等真实
  // 使用经验，不是现在猜（见 Constitution 相关讨论）。【2026-07-19
  // refinement，Carson：(1) Overdue 阶段共用同一套配置和判断函数
  // （_isWithinQuietHours_），不是重新做一套——这不是"预留架构以后再做"，
  // 是已经建好、两个阶段共用，只是默认还没打开；(2) 两个独立的裸变量
  // 改成一个对象（QUIET_HOURS_CONFIG），原因是裸的 number/null 变量导出
  // 到 IIFE 外面之后是拷贝值不是引用，没法在导出的地方真正做到"可配置"
  // ——包成一个对象之后，跟 DEFAULT_REMINDER_POLICY_CONFIG/
  // OVERDUE_POLICY_CONFIG 同一种"导出对象引用，改这个对象的属性就是改真
  // 实配置"的模式，不是这次唯一的特例。】
  var QUIET_HOURS_CONFIG = { startHour: null, endHour: null };

  var LOCK_WAIT_MS = 10000;
  var HARD_EXECUTION_LIMIT_MS = 6 * 60 * 1000;
  // 比 25_ReminderEngine.gs 的 WORST_CASE_SINGLE_TASK_MS 略保守：一条
  // rule 可能对应多个 channel，循环体比"一个 task"更重一点。
  var WORST_CASE_SINGLE_RULE_MS = 3000;
  var EXTRA_SAFETY_MARGIN_MS = 15000;
  var EXECUTION_TIME_BUDGET_MS = HARD_EXECUTION_LIMIT_MS - WORST_CASE_SINGLE_RULE_MS - EXTRA_SAFETY_MARGIN_MS;

  // 沿用 25_ReminderEngine.gs 同款折中，完整理由见那边文件头。
  var BATCH_WRITE_CHUNK_SIZE = 5;
  var MAX_RETRY_ATTEMPTS = 2;
  var RETRY_DELAY_MINUTES = 5;
  // key 名字换成这个引擎自己的前缀，避免跟 25_ReminderEngine.gs 抢同一个
  // PropertiesService key。
  var RETRY_FLAG_KEY = 'REMINDER_OFFSET_ENGINE_RETRY_TRIGGER_ID';
  var RETRY_COUNT_KEY = 'REMINDER_OFFSET_ENGINE_RETRY_COUNT';

  // ---------- Identity（跟 20_EventBus.gs 同一套 PREFIX-timestamp-random
  // 惯例，见 Constitution/design doc §10 Identity）----------

  function _generateRuleId_() {
    return 'RULE-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  }

  // ---------- 到期时间解析 ----------

  function _resolveEffectiveDueDatetime_(task) {
    if (task.due_datetime) {
      var dt1 = SheetUtils.parseDueDate_(task.due_datetime);
      if (dt1) return dt1;
    }
    if (task.due_date && task.due_time) {
      var combined = String(task.due_date).trim() + 'T' + String(task.due_time).trim();
      var dt2 = new Date(combined);
      if (!isNaN(dt2.getTime())) return dt2;
    }
    if (task.due_date) {
      var dt3 = SheetUtils.parseDueDate_(task.due_date);
      if (dt3) return dt3;
    }
    return null; // 没有可用的到期时间信息，这个 task 这一轮不参与 offset 计算
  }

  function _parseJsonSafe_(str, fallback) {
    if (!str) return fallback;
    try {
      var parsed = JSON.parse(str);
      return parsed || fallback;
    } catch (e) {
      return fallback;
    }
  }

  function _computeIdempotencyKey_(ruleId, channel, fireAt) {
    return ruleId + ':' + channel + ':' + Math.floor(fireAt.getTime() / 60000);
  }

  /**
   * design doc §5 Quiet Hours：固定时钟窗口，不读日历、不判断"此刻是否
   * 有会议"——跟 availability analysis 的区别见 Constitution P9。
   */
  function _isWithinQuietHours_(now) {
    var startHour = QUIET_HOURS_CONFIG.startHour;
    var endHour = QUIET_HOURS_CONFIG.endHour;
    if (startHour === null || endHour === null) return false;
    var hour = now.getHours();
    if (startHour <= endHour) {
      return hour >= startHour && hour < endHour;
    }
    return hour >= startHour || hour < endHour; // 跨午夜窗口，如 22→8
  }

  function _offsetLabel_(minutes) {
    if (minutes >= 1440 && minutes % 1440 === 0) return (minutes / 1440) + ' day(s) before';
    if (minutes >= 60 && minutes % 60 === 0) return (minutes / 60) + ' hour(s) before';
    return minutes + ' minute(s) before';
  }

  /**
   * 【2026-07-19 新增，Unified Reminder Engine】DEFAULT_REMINDER_POLICY_CONFIG
   * 和 OVERDUE_POLICY_CONFIG 共用的查找逻辑——priority 是空值、或者不是
   * LOW/MEDIUM/HIGH/CRITICAL 这四个已知取值之一时，落到 MEDIUM，不让一个
   * 意外的 priority 取值导致这个 task 完全没有默认策略/Overdue 策略可用。
   */
  function _lookupPriorityConfig_(configMap, priority) {
    return configMap[priority] || configMap.MEDIUM;
  }

  // ---------- Rule generation from policy（ADR-006：reminder_policy override）----------

  /**
   * 【ADR-2026-07-17-006 新增】原名 _ensureDefaultRules_，只处理"用默认
   * offset 生成规则"这一种情况。现在改名反映它实际做的事：对每个还没有
   * 任何规则行的 task（taskIdsWithRules 未命中——这个门槛本身不变，见下方
   * "落地时机"说明），读 task.reminder_policy 决定生成什么样的规则，而不是
   * 无条件用 DEFAULT_REMINDER_POLICY_CONFIG 里 task.priority 对应的默认值
   * （2026-07-19 起按 priority 分组，此前是一个不分 priority 的扁平数组，
   * 见文件头 Unified Reminder Engine 条目）。
   *
   * task.reminder_policy 是 Productivity OS 新增的 Task 字段（JSON 字符串，
   * ActiveTasks 投影天然携带，QueryEngine.getPendingTasks() 不需要改动就能
   * 读到——跟当年 due_time/due_datetime 免改这个文件同一个理由），本函数
   * 通过 _parseJsonSafe_ 解析，解析失败或字段本身不存在都按 null 处理。
   *
   * 三种情况（Carson 决定 #1/#3，2026-07-17；默认值来源 2026-07-19 改为
   * 按 priority 分组，见 Unified Reminder Engine 条目）：
   *   reminder_policy 为 null／解析失败
   *     → 按 task.priority 查 DEFAULT_REMINDER_POLICY_CONFIG，source:
   *       'auto_default'。
   *   reminder_policy.offsets 是非空数组
   *     → 按这些 offset 生成，source: 'user_override'。
   *   reminder_policy.offsets 是空数组（用户显式声明"不要提前提醒"）
   *     → 不生成任何规则行。这不影响 25_ReminderEngine.gs（V1）的到期
   *       提醒——两者是完全独立的机制，V1 从不读 reminder_policy（Carson
   *       决定 #1："Offset Reminder 和 Due Reminder 是两种不同职责"）。
   *
   * 落地时机（Carson 决定 #4，窄口径）：只在 taskIdsWithRules 未命中（这个
   * task 还没有任何规则行）的那一刻按当时的 reminder_policy 生成一次，
   * 之后不再复查——Task 之后不可变（本阶段只有 Create 流程），不存在
   * "Task 变了但 Rules 没跟上"的情况；如果有人绕过系统直接改
   * ReminderRules/共享 Sheet，那是本阶段之外的 escape hatch，不在自动
   * 纠正范围内（未来如果支持编辑 reminder_policy，需要那个能力自己设计
   * Re-materialization 流程，不是在这个热路径里加持续一致性检查）。
   */
  function _ensureRulesFromPolicy_(pendingTasks, taskIdsWithRules) {
    var newRules = [];
    var defaultRulesCreated = 0;
    var overrideRulesCreated = 0;

    for (var i = 0; i < pendingTasks.length; i++) {
      var task = pendingTasks[i];
      if (taskIdsWithRules[task.task_id]) continue;
      var effectiveDue = _resolveEffectiveDueDatetime_(task);
      if (!effectiveDue) continue; // 没有可用到期时间，不生成规则（不管哪种来源）

      var policy = _parseJsonSafe_(task.reminder_policy, null);
      var offsetMinutesList;
      var source;

      if (!policy || !policy.offsets) {
        // null，或者字段存在但解析不出 offsets——按 priority 对应的默认
        // 策略处理。【2026-07-19 变更，Unified Reminder Engine】这里从
        // "固定用同一个扁平数组"改成"按 task.priority 查
        // DEFAULT_REMINDER_POLICY_CONFIG"——priority 缺失/不认识时落到
        // MEDIUM（_lookupPriorityConfig_），不是新增的静默失败模式。
        var defaultPolicy = _lookupPriorityConfig_(DEFAULT_REMINDER_POLICY_CONFIG, task.priority);
        if (!defaultPolicy.offsets_minutes || defaultPolicy.offsets_minutes.length === 0) {
          taskIdsWithRules[task.task_id] = true;
          continue; // 这个 priority 的默认策略本身关闭，没有规则可生成，但仍标记"已处理过"
        }
        offsetMinutesList = defaultPolicy.offsets_minutes;
        source = 'auto_default';
      } else if (policy.offsets.length === 0) {
        // 用户在创建时显式声明"不要提前提醒"——不生成任何规则行，也不需要
        // 额外标记：taskIdsWithRules 本来就只从"已有规则行"反推，这里没有
        // 规则行可言，下一轮会再读到同一个 task，但 reminder_policy 不可变
        // （决定 #2），再读一次结果还是"不生成"，天然幂等，不产生副作用。
        continue;
      } else {
        offsetMinutesList = policy.offsets.map(_offsetToMinutes_).filter(function (m) { return m !== null; });
        source = 'user_override';
      }

      for (var j = 0; j < offsetMinutesList.length; j++) {
        var offsetMinutes = offsetMinutesList[j];
        newRules.push({
          rule_id: _generateRuleId_(),
          task_id: task.task_id,
          chat_id: task.chat_id,
          offset_minutes: offsetMinutes,
          offset_label: _offsetLabel_(offsetMinutes),
          channels: JSON.stringify(['telegram']),
          rule_status: 'active',
          source: source,
          resolved_fire_ats: JSON.stringify({}),
          created_at: new Date().toISOString()
        });
      }
      // 【计数口径跟改动前逐字节一致】改动前 stats.defaultRulesCreated 直接
      // 等于 newDefaultRules.length（数的是生成的规则【行数】，不是任务
      // 数）——1个task用3个默认offset会让这个数变成3，不是1（见
      // 50_ReminderEngine_Tests.gs 场景A的断言）。user_override 沿用
      // 同一个计数口径，两者才可比。
      if (source === 'auto_default') defaultRulesCreated += offsetMinutesList.length;
      if (source === 'user_override') overrideRulesCreated += offsetMinutesList.length;
      taskIdsWithRules[task.task_id] = true; // 避免同一轮内对同一个 task 重复生成
    }

    return { rules: newRules, defaultRulesCreated: defaultRulesCreated, overrideRulesCreated: overrideRulesCreated };
  }

  /**
   * 【ADR-2026-07-17-006 新增】把 reminder_policy.offsets 里的
   * { value, unit } 换算成分钟——跟 DEFAULT_REMINDER_POLICY_CONFIG 各
   * priority 下的 offsets_minutes 保持同一种内部单位（分钟），_offsetLabel_ 等下游函数不需要
   * 认识 unit 这个概念。unit 无法识别时返回 null，调用点会把它过滤掉
   * （静默丢弃一个看不懂的 offset，好过让一整个 task 的规则生成失败）。
   */
  function _offsetToMinutes_(offset) {
    if (!offset || typeof offset.value !== 'number') return null;
    switch (offset.unit) {
      case 'minutes': return offset.value;
      case 'hours':   return offset.value * 60;
      case 'days':    return offset.value * 1440;
      default:        return null;
    }
  }

  /** @deprecated 改名为 _ensureRulesFromPolicy_，见该函数头注释。这个别名
   *  只为了不打破任何可能直接按旧名字调用的外部引用（比如单元测试）——
   *  保持原来的契约：只返回规则数组本身，不是新函数的
   *  {rules, defaultRulesCreated, overrideRulesCreated} 形状。本文件内部
   *  一律调用新名字、用新的返回形状。 */
  function _ensureDefaultRules_(pendingTasks, taskIdsWithRules) {
    return _ensureRulesFromPolicy_(pendingTasks, taskIdsWithRules).rules;
  }

  // ---------- Message / keyboard ----------
  // 复用 25_ReminderEngine.gs 现有的 callback_data 惯例
  // （task_done:/task_snooze:，只认 task_id）。多个 occurrence 共用同一对
  // 按钮时 Snooze 语义仍然模糊，这是 design doc §2 记录过的已知开放项，
  // 跨项目协调（Personal AI Core 的 webhook 解析）超出这个文件的范围，
  // 不在这里解决。

  function _formatMessage_(rule, task, effectiveDue) {
    return '⏰ 提醒（' + rule.offset_label + '）\n' +
      (task.title || task.task_id) + '\n' +
      '到期: ' + effectiveDue.toLocaleString();
  }

  function _buildKeyboard_(task) {
    return {
      inline_keyboard: [[
        { text: '✅ Done', callback_data: 'task_done:' + task.task_id },
        { text: '⏰ Snooze 1h', callback_data: 'task_snooze:' + task.task_id }
      ]]
    };
  }

  /**
   * 【2026-07-19 refinement，Carson】新增 stage/policySource 两个参数，
   * 落到 History 表的 stage/policy_source 两列（schema 变更见
   * 11_Setup.gs）——不是"以后要分析再加列"，这次直接做，避免以后真的要做
   * 分析时还要再改一次表结构。stage 区分 Pre-Due/Overdue 两个阶段；
   * policySource 区分这条提醒是默认策略还是用户自定义产生的（Pre-Due 阶段
   * 直接照抄触发它的 Rule 的 source 字段；Overdue 阶段现在只有按 priority
   * 分组的 CONFIG，还没有"单个任务自定义 Overdue 间隔"这种能力，统一记
   * 'priority_default'，为将来可能支持这种自定义预留取值空间，不需要
   * 再改表结构）。两个参数都不传时分别落到 'pre_due'/'auto_default'，
   * 保护任何遗漏传参的调用点不会写出空值。
   */
  function _toHistoryRecord_(occurrence, finalStatus, reason, stage, policySource) {
    return {
      idempotency_key: occurrence.idempotency_key,
      rule_id: occurrence.rule_id,
      task_id: occurrence.task_id,
      chat_id: occurrence.chat_id,
      channel: occurrence.channel,
      computed_fire_at: occurrence.computed_fire_at,
      final_status: finalStatus,
      attempt_count: occurrence.attempt_count || 0,
      resolved_at: new Date().toISOString(),
      resolved_reason: reason,
      archived_at: new Date().toISOString(),
      stage: stage || 'pre_due',
      policy_source: policySource || 'auto_default'
    };
  }

  function _reminderEvent_(type, occurrence, reason) {
    return {
      type: type,
      chat_id: occurrence.chat_id,
      payload: JSON.stringify({
        rule_id: occurrence.rule_id,
        task_id: occurrence.task_id,
        idempotency_key: occurrence.idempotency_key,
        channel: occurrence.channel,
        reason: reason
      }),
      source: 'ReminderEngine'
    };
  }

  // ---------- Persistence batching ----------
  // 沿用 25_ReminderEngine.gs 的顺序原则：先功能性状态、再审计事件；这里
  // 额外多一层顺序（design doc §3 归档机制）：History 先写成功，才删
  // Occurrences——中途失败最坏结果是"两边都有"，不会是"两边都没有"。

  function _persistBatch_(occurrenceUpserts, historyInserts, occurrenceDeleteKeys, ruleUpdates, ruleDeleteIds) {
    if (historyInserts && historyInserts.length > 0) {
      try {
        SheetUtils.batchUpsertRowsByKey_(HISTORY_SHEET, 'idempotency_key', historyInserts);
      } catch (e) {
        Logger.log('[ReminderEngine] ❌ History 批量写入失败，本批不会从 Occurrences 删除' +
          '（避免记录丢失），下一轮会重新尝试归档: ' + e.message);
        historyInserts = [];
        occurrenceDeleteKeys = []; // History 没写成功，不能删 Occurrences，宁可重复尝试也不丢记录
      }
    }
    if (occurrenceDeleteKeys && occurrenceDeleteKeys.length > 0) {
      // 🐛 bugfix（顺带修复，2026-07-15）：审计 MEDIUM RISK 1 明确点名的是
      // 下面 ruleDeleteIds 那段，但这里 occurrenceDeleteKeys 是完全相同
      // 的"逐个 key 调 deleteRowByKey_"形状——而且触发频率比规则删除更高
      // （每条 occurrence 无论 sent/failed-归档/cancelled 都会走到这里），
      // 是同一类问题里实际影响更大的那一半，一起换成
      // batchDeleteRowsByKey_，不留一个显而易见会被下一次审计重新点名
      // 的姊妹问题。
      try {
        SheetUtils.batchDeleteRowsByKey_(OCCURRENCES_SHEET, 'idempotency_key', occurrenceDeleteKeys);
      } catch (e) {
        Logger.log('[ReminderEngine] ⚠️ 批量删除 Occurrences 记录失败: ' + e.message);
      }
    }
    if (occurrenceUpserts && occurrenceUpserts.length > 0) {
      try {
        SheetUtils.batchUpsertRowsByKey_(OCCURRENCES_SHEET, 'idempotency_key', occurrenceUpserts);
      } catch (e) {
        Logger.log('[ReminderEngine] ❌ Occurrences 批量写入失败: ' + e.message);
      }
    }
    if (ruleUpdates && ruleUpdates.length > 0) {
      try {
        SheetUtils.batchUpdateFieldsByKey_(RULES_SHEET, 'rule_id', ruleUpdates);
      } catch (e) {
        Logger.log('[ReminderEngine] ❌ Rules 状态更新失败: ' + e.message);
      }
    }
    if (ruleDeleteIds && ruleDeleteIds.length > 0) {
      // 🐛 bugfix（外部审计 MEDIUM RISK 1，2026-07-15，核实属实后采纳）：
      // 原来逐个 rule_id 调 deleteRowByKey_，每次都各自完整开表+扫 key
      // 列；改成一次 batchDeleteRowsByKey_，只定位一次、按行号降序批量
      // 删除，完整理由见 21_SheetUtils.gs 里那个函数自己的说明。
      try {
        SheetUtils.batchDeleteRowsByKey_(RULES_SHEET, 'rule_id', ruleDeleteIds);
      } catch (e) {
        Logger.log('[ReminderEngine] ⚠️ 批量删除退休规则失败: ' + e.message);
      }
    }
  }

  function _publishPendingEvents_(events) {
    if (!events || events.length === 0) return;
    try {
      EventBus.publishBatch(events);
    } catch (e) {
      Logger.log('[ReminderEngine] ⚠️ Events 审计记录失败（不影响已经落盘的功能性状态）: ' + e.message);
    }
  }

  // ---------- Retry / lock ----------
  // 跟 25_ReminderEngine.gs 同款模式，key 名字换成这个引擎自己的前缀。

  function _cleanupStaleRetryTrigger_() {
    var props = PropertiesService.getScriptProperties();
    var triggerId = props.getProperty(RETRY_FLAG_KEY);
    if (!triggerId) return;
    try {
      var triggers = ScriptApp.getProjectTriggers();
      for (var i = 0; i < triggers.length; i++) {
        if (triggers[i].getUniqueId() === triggerId) {
          ScriptApp.deleteTrigger(triggers[i]);
          break;
        }
      }
    } catch (e) {
      Logger.log('[ReminderEngine] 清理重试 trigger 出错（忽略）: ' + e.message);
    }
    props.deleteProperty(RETRY_FLAG_KEY);
  }

  function _scheduleRetry_() {
    var props = PropertiesService.getScriptProperties();
    var attemptCount = Number(props.getProperty(RETRY_COUNT_KEY) || '0');
    if (attemptCount >= MAX_RETRY_ATTEMPTS) {
      props.deleteProperty(RETRY_COUNT_KEY);
      return;
    }
    var trigger = ScriptApp.newTrigger('checkOffsetReminders')
      .timeBased()
      .after(RETRY_DELAY_MINUTES * 60 * 1000)
      .create();
    props.setProperty(RETRY_FLAG_KEY, trigger.getUniqueId());
    props.setProperty(RETRY_COUNT_KEY, String(attemptCount + 1));
  }

  function _readAllRows_(sheetName) {
    // ReminderRules/ReminderOccurrences 设计上都是有界表（design doc §3），
    // 整表读符合 22_QueryEngine.gs 读 ActiveTasks 同一个"有界表可以整表读"
    // 的既有惯例，不是新引入的模式。
    var sheet = SheetUtils.getSheet_(sheetName);
    var headerMap = SheetUtils.getHeaderMap_(sheet);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];
    var numCols = sheet.getLastColumn();
    var values = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();
    var headers = Object.keys(headerMap);
    return values.map(function (row) {
      var obj = {};
      headers.forEach(function (h) { obj[h] = row[headerMap[h]]; });
      return obj;
    });
  }

  // ---------- Overdue 阶段（新，2026-07-19，Unified Reminder Engine，
  // 取代 25_ReminderEngine.gs）----------
  // 状态落在 task.reminder_count/last_reminder_at 上，不新建表——这两个
  // 字段是 V1 时代就在用、已经有真实历史数据的字段，Reminder OS 对它们的
  // 有限写权限也是 P3 早就有的边界，不是这次新开的口子。

  /**
   * V1（25_ReminderEngine.gs）原来的消息里带"Reminded: Nx"计数和逾期视觉
   * 标记——这次迁移过来时特意保留这个信息量（架构评审 §7 明确点出的
   * "隐藏行为差异"之一），不是照抄 Pre-Due 阶段"⏰ 提醒（X分钟前）"那种
   * 更简短的文案。
   */
  function _formatOverdueMessage_(task, effectiveDue) {
    var lines = ['🔴 逾期提醒', (task.title || task.task_id), '到期: ' + effectiveDue.toLocaleString()];
    var reminderCount = Number(task.reminder_count) || 0;
    if (reminderCount > 0) lines.push('已提醒: ' + reminderCount + '次');
    return lines.join('\n');
  }

  /**
   * 对一批 pending tasks 跑一次 Overdue 判断——跟 Pre-Due 阶段共用同一次
   * QueryEngine.getPendingTasks() 结果（调用点见 checkOffsetReminders），
   * 不重新查一次。返回 { overdueSent: N }，并入主 stats。
   *
   * 判断顺序（architecture review §3 流程图）：
   *   1. 能不能解析出到期时间（复用 _resolveEffectiveDueDatetime_，里程类/
   *      解析失败的 task 直接跳过，不参与 Overdue，跟 Pre-Due 阶段一致的
   *      处理方式，见架构评审 §7）
   *   2. 到期时间是不是已经过了
   *   3. 这个 priority 的 Overdue Policy 是不是 enabled
   *   4. max_repeats 有没有设、有没有到上限
   *   5. 距上次提醒是不是已经超过 interval_minutes（第一次提醒
   *      last_reminder_at 为空，视为"超过"，立刻可以提醒）
   *   6. 不在 Quiet Hours 里（复用 _isWithinQuietHours_，命中就跳过这一轮，
   *      不提前更新 last_reminder_at，留到下一轮自然重新判断）
   */
  function _processOverdueStage_(pendingTasks, now) {
    var taskUpdates = [];
    var historyInserts = [];
    var pendingEvents = [];
    var overdueSent = 0;

    for (var i = 0; i < pendingTasks.length; i++) {
      var task = pendingTasks[i];
      var effectiveDue = _resolveEffectiveDueDatetime_(task);
      if (!effectiveDue) continue; // 解析不出到期时间（比如里程类），这一轮不参与 Overdue 判断
      if (effectiveDue.getTime() > now.getTime()) continue; // 还没到期

      var overduePolicy = _lookupPriorityConfig_(OVERDUE_POLICY_CONFIG, task.priority);
      if (!overduePolicy.enabled) continue;

      var reminderCount = Number(task.reminder_count) || 0;
      if (overduePolicy.max_repeats !== null && overduePolicy.max_repeats !== undefined &&
        reminderCount >= overduePolicy.max_repeats) continue;

      var lastReminderAt = task.last_reminder_at ? new Date(task.last_reminder_at) : null;
      if (lastReminderAt && !isNaN(lastReminderAt.getTime())) {
        var minutesSinceLast = (now.getTime() - lastReminderAt.getTime()) / 60000;
        if (minutesSinceLast < overduePolicy.interval_minutes) continue;
      }

      if (_isWithinQuietHours_(now)) continue; // 这一轮不发，下一轮再判断

      var sendResult = Output.send('telegram', task.chat_id, _formatOverdueMessage_(task, effectiveDue), {
        keyboard: _buildKeyboard_(task)
      });

      if (sendResult && sendResult.ok) {
        var newCount = reminderCount + 1;
        taskUpdates.push({ task_id: task.task_id, reminder_count: newCount, last_reminder_at: now.toISOString() });
        var idemKey = 'overdue:' + task.task_id + ':' + Math.floor(now.getTime() / 60000);
        historyInserts.push({
          idempotency_key: idemKey,
          rule_id: '',
          task_id: task.task_id,
          chat_id: task.chat_id,
          channel: 'telegram',
          computed_fire_at: now.toISOString(),
          final_status: 'sent',
          attempt_count: 1,
          resolved_at: now.toISOString(),
          resolved_reason: 'overdue_repeat',
          archived_at: now.toISOString(),
          stage: 'overdue',
          policy_source: 'priority_default'
        });
        pendingEvents.push({
          type: 'REMINDER_SENT',
          chat_id: task.chat_id,
          payload: JSON.stringify({ task_id: task.task_id, stage: 'overdue', reminder_count: newCount }),
          source: 'ReminderEngine'
        });
        overdueSent++;
      }
      // 发送失败：不更新 reminder_count/last_reminder_at，下一轮自然重试
      // ——跟 V1 现状行为一致（V1 对失败也没有独立的重试预算，靠下一次
      // 触发器自然重来），不是这次改动引入的新行为。
    }

    // 顺序跟 V1 的 _persistBatch/_publishPendingEvents 一致：功能性状态
    // （reminder_count/last_reminder_at，驱动"还要不要提醒"的判断）先落盘，
    // History/Events 这类审计记录其次——哪怕后两者失败，功能状态已经
    // 安全落盘，不会因为审计记录失败而导致重复提醒。
    if (taskUpdates.length > 0) {
      try {
        var result = SheetUtils.batchUpdateFieldsByKey_('Tasks', 'task_id', taskUpdates);
        if (result && result.notFound && result.notFound.length > 0) {
          Logger.log('[ReminderEngine] ⚠️ Overdue: 以下 task_id 在 Tasks 表里找不到（可能被并发' +
            '删除/改动），提醒已发出但状态未落盘: ' + result.notFound.join(','));
        }
      } catch (e) {
        Logger.log('[ReminderEngine] ❌ Overdue reminder_count/last_reminder_at 批量写入失败: ' + e.message);
      }
    }
    if (historyInserts.length > 0) {
      try {
        SheetUtils.batchUpsertRowsByKey_(HISTORY_SHEET, 'idempotency_key', historyInserts);
      } catch (e) {
        Logger.log('[ReminderEngine] ❌ Overdue History 写入失败: ' + e.message);
      }
    }
    if (pendingEvents.length > 0) {
      try {
        EventBus.publishBatch(pendingEvents);
      } catch (e) {
        Logger.log('[ReminderEngine] ⚠️ Overdue Events 审计记录失败（不影响已落盘的 Tasks 状态）: ' + e.message);
      }
    }

    return { overdueSent: overdueSent };
  }

  // ---------- 主流程（design doc §5，含 resolved_fire_ats 细化）----------

  function checkOffsetReminders() {
    _cleanupStaleRetryTrigger_();

    // ⚠️ 范围说明（外部审计 HIGH RISK 4，2026-07-15 核实属实，评估后未在
    // 代码层面"修复"，理由如下）：下面这把锁是 LockService.getScriptLock()，
    // 只能防止本项目自己的 checkOffsetReminders 并发执行两次，不能阻止
    // Personal AI Core（处理 Telegram 按钮回调）或 Productivity OS 在
    // 本次执行期间并发写共享的 Tasks/ReminderRules 等表——GAS 的
    // LockService 不跨 standalone 项目生效，这是平台限制，不是这里能
    // 修的代码 bug。审计给的两条修复方向都评估过：①
    // 在共享 Spreadsheet 里建一张专属锁定表，各项目写入前互相协调——但
    // 这需要 Personal AI Core 和 Productivity OS 也同步实现并遵守同一套
    // 协议，本项目单方面加锁对那两个项目的写入没有任何约束力，等于只加
    // 复杂度不加保护，是虚假的安全感；② 把三个项目都迁移成绑定在同一
    // Spreadsheet 下的容器绑定脚本以启用 LockService.getDocumentLock()——
    // 这是牵动全平台三个项目的部署架构变动，不是能在 Reminder OS 这一个
    // 项目里单方面决定的事，也看不到另外两个项目的代码去确认可行性。
    // 跟 21_SheetUtils.gs batchUpdateFieldsByKey_ 文件头、
    // 00_ADR_002_ReminderEngine_Audit_Fixes.txt「MEDIUM RISK 1」处理
    // Tasks 表同一类跨项目并发风险时的判断一致：现有的按需定点单元格
    // 写入（batchUpdateFieldsByKey_/batchReadFieldsByKey_ 只碰实际要改
    // 的字段，不整行/整表覆写）已经是在没有跨项目锁的前提下能做到的
    // 合理缓解；真正的解决需要一次跨三个项目的协调决定，建议记录进
    // 00_Project_State.gs「已知问题」，不在这里假装修好。25_ReminderEngine.gs
    // 的 checkReminders 是同一个平台限制，同一个结论，见那边对应位置的
    // 注释。
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(LOCK_WAIT_MS);
    } catch (e) {
      Logger.log('[ReminderEngine] 前序执行尚未结束，跳过本次，安排重试');
      _scheduleRetry_();
      return { rulesChecked: 0, sent: 0, cancelled: 0, failed: 0, defaultRulesCreated: 0, overrideRulesCreated: 0, overdueSent: 0 };
    }

    PropertiesService.getScriptProperties().deleteProperty(RETRY_COUNT_KEY);

    var startedAt = Date.now();
    var stats = { rulesChecked: 0, sent: 0, cancelled: 0, failed: 0, defaultRulesCreated: 0, overrideRulesCreated: 0, overdueSent: 0 };

    try {
      var allRules = _readAllRows_(RULES_SHEET);
      var activeRules = [];
      var taskIdsWithRules = {};

      // 🐛 bugfix（外部审计 MEDIUM RISK 1，2026-07-15，核实属实后采纳）：
      // ruleDeletes（原 staleRuleIds）挪到这里，跟其余五个批量累加数组、
      // flush/flushIfNeeded 一起最先声明——原来 staleRuleIds 独立于这套
      // 批量机制之外收集，循环期间不受 flushIfNeeded 影响，函数末尾才用
      // 一次同步 forEach 循环逐个 SheetUtils.deleteRowByKey_，每次调用
      // 各自完整地开表+读表头+扫 key 列，一旦本轮累积的失效规则较多，会
      // 在函数收尾阶段集中拖慢执行、逼近超时。现在 ruleDeletes 和
      // occUpserts/historyInserts/occDeletes/ruleUpdates 用同一套节奏
      // 分批 flush（见下方 flushIfNeeded），不再有"循环内不批、循环外
      // 一次性处理"的不一致；实际的物理删除也从"每个 key 各一次
      // deleteRowByKey_"改成 SheetUtils.batchDeleteRowsByKey_ 一次性
      // 定位+批量删除，见 _persistBatch_ 和 21_SheetUtils.gs 里那个函数
      // 自己的说明。
      var occUpserts = [];
      var historyInserts = [];
      var occDeletes = [];
      var pendingEvents = [];
      var ruleUpdates = [];
      var ruleDeletes = [];

      function flush() {
        _persistBatch_(occUpserts, historyInserts, occDeletes, ruleUpdates, ruleDeletes);
        _publishPendingEvents_(pendingEvents);
        occUpserts = []; historyInserts = []; occDeletes = []; ruleUpdates = []; pendingEvents = []; ruleDeletes = [];
      }
      function flushIfNeeded() {
        if (occUpserts.length + historyInserts.length + occDeletes.length + ruleUpdates.length + ruleDeletes.length >= BATCH_WRITE_CHUNK_SIZE) {
          flush();
        }
      }

      for (var r = 0; r < allRules.length; r++) {
        var ruleRow = allRules[r];
        taskIdsWithRules[ruleRow.task_id] = true;
        if (ruleRow.rule_status === 'active') {
          activeRules.push(ruleRow);
        } else {
          ruleDeletes.push(ruleRow.rule_id); // 人工改过状态但还没被删掉的行，一并清理
          flushIfNeeded();
        }
      }

      var pendingTasks = QueryEngine.getPendingTasks();
      var pendingTaskById = {};
      pendingTasks.forEach(function (t) { pendingTaskById[t.task_id] = t; });

      var ruleGenResult = _ensureRulesFromPolicy_(pendingTasks, taskIdsWithRules);
      var newDefaultRules = ruleGenResult.rules;
      if (newDefaultRules.length > 0) {
        SheetUtils.batchUpsertRowsByKey_(RULES_SHEET, 'rule_id', newDefaultRules);
        activeRules = activeRules.concat(newDefaultRules);
      }
      stats.defaultRulesCreated = ruleGenResult.defaultRulesCreated;
      stats.overrideRulesCreated = ruleGenResult.overrideRulesCreated;

      // Occurrences 有界，整表读没问题（跟上面 Rules 同理）
      var occurrenceByKey = {};
      _readAllRows_(OCCURRENCES_SHEET).forEach(function (o) { occurrenceByKey[o.idempotency_key] = o; });

      for (var i = 0; i < activeRules.length; i++) {
        if (Date.now() - startedAt > EXECUTION_TIME_BUDGET_MS) {
          Logger.log('[ReminderEngine] 时间预算耗尽，剩余规则留给下次触发器');
          break;
        }
        var rule = activeRules[i];
        stats.rulesChecked++;
        var task = pendingTaskById[rule.task_id];

        if (!task) {
          // design doc §5 step 4：task 不在这一轮的 pending 集合里 → 取消
          for (var key in occurrenceByKey) {
            var occ = occurrenceByKey[key];
            if (occ.rule_id === rule.rule_id &&
              (occ.status === 'pending' || occ.status === 'failed' || occ.status === 'snoozed')) {
              historyInserts.push(_toHistoryRecord_(occ, 'cancelled', 'task_no_longer_pending', 'pre_due', rule.source));
              occDeletes.push(occ.idempotency_key);
              pendingEvents.push(_reminderEvent_('REMINDER_CANCELLED', occ, 'task_no_longer_pending'));
              stats.cancelled++;
            }
          }
          ruleDeletes.push(rule.rule_id);
          flushIfNeeded();
          continue;
        }

        var effectiveDue = _resolveEffectiveDueDatetime_(task);
        if (!effectiveDue) continue;

        var channels = _parseJsonSafe_(rule.channels, ['telegram']);
        // 🐛 bugfix（外部审计 HIGH RISK 1，2026-07-15，核实属实后采纳，
        // 实测复现）：resolved_fire_ats 里每个 channel 存的值，语义从
        // "上次为这个 channel 解决掉的 fire_at"改成"上次解决掉这个
        // channel 时，effectiveDue（任务的到期时间）是多少"。字段名本身
        // 不改（rule.resolved_fire_ats 仍然对应 ReminderRules 表头那一
        // 列的物理列名——重命名列头是数据迁移级别的变动，不是这次修复
        // 的必要部分），只改存进去的值和比较方式，所以下面本地变量改叫
        // resolvedDueAts 以准确反映新语义，跟 rule.resolved_fire_ats
        // 这个列名区分开。
        //
        // 原来的问题：直接比较 fireAt 大小（fireAt <= lastResolved 就
        // 跳过），隐含假设"同一个 channel 再次算出的 fireAt 只会不变或
        // 变大"——这个假设只在"任务的到期时间不变或后移"时成立。一旦
        // 用户把一个已经解决过的、还在 pending 的任务的到期时间改早，
        // 重新算出的 fireAt 会跟着变小，反而满足"<= 上次"，被误判成
        // "已经处理过"而跳过，用户收不到新到期时间对应的提醒——这正是
        // 审计报告描述、且能通过下面场景F复现的问题。
        //
        // 现在改成直接比对 effectiveDue 本身是否等于"上次解决这个
        // channel 时的 effectiveDue"：到期时间没变就不重复处理（跟原来
        // 行为一致）；变了——不管是改早还是改晚——都判定为需要重新评估，
        // 交给下面 fireAt 相关的时间判断决定现在要不要真的发送。这更准确
        // 地对应"到期时间变了，这个 channel 的 offset 提醒也要跟着重新
        // 算"这个设计初衷，而不是隐含一个"到期时间只会后移"的假设。
        var resolvedDueAts = _parseJsonSafe_(rule.resolved_fire_ats, {});
        var ruleResolvedChanged = false;

        for (var c = 0; c < channels.length; c++) {
          var channel = channels[c];
          var fireAt = new Date(effectiveDue.getTime() - rule.offset_minutes * 60000);

          var lastResolvedDue = resolvedDueAts[channel] ? new Date(resolvedDueAts[channel]) : null;
          if (lastResolvedDue && lastResolvedDue.getTime() === effectiveDue.getTime()) continue;
          if (fireAt.getTime() > Date.now()) continue; // 还没到时间

          var idempotencyKey = _computeIdempotencyKey_(rule.rule_id, channel, fireAt);
          var occurrence = occurrenceByKey[idempotencyKey];
          if (!occurrence) {
            occurrence = {
              idempotency_key: idempotencyKey,
              rule_id: rule.rule_id,
              task_id: rule.task_id,
              chat_id: rule.chat_id,
              channel: channel,
              computed_fire_at: fireAt.toISOString(),
              status: 'pending',
              attempt_count: 0,
              last_attempt_at: '',
              snoozed_until: ''
            };
            occurrenceByKey[idempotencyKey] = occurrence;
          }

          if (occurrence.status === 'snoozed') continue; // 预留状态，V1 没有代码路径会产生它

          if (_isWithinQuietHours_(new Date())) {
            occUpserts.push(occurrence); // 物化但不发送，留到下一轮 Quiet Hours 结束后
            flushIfNeeded();
            continue;
          }

          var sendResult = Output.send(channel, rule.chat_id, _formatMessage_(rule, task, effectiveDue), {
            keyboard: _buildKeyboard_(task)
          });
          occurrence.attempt_count = (occurrence.attempt_count || 0) + 1;
          occurrence.last_attempt_at = new Date().toISOString();

          if (sendResult && sendResult.ok) {
            historyInserts.push(_toHistoryRecord_(occurrence, 'sent', 'delivered', 'pre_due', rule.source));
            occDeletes.push(idempotencyKey);
            pendingEvents.push(_reminderEvent_('REMINDER_SENT', occurrence, 'delivered'));
            resolvedDueAts[channel] = effectiveDue.toISOString();
            ruleResolvedChanged = true;
            stats.sent++;
          } else if (occurrence.attempt_count >= MAX_RETRY_ATTEMPTS) {
            historyInserts.push(_toHistoryRecord_(occurrence, 'failed', (sendResult && sendResult.error) || 'unknown', 'pre_due', rule.source));
            occDeletes.push(idempotencyKey);
            pendingEvents.push(_reminderEvent_('REMINDER_FAILED', occurrence, (sendResult && sendResult.error) || 'unknown'));
            resolvedDueAts[channel] = effectiveDue.toISOString();
            ruleResolvedChanged = true;
            stats.failed++;
          } else {
            occurrence.status = 'failed'; // 还在重试预算内，留到下一轮再试
            occUpserts.push(occurrence);
          }

          flushIfNeeded();
        }

        if (ruleResolvedChanged) {
          ruleUpdates.push({ rule_id: rule.rule_id, resolved_fire_ats: JSON.stringify(resolvedDueAts) });
        }
      }

      // MEDIUM RISK 1 fix：ruleDeletes 现在跟其余批量数组走同一条 flush
      // 路径（循环内已经在 flushIfNeeded 里分批处理过一部分），这里只是
      // 收尾——把最后不满一批的剩余部分写掉，不再需要额外的同步 forEach
      // 逐个删除。
      flush();

      // 【2026-07-19 新增，Unified Reminder Engine】Overdue 阶段——复用
      // 上面已经查过的同一份 pendingTasks（不重新查一次 QueryEngine），
      // 在 Pre-Due 阶段的批量持久化（flush()）完成之后跑，两个阶段共用
      // 同一把锁、同一次 EXECUTION_TIME_BUDGET_MS 预算，不是独立的第二次
      // 加锁/查询。
      var overdueResult = _processOverdueStage_(pendingTasks, new Date());
      stats.overdueSent = overdueResult.overdueSent;

      return stats;
    } finally {
      lock.releaseLock();
    }
  }

  return {
    checkOffsetReminders: checkOffsetReminders,
    // 以下几个仅为单元测试暴露，不是给其他文件调用的公开 API
    _resolveEffectiveDueDatetime_: _resolveEffectiveDueDatetime_,
    _computeIdempotencyKey_: _computeIdempotencyKey_,
    _isWithinQuietHours_: _isWithinQuietHours_,
    _offsetLabel_: _offsetLabel_,
    _offsetToMinutes_: _offsetToMinutes_,
    _ensureRulesFromPolicy_: _ensureRulesFromPolicy_,
    _ensureDefaultRules_: _ensureDefaultRules_, // @deprecated 别名，见该函数头注释
    _lookupPriorityConfig_: _lookupPriorityConfig_,
    _processOverdueStage_: _processOverdueStage_,
    _formatOverdueMessage_: _formatOverdueMessage_,
    // 【2026-07-19 refinement，Carson："fully configurable"】这两份 CONFIG
    // 直接导出（不是拷贝），线上运行时可以在 Apps Script 编辑器里临时改
    // ReminderEngine.OVERDUE_POLICY_CONFIG.LOW.enabled 之类的值做快速验证
    // （改动只在当次执行进程内生效，不持久化——真正要永久调整还是改这个
    // 文件顶部的常量），单元测试也是通过这个导出直接验证 enabled/
    // max_repeats 等字段的效果，不需要为了测试专门开后门。
    DEFAULT_REMINDER_POLICY_CONFIG: DEFAULT_REMINDER_POLICY_CONFIG,
    OVERDUE_POLICY_CONFIG: OVERDUE_POLICY_CONFIG,
    QUIET_HOURS_CONFIG: QUIET_HOURS_CONFIG
  };
})();

/**
 * 顶层 trigger 绑定函数——GAS 的 time-based trigger 只能绑定全局函数名，
 * 不能绑定 IIFE 内部方法。【2026-07-19，Unified Reminder Engine】函数名
 * 保留 checkOffsetReminders 不改——11_Setup.gs 的 createTriggers()
 * 不需要跟着改触发器绑定的名字，降低这次改动的连带范围；这个名字现在
 * 触发的是 Pre-Due + Overdue 两个阶段，不再只是"Offset"，但改名字牵动
 * 触发器重新绑定，价值不足以抵消风险，保留旧名字是刻意决定，不是疏漏。
 */
function checkOffsetReminders() {
  return ReminderEngine.checkOffsetReminders();
}
