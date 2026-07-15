/**
 * 12_TemporalEngine.gs
 * Personal AI 平台级能力 — 通用日期规则计算引擎（A1 实现）
 *
 * Contract 见 00_Governance/00_ADR_004_Temporal_Engine_Design.gs，这里
 * 只是实现，不重复解释设计理由，只在需要说明"代码为什么这样写"时加注释。
 *
 * ⚠️ 不知道"提醒"是什么，不知道 task/chat_id/Telegram/Sheet。这个文件
 * 不调用本项目任何其他文件的函数（连看起来通用的 parseDueDate_ 都不用），
 * 只用 JS/GAS 内建的 Date/Array/Math——保证以后能整份文件复制到
 * Finance OS/Vehicle OS 等全新项目里直接跑，不需要带着本项目的其他文件
 * 一起搬。Pure Function：无 IO、无 Logger、不读当前时间，只用传入的参数
 * 计算，同样的输入永远得到同样的输出。
 *
 * 2026-07-13 补丁：UEF Disposition Review 的 Fix Now 项（Finding 1、
 * Finding 2）。不涉及 Contract 支持的五种 type、不涉及 V1 已确定的行为
 * （闰年跳过、31号月末溢出等），纯粹是收紧对"不合法输入"的处理——
 * 详见各自改动点旁的注释。Finding 3（Object.freeze）当时按 disposition
 * 结论 Fix Later，这份补丁不包含。
 *
 * 2026-07-15 补丁：外部审计独立重新发现 Finding 3（Schedule Model
 * 不可变约定没有运行时强制），予以采纳，parseRule 现在 return 之前
 * Object.freeze(schedule)——详见 parseRule 里对应改动点的注释。
 */

