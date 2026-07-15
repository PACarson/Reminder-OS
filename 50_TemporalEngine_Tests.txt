/**
 * 50_TemporalEngine_Tests.gs
 * Reminder OS — Testing/Unit Tests（这个 blueprint 层第一次有内容）
 *
 * 覆盖 00_ADR_004_Temporal_Engine_Design.gs 里的 Test Matrix。GAS 没有
 * 现成的单元测试框架，这里跟 1_Foundation/11_Setup.gs 的 runDiagnostics()
 * 一样的风格——一个可以在 Apps Script 编辑器里手动跑的函数，用
 * Logger.log 输出 PASS/FAIL，不引入外部测试库依赖。
 *
 * 用法：在 Apps Script 编辑器里选中 runTemporalEngineTests 跑一次，看
 * 执行日志（Ctrl+Enter 或 View > Logs）。
 */

function runTemporalEngineTests() {
  var pass = 0;
  var fail = 0;

  function check(name, actual, expected) {
    var a = (actual instanceof Date) ? actual.toISOString() : JSON.stringify(actual);
    var e = (expected instanceof Date) ? expected.toISOString() : JSON.stringify(expected);
    if (a === e) {
      pass++;
    } else {
      fail++;
      Logger.log('❌ FAIL: ' + name + '\n   expected: ' + e + '\n   actual:   ' + a);
    }
  }

  function checkThrows(name, fn) {
    try {
      fn();
      fail++;
      Logger.log('❌ FAIL (应该 throw 但没有): ' + name);
    } catch (e) {
      pass++;
    }
  }

  Logger.log('========== TemporalEngine 测试开始 ==========');

  // ---------- daily ----------
  var daily = TemporalEngine.parseRule({ type: 'daily', time: '09:00' });
  check('daily: from早于今天触发点 -> 今天9点',
    TemporalEngine.calculateNextOccurrence(daily, new Date(2026, 6, 6, 7, 0)),
    new Date(2026, 6, 6, 9, 0));
  check('daily: from晚于今天触发点 -> 明天9点',
    TemporalEngine.calculateNextOccurrence(daily, new Date(2026, 6, 6, 10, 0)),
    new Date(2026, 6, 7, 9, 0));
  check('daily: from恰好等于触发点 -> 明天（不是同一时刻）',
    TemporalEngine.calculateNextOccurrence(daily, new Date(2026, 6, 6, 9, 0)),
    new Date(2026, 6, 7, 9, 0));

  // ---------- weekly ----------
  var weeklyMon = TemporalEngine.parseRule({ type: 'weekly', days_of_week: [1], time: '08:00' });
  check('weekly: 单一星期几，from早于本周触发点',
    TemporalEngine.calculateNextOccurrence(weeklyMon, new Date(2026, 6, 6, 7, 0)),
    new Date(2026, 6, 6, 8, 0));
  check('weekly: 单一星期几，from晚于本周触发点 -> 下周一',
    TemporalEngine.calculateNextOccurrence(weeklyMon, new Date(2026, 6, 6, 9, 0)),
    new Date(2026, 6, 13, 8, 0));

  var weeklyMultiple = TemporalEngine.parseRule({ type: 'weekly', days_of_week: [1, 3, 5], time: '08:00' });
  check('weekly: 多个星期几，from周二 -> 周三',
    TemporalEngine.calculateNextOccurrence(weeklyMultiple, new Date(2026, 6, 7, 12, 0)),
    new Date(2026, 6, 8, 8, 0));

  // ---------- monthly ----------
  var monthly15 = TemporalEngine.parseRule({ type: 'monthly', day_of_month: 15, time: '10:00' });
  check('monthly: 基本情况，from早于15号',
    TemporalEngine.calculateNextOccurrence(monthly15, new Date(2026, 6, 1, 0, 0)),
    new Date(2026, 6, 15, 10, 0));
  check('monthly: 基本情况，from晚于15号 -> 下个月',
    TemporalEngine.calculateNextOccurrence(monthly15, new Date(2026, 6, 20, 0, 0)),
    new Date(2026, 7, 15, 10, 0));

  var monthly31 = TemporalEngine.parseRule({ type: 'monthly', day_of_month: 31, time: '09:00' });
  check('monthly: 31号规则，从4月查询（4月只有30天）-> 跳到5月31号',
    TemporalEngine.calculateNextOccurrence(monthly31, new Date(2026, 3, 5, 0, 0)),
    new Date(2026, 4, 31, 9, 0));

  var monthly30 = TemporalEngine.parseRule({ type: 'monthly', day_of_month: 30, time: '09:00' });
  check('monthly: 30号规则，从2月查询（2026非闰年，2月28天）-> 跳到3月30号',
    TemporalEngine.calculateNextOccurrence(monthly30, new Date(2026, 1, 5, 0, 0)),
    new Date(2026, 2, 30, 9, 0));

  // ---------- yearly ----------
  var yearlyBirthday = TemporalEngine.parseRule({ type: 'yearly', month: 3, day: 15, time: '00:00' });
  check('yearly: 基本情况，从1月查询 -> 当年3月15日',
    TemporalEngine.calculateNextOccurrence(yearlyBirthday, new Date(2026, 0, 1, 0, 0)),
    new Date(2026, 2, 15, 0, 0));
  check('yearly: 基本情况，从3月15日之后查询 -> 明年',
    TemporalEngine.calculateNextOccurrence(yearlyBirthday, new Date(2026, 5, 1, 0, 0)),
    new Date(2027, 2, 15, 0, 0));

  var leapBirthday = TemporalEngine.parseRule({ type: 'yearly', month: 2, day: 29, time: '00:00' });
  check('yearly: 2/29生日，从2025（平年）查询 -> 下一个闰年2028',
    TemporalEngine.calculateNextOccurrence(leapBirthday, new Date(2025, 0, 1, 0, 0)),
    new Date(2028, 1, 29, 0, 0));
  check('yearly: 2/29生日，世纪年边界（2100不是闰年）应跳到2104',
    TemporalEngine.calculateNextOccurrence(leapBirthday, new Date(2096, 2, 1, 0, 0)),
    new Date(2104, 1, 29, 0, 0));

  // ---------- every_n_days ----------
  var everyNDays3 = TemporalEngine.parseRule({ type: 'every_n_days', interval: 3, start_date: '2026-07-01', time: '09:00' });
  check('every_n_days: from早于start_date -> 第一次就是start_date本身',
    TemporalEngine.calculateNextOccurrence(everyNDays3, new Date(2026, 5, 1, 0, 0)),
    new Date(2026, 6, 1, 9, 0));
  check('every_n_days: from紧跟start_date之后 -> start_date+3天',
    TemporalEngine.calculateNextOccurrence(everyNDays3, new Date(2026, 6, 1, 10, 0)),
    new Date(2026, 6, 4, 9, 0));
  check('every_n_days: 同一条规则从不落在周期上的日期查询，结果仍要跟锚点一致',
    TemporalEngine.calculateNextOccurrence(everyNDays3, new Date(2026, 6, 11, 0, 0)),
    new Date(2026, 6, 13, 9, 0));

  var everyNDays1 = TemporalEngine.parseRule({ type: 'every_n_days', interval: 1, start_date: '2026-01-01', time: '09:00' });
  check('every_n_days: N=1 等同于daily',
    TemporalEngine.calculateNextOccurrence(everyNDays1, new Date(2026, 6, 6, 7, 0)),
    new Date(2026, 6, 6, 9, 0));

  // ---------- 边界：fromTime/untilTime 恰好命中触发点 ----------
  var occ = TemporalEngine.calculateOccurrences(daily, new Date(2026, 6, 6, 9, 0), new Date(2026, 6, 9, 9, 0));
  check('calculateOccurrences: fromTime恰好命中应排除，untilTime恰好命中应包含，数量',
    occ.length, 3);
  check('calculateOccurrences: 第一个结果应该是7/7不是7/6（fromTime本身排除）',
    occ[0], new Date(2026, 6, 7, 9, 0));
  check('calculateOccurrences: 最后一个结果应该是7/9（untilTime本身包含）',
    occ[occ.length - 1], new Date(2026, 6, 9, 9, 0));

  var emptyOcc = TemporalEngine.calculateOccurrences(daily, new Date(2026, 6, 9, 0, 0), new Date(2026, 6, 6, 0, 0));
  check('calculateOccurrences: untilTime<=fromTime应返回空数组，不throw',
    emptyOcc, []);

  // Disposition Review Finding 4（2026-07-13）：MAX_OCCURRENCES 硬上限之前
  // 没有自动化测试覆盖。daily 规则跨 10 年多的区间，potential occurrence
  // 数远超 1000（约3800+天），应该被截断在 1000，不 throw。
  var wideRangeOcc = TemporalEngine.calculateOccurrences(daily, new Date(2016, 0, 1, 0, 0), new Date(2026, 6, 6, 0, 0));
  check('calculateOccurrences: Performance Guard，超过1000个occurrence的范围应截断在1000，不throw',
    wideRangeOcc.length, 1000);

  // ---------- isDue ----------
  check('isDue: 精确命中返回true', TemporalEngine.isDue(daily, new Date(2026, 6, 6, 9, 0)), true);
  check('isDue: 差1分钟返回false', TemporalEngine.isDue(daily, new Date(2026, 6, 6, 9, 1)), false);
  check('isDue: 忽略秒和毫秒（分钟精度）', TemporalEngine.isDue(daily, new Date(2026, 6, 6, 9, 0, 47, 123)), true);

  // ---------- parseRule 非法输入应该 throw ----------
  checkThrows('parseRule: 不认识的type', function () { TemporalEngine.parseRule({ type: 'hourly', time: '09:00' }); });
  checkThrows('parseRule: 缺time', function () { TemporalEngine.parseRule({ type: 'daily' }); });
  checkThrows('parseRule: weekly缺days_of_week', function () { TemporalEngine.parseRule({ type: 'weekly', time: '09:00' }); });
  checkThrows('parseRule: weekly的day值超范围', function () { TemporalEngine.parseRule({ type: 'weekly', days_of_week: [9], time: '09:00' }); });
  checkThrows('parseRule: monthly的day_of_month超范围', function () { TemporalEngine.parseRule({ type: 'monthly', day_of_month: 35, time: '09:00' }); });
  checkThrows('parseRule: yearly的month超范围', function () { TemporalEngine.parseRule({ type: 'yearly', month: 13, day: 1, time: '09:00' }); });
  // Disposition Review Finding 2（2026-07-13）：这两个组合在任何年份都
  // 不可能存在（不是"闰年才有"的2/29那种），应该在parseRule阶段被拒绝，
  // 不应该流到_nextYearly才因搜不到而失败。
  checkThrows('parseRule: yearly不可能的日期组合（2/30，任何年份都不存在）', function () { TemporalEngine.parseRule({ type: 'yearly', month: 2, day: 30, time: '09:00' }); });
  checkThrows('parseRule: yearly不可能的日期组合（4/31，4月最多30天）', function () { TemporalEngine.parseRule({ type: 'yearly', month: 4, day: 31, time: '09:00' }); });
  checkThrows('parseRule: every_n_days缺start_date', function () { TemporalEngine.parseRule({ type: 'every_n_days', interval: 3, time: '09:00' }); });
  checkThrows('parseRule: every_n_days的interval=0', function () { TemporalEngine.parseRule({ type: 'every_n_days', interval: 0, start_date: '2026-01-01', time: '09:00' }); });
  checkThrows('parseRule: daily不该接受interval=2', function () { TemporalEngine.parseRule({ type: 'daily', interval: 2, time: '09:00' }); });
  checkThrows('parseRule: time格式不对', function () { TemporalEngine.parseRule({ type: 'daily', time: '9:00' }); });

  // ---------- calculateNextOccurrence 绕过 parseRule 的防御性测试 ----------
  // Disposition Review Finding 1（2026-07-13）：不通过 parseRule、直接手工
  // 构造一个 type 不在合法五种之内的 schedule 传进来，之前会静默返回
  // undefined，现在应该 throw 一个说明清楚的错误。
  checkThrows('calculateNextOccurrence: 绕过parseRule直接传入不合法type，应该throw而不是静默返回undefined', function () {
    TemporalEngine.calculateNextOccurrence({ type: 'hourly', hour: 9, minute: 0 }, new Date(2026, 6, 6, 7, 0));
  });

  // ---------- Immutable: Schedule Model 不应该被任何函数修改 ----------
  var scheduleForImmutabilityCheck = TemporalEngine.parseRule({ type: 'daily', time: '09:00' });
  var beforeJSON = JSON.stringify(scheduleForImmutabilityCheck);
  TemporalEngine.calculateNextOccurrence(scheduleForImmutabilityCheck, new Date(2026, 6, 6, 7, 0));
  TemporalEngine.calculateOccurrences(scheduleForImmutabilityCheck, new Date(2026, 6, 6, 7, 0), new Date(2026, 6, 10, 7, 0));
  TemporalEngine.isDue(scheduleForImmutabilityCheck, new Date(2026, 6, 6, 9, 0));
  check('Immutable: schedule对象在传给三个计算函数之后不应该被改动',
    JSON.stringify(scheduleForImmutabilityCheck), beforeJSON);

  // 🐛 回归测试（Architecture Review Finding 3 / 外部审计 LOW RISK 1，
  // 2026-07-15）：上面那个测试只验证了"三个计算函数自己不修改
  // schedule"，没有验证"外部直接对 schedule 赋值会不会生效"——parseRule
  // 现在 Object.freeze 了返回值，这里直接补上这一层。
  check('Immutable: parseRule返回的schedule应该是Object.isFrozen',
    Object.isFrozen(scheduleForImmutabilityCheck), true);
  scheduleForImmutabilityCheck.hour = 999; // sloppy mode下对冻结对象赋值会静默失败，不抛错
  check('Immutable: 直接对已冻结的schedule字段赋值应该静默失败、不生效',
    scheduleForImmutabilityCheck.hour, 9);

  // ---------- 两个消费者视角验证（证明没有 Reminder Bias）----------
  // Reminder 视角：每天吃药提醒
  var medsRule = TemporalEngine.parseRule({ type: 'daily', time: '08:00' });
  check('Reminder视角: 每天吃药提醒计算正确',
    TemporalEngine.calculateNextOccurrence(medsRule, new Date(2026, 6, 6, 6, 0)),
    new Date(2026, 6, 6, 8, 0));

  // Finance 视角（mock消费者，不需要真的建Finance OS）：每月15号信用卡账单
  var creditCardRule = TemporalEngine.parseRule({ type: 'monthly', day_of_month: 15, time: '00:00' });
  check('Finance视角(mock): 信用卡账单日计算正确，全程没有涉及任何Reminder专属概念',
    TemporalEngine.calculateNextOccurrence(creditCardRule, new Date(2026, 6, 1, 0, 0)),
    new Date(2026, 6, 15, 0, 0));

  // Vehicle 视角（mock消费者）：每180天保养一次
  var vehicleRule = TemporalEngine.parseRule({ type: 'every_n_days', interval: 180, start_date: '2026-01-01', time: '09:00' });
  check('Vehicle视角(mock): 保养周期计算正确',
    TemporalEngine.calculateNextOccurrence(vehicleRule, new Date(2026, 5, 1, 0, 0)),
    new Date(2026, 5, 30, 9, 0));

  Logger.log('========== TemporalEngine 测试结束: ' + pass + ' passed, ' + fail + ' failed ==========');
  return { pass: pass, fail: fail };
}