var TemporalEngine = (function () {

  var VALID_TYPES = ['daily', 'weekly', 'monthly', 'yearly', 'every_n_days'];
  var MAX_OCCURRENCES = 1000; // Performance Guard，见 ADR-004
  var MONTHLY_SEARCH_LIMIT = 48; // 4年，防御性上限（day_of_month 缺失月份的
                                  // 实际最大间隔远小于这个，留足够余量）
  var YEARLY_SEARCH_LIMIT = 12;  // 世纪闰年（如2100年不是闰年）会让两次
                                  // 2/29出现的间隔拉长到8年，12年留足余量

  // ============ 内部工具（纯函数，不导出）============

  function _isInt(n) {
    return typeof n === 'number' && isFinite(n) && Math.floor(n) === n;
  }

  function _daysInMonth(year, month /* 0-11 */) {
    return new Date(year, month + 1, 0).getDate();
  }

  function _atMinutePrecision(d) {
    var copy = new Date(d.getTime());
    copy.setSeconds(0, 0);
    return copy;
  }

  function _buildOccurrence(year, month /*0-11*/, day, hour, minute) {
    return new Date(year, month, day, hour, minute, 0, 0);
  }

  // 独立的 'YYYY-MM-DD' 解析，不复用 21_SheetUtils.gs 的 parseDueDate_——
  // 理由见 ADR-004「Dependency Rule」：Temporal Engine 不依赖本项目任何
  // 其他文件，即使逻辑上有点重复。
  function _parseDateOnly(raw, fieldName) {
    var m = typeof raw === 'string' && raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) {
      throw new Error('TemporalEngine.parseRule: ' + fieldName + ' 必须是 "YYYY-MM-DD" 格式的字符串，收到: ' + raw);
    }
    var year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
    if (month < 1 || month > 12) {
      throw new Error('TemporalEngine.parseRule: ' + fieldName + ' 的月份不合法: ' + raw);
    }
    if (day < 1 || day > _daysInMonth(year, month - 1)) {
      throw new Error('TemporalEngine.parseRule: ' + fieldName + ' 的日期不合法（这个月没有这一天）: ' + raw);
    }
    return { year: year, month: month - 1, day: day };
  }

  // ============ parseRule ============

  function parseRule(ruleSpec) {
    if (!ruleSpec || typeof ruleSpec !== 'object') {
      throw new Error('TemporalEngine.parseRule: ruleSpec 必须是一个 object');
    }
    if (VALID_TYPES.indexOf(ruleSpec.type) === -1) {
      throw new Error('TemporalEngine.parseRule: 不认识的 type "' + ruleSpec.type + '"，只支持 ' + VALID_TYPES.join('/'));
    }
    if (typeof ruleSpec.time !== 'string' || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(ruleSpec.time)) {
      throw new Error('TemporalEngine.parseRule: time 必须是 "HH:mm" 格式的字符串，收到: ' + ruleSpec.time);
    }
    var timeParts = ruleSpec.time.split(':');
    var hour = Number(timeParts[0]);
    var minute = Number(timeParts[1]);

    var schedule = {
      type: ruleSpec.type,
      interval: 1,
      hour: hour,
      minute: minute
    };

    if (ruleSpec.type === 'every_n_days') {
      if (!_isInt(ruleSpec.interval) || ruleSpec.interval < 1) {
        throw new Error('TemporalEngine.parseRule: every_n_days 需要 interval 是 >=1 的整数，收到: ' + ruleSpec.interval);
      }
      schedule.interval = ruleSpec.interval;

      var anchor = _parseDateOnly(ruleSpec.start_date, 'start_date');
      schedule.startYear = anchor.year;
      schedule.startMonth = anchor.month;
      schedule.startDay = anchor.day;
    } else if (ruleSpec.interval !== undefined && ruleSpec.interval !== 1) {
      // V1 明确不支持 daily/weekly/monthly/yearly 的 interval>1（每N周/每N月/每N年）
      throw new Error('TemporalEngine.parseRule: interval 只对 every_n_days 生效，"' +
        ruleSpec.type + '" 不支持 interval=' + ruleSpec.interval +
        '（V1 明确不支持"每N周/每N月/每N年"，见 ADR-004）');
    }

    if (ruleSpec.type === 'weekly') {
      if (!Array.isArray(ruleSpec.days_of_week) || ruleSpec.days_of_week.length === 0) {
        throw new Error('TemporalEngine.parseRule: weekly 需要非空的 days_of_week 数组');
      }
      var seen = {};
      var daysOfWeek = [];
      ruleSpec.days_of_week.forEach(function (d) {
        if (!_isInt(d) || d < 0 || d > 6) {
          throw new Error('TemporalEngine.parseRule: days_of_week 里的值必须是 0-6 的整数，收到: ' + d);
        }
        if (!seen[d]) { seen[d] = true; daysOfWeek.push(d); }
      });
      daysOfWeek.sort(function (a, b) { return a - b; });
      schedule.daysOfWeek = daysOfWeek;
    }

    if (ruleSpec.type === 'monthly') {
      if (!_isInt(ruleSpec.day_of_month) || ruleSpec.day_of_month < 1 || ruleSpec.day_of_month > 31) {
        throw new Error('TemporalEngine.parseRule: monthly 需要 day_of_month 是 1-31 的整数，收到: ' + ruleSpec.day_of_month);
      }
      schedule.dayOfMonth = ruleSpec.day_of_month;
    }

    if (ruleSpec.type === 'yearly') {
      if (!_isInt(ruleSpec.month) || ruleSpec.month < 1 || ruleSpec.month > 12) {
        throw new Error('TemporalEngine.parseRule: yearly 需要 month 是 1-12 的整数，收到: ' + ruleSpec.month);
      }
      if (!_isInt(ruleSpec.day) || ruleSpec.day < 1 || ruleSpec.day > 31) {
        throw new Error('TemporalEngine.parseRule: yearly 需要 day 是 1-31 的整数，收到: ' + ruleSpec.day);
      }
      // Disposition Review Finding 2（2026-07-13）：day 是否可能出现在
      // month 里，按闰年评估（2000年是闰年，用它做基准，2/29在这里合法）。
      // 不合法组合（如 2/30、4/31——在任何年份都不可能存在）在这里 throw，
      // 不再流入 _nextYearly 才因 YEARLY_SEARCH_LIMIT 耗尽而失败，报出
      // 跟真实原因无关的错误信息。合法但年份相关的情况（2/29遇到平年）
      // 不受影响，继续交给 _nextYearly 的"跳过不含这天的年份"处理。
      if (ruleSpec.day > _daysInMonth(2000, ruleSpec.month - 1)) {
        throw new Error('TemporalEngine.parseRule: yearly 的 month=' + ruleSpec.month + ' 不可能有 day=' +
          ruleSpec.day + '（该月最多' + _daysInMonth(2000, ruleSpec.month - 1) + '天，按闰年评估）');
      }
      schedule.month = ruleSpec.month;
      schedule.day = ruleSpec.day;
    }

    // 🐛 bugfix（Architecture Review 2026-07-12 Finding 3 / 外部审计 LOW
    // RISK 1，2026-07-15 提升为 Fix Now）：Finding 3 当时 Disposition 是
    // Confirmed，但优先级评估为 Fix Later（跟 Finding 1/2 不同，Finding
    // 1/2 是"不修就可能放行不合法输入"的 Contract 缺口，Finding 3 是
    // "已经承诺的不可变约定没有运行时兜底"——严重度本身评级 LOW，且
    // 评审当时 TemporalEngine 还没有任何真实调用方，"多个模块共享同一个
    // schedule 引用"这个风险还没实际发生，按 Progression Rule 不必抢在
    // 真实需要出现前动手，所以放进 Fix Later 批次，没有跟 Finding 1/2
    // 一起在 2026-07-13 那次патch 里改）。这次外部审计重新独立发现同一个
    // 问题并要求一并修复，评估影响后确认审查报告本身的结论依然成立
    // （"return Object.freeze(schedule); 一行、对现有测试零影响"），予以
    // 采纳。sloppy mode（GAS 默认运行时、这份文件被 eval 进 Node 沙盒时
    // 也是）下对冻结对象赋值会静默失败、不抛错，不会让现有调用方意外
    // 收到新的异常。
    return Object.freeze(schedule); // 不可变约定：从约定升级为运行时强制——
                                     // 冻结后任何后续赋值都会被 silently
                                     // 拒绝（sloppy mode），不再只靠"没有
                                     // 函数提供修改方法"这个弱保证
  }

  // ============ calculateNextOccurrence ============

  function calculateNextOccurrence(schedule, fromTime) {
    var from = _atMinutePrecision(fromTime);

    switch (schedule.type) {
      case 'daily':
        return _nextDaily(schedule, from);
      case 'every_n_days':
        return _nextEveryNDays(schedule, from);
      case 'weekly':
        return _nextWeekly(schedule, from);
      case 'monthly':
        return _nextMonthly(schedule, from);
      case 'yearly':
        return _nextYearly(schedule, from);
      default:
        // Disposition Review Finding 1（2026-07-13）：合法的 ScheduleModel
        // 按定义只可能是以上五种 type 之一——能走到这里，说明 schedule
        // 不是 parseRule 的输出（调用方绕过了 parseRule 直接构造/传入对象，
        // 或者未来新增了 type 但漏改这里的 switch）。throw 而不是静默
        // 返回 undefined：不违反 Contract"输入合法时保证不 throw"的
        // 承诺——按 Contract 定义，不合法的 ScheduleModel 从一开始就
        // 不算"输入合法"，所以这里 throw 是这个承诺的延伸，不是例外。
        throw new Error('TemporalEngine.calculateNextOccurrence: schedule 不是合法的 ScheduleModel（schedule.type="' +
          (schedule && schedule.type) + '"），必须是 parseRule() 的返回值');
    }
  }

  function _nextDaily(schedule, from) {
    var candidate = _buildOccurrence(from.getFullYear(), from.getMonth(), from.getDate(), schedule.hour, schedule.minute);
    if (candidate.getTime() <= from.getTime()) {
      candidate = new Date(candidate.getTime());
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate;
  }

  /**
   * 每N天，以 schedule.startYear/startMonth/startDay 为锚点——不管从
   * 哪个 fromTime 查询，"第几天算一次"永远相对这个锚点计算，保证同一条
   * 规则从不同时间点查询结果一致（这是 A1 实现时补的 Contract 漏洞，
   * 见 ADR-004 修订记录第12条）。
   */
  function _nextEveryNDays(schedule, from) {
    var anchor = _buildOccurrence(schedule.startYear, schedule.startMonth, schedule.startDay, schedule.hour, schedule.minute);

    if (anchor.getTime() > from.getTime()) {
      return anchor; // 锚点本身还没到，第一次触发就是锚点这一天
    }

    var msPerDay = 86400000;
    // 用锚点到 from 的天数差，估算已经过了几个完整周期，一次跳到接近的
    // candidate，避免从锚点开始逐天累加（锚点如果是很久以前，逐天累加
    // 会是一个不必要的长循环）。之后用小步循环收尾，处理夏令时/月长度
    // 不一这类"天数差"不能直接线性换算的边界。
    var approxDaysPassed = Math.round((from.getTime() - anchor.getTime()) / msPerDay);
    var stepsPassed = Math.floor(approxDaysPassed / schedule.interval);
    var candidate = new Date(anchor.getTime());
    candidate.setDate(candidate.getDate() + stepsPassed * schedule.interval);

    // 收尾：可能因为估算误差差1步，前进或（极少数情况）回退，确保最终
    // candidate 是"严格晚于 from 的最小锚点+k*interval天"
    while (candidate.getTime() <= from.getTime()) {
      candidate = new Date(candidate.getTime());
      candidate.setDate(candidate.getDate() + schedule.interval);
    }
    while (true) {
      var prev = new Date(candidate.getTime());
      prev.setDate(prev.getDate() - schedule.interval);
      if (prev.getTime() > from.getTime()) {
        candidate = prev;
      } else {
        break;
      }
    }
    return candidate;
  }

  function _nextWeekly(schedule, from) {
    for (var i = 0; i <= 7; i++) {
      var d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, schedule.hour, schedule.minute, 0, 0);
      if (schedule.daysOfWeek.indexOf(d.getDay()) !== -1 && d.getTime() > from.getTime()) {
        return d;
      }
    }
    // daysOfWeek 非空（parseRule 已校验），7天内必定能找到，走到这里说明
    // 实现有 bug，不是合法的运行时状态
    throw new Error('TemporalEngine: 内部错误，weekly 规则在7天内没找到下一次触发（不应该发生，请检查实现）');
  }

  function _nextMonthly(schedule, from) {
    var year = from.getFullYear();
    var month = from.getMonth(); // 0-11，从当前月开始找
    for (var i = 0; i < MONTHLY_SEARCH_LIMIT; i++) {
      var totalMonth = month + i;
      var y = year + Math.floor(totalMonth / 12);
      var m = totalMonth % 12;
      if (schedule.dayOfMonth <= _daysInMonth(y, m)) {
        var candidate = _buildOccurrence(y, m, schedule.dayOfMonth, schedule.hour, schedule.minute);
        if (candidate.getTime() > from.getTime()) {
          return candidate;
        }
      }
      // 这个月没有这一天（比如31号遇到2月），或者这个月的触发点已经过了
      // → 继续下一次循环，尝试下个月
    }
    throw new Error('TemporalEngine: 内部错误，monthly 规则在' + MONTHLY_SEARCH_LIMIT + '个月内没找到下一次触发（不应该发生，请检查实现）');
  }

  function _nextYearly(schedule, from) {
    var year = from.getFullYear();
    var monthIdx = schedule.month - 1;
    for (var i = 0; i < YEARLY_SEARCH_LIMIT; i++) {
      var y = year + i;
      if (schedule.day <= _daysInMonth(y, monthIdx)) {
        var candidate = _buildOccurrence(y, monthIdx, schedule.day, schedule.hour, schedule.minute);
        if (candidate.getTime() > from.getTime()) {
          return candidate;
        }
      }
      // 这一年这个月没有这一天（闰年2/29遇到平年），或者今年的触发点已经
      // 过了 → 继续下一次循环，尝试下一年
    }
    throw new Error('TemporalEngine: 内部错误，yearly 规则在' + YEARLY_SEARCH_LIMIT + '年内没找到下一次触发（不应该发生，请检查闰年计算或搜索上限）');
  }

  // ============ calculateOccurrences ============

  function calculateOccurrences(schedule, fromTime, untilTime) {
    var from = _atMinutePrecision(fromTime);
    var until = _atMinutePrecision(untilTime);

    if (until.getTime() <= from.getTime()) {
      return [];
    }

    var results = [];
    var cursor = from;
    while (results.length < MAX_OCCURRENCES) {
      var next = calculateNextOccurrence(schedule, cursor);
      if (next.getTime() > until.getTime()) {
        break;
      }
      results.push(next);
      cursor = next;
    }
    return results; // Performance Guard: 硬上限 MAX_OCCURRENCES，见 ADR-004
  }

  // ============ isDue ============

  function isDue(schedule, checkTime) {
    var check = _atMinutePrecision(checkTime);
    // 精确匹配：以 check 前一分钟为 fromTime，看下一次触发是否恰好等于 check。
    // 语义特意收窄，不做"附近/差不多"的模糊判断，见 ADR-004 对这个函数的说明。
    var oneMinuteBefore = new Date(check.getTime() - 60000);
    var next = calculateNextOccurrence(schedule, oneMinuteBefore);
    return next.getTime() === check.getTime();
  }

  return {
    parseRule: parseRule,
    calculateNextOccurrence: calculateNextOccurrence,
    calculateOccurrences: calculateOccurrences,
    isDue: isDue
  };
})();
