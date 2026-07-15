/**
 * 50_SheetUtils_Tests.gs
 * Reminder OS — 21_SheetUtils.gs 的测试
 *
 * 跟 50_TemporalEngine_Tests.gs / 50_ReminderOffsetEngine_Tests.gs 同款
 * 风格：手动 Logger.log PASS/FAIL，不引入新的测试框架依赖。
 *
 * 范围：只覆盖这次外部审计（2026-07-15）新增/修改的函数——parseDueDate_
 * 的 Date 对象兼容、batchReadFieldsByKey_ 的包络读取重写、新增的
 * batchDeleteRowsByKey_。不是 SheetUtils 全部函数的完整回归覆盖：
 * upsertRowByKey_/batchUpsertRowsByKey_/batchUpdateFieldsByKey_/
 * isOverdue_ 这次没有改动，也已经在 25_ReminderEngine.gs /
 * 26_ReminderOffsetEngine.gs 的集成测试里被间接覆盖过，不重复补单测。
 *
 * 涉及 SpreadsheetApp 依赖，只能通过 Node 沙盒（run_sheetutils_tests.js）
 * 运行，不支持直接在 GAS 编辑器里跑——原因跟
 * 50_ReminderOffsetEngine_Tests.gs 一样，见那份文件头部说明。
 */

function runSheetUtilsTests() {
  if (typeof global === 'undefined' || typeof global.__resetStore !== 'function') {
    var envMsg = '[SheetUtilsTests] 这份测试套件只能通过 Node 沙盒运行' +
      '（项目根目录下执行 node run_sheetutils_tests.js），不支持直接在 GAS 编辑器里跑——' +
      '它依赖 mocks.js 提供的内存版 SpreadsheetApp，GAS 运行时既没有 Node 的 global ' +
      '对象，也不会加载这份 mock。';
    Logger.log('❌ ' + envMsg);
    throw new Error(envMsg);
  }

  var pass = 0, fail = 0;

  function check(label, actual, expected) {
    var actualStr = JSON.stringify(actual);
    var expectedStr = JSON.stringify(expected);
    if (actualStr === expectedStr) {
      pass++;
    } else {
      fail++;
      Logger.log('❌ FAIL: ' + label + '\n   期望: ' + expectedStr + '\n   实际: ' + actualStr);
    }
  }

  function checkTrue(label, actual) {
    if (actual === true) { pass++; } else { fail++; Logger.log('❌ FAIL: ' + label + ' (期望 true, 实际 ' + actual + ')'); }
  }

  Logger.log('========== SheetUtils 测试开始 ==========');

  // ---------- parseDueDate_：既有行为不应该被这次加固改变 ----------
  check('parseDueDate_: YYYY-MM-DD字符串应解析出正确年份',
    SheetUtils.parseDueDate_('2026-07-30').getFullYear(), 2026);
  checkTrue('parseDueDate_: YYYY-MM-DD字符串（无时间部分）应该是本地午夜',
    SheetUtils.parseDueDate_('2026-07-30').getHours() === 0);
  check('parseDueDate_: 完整ISO字符串应正常解析出小时',
    SheetUtils.parseDueDate_('2026-07-30T10:00:00').getHours(), 10);

  // 🐛 bugfix回归（2026-07-15，GAS Console 实测 TypeError:
  // raw.match is not a function）：Sheets 对日期/日期时间格式的单元格，
  // getValues() 会直接返回原生 Date 对象，不是字符串。
  var nativeDate = new Date(2026, 6, 30, 14, 30, 0);
  var parsedFromDate = SheetUtils.parseDueDate_(nativeDate);
  checkTrue('parseDueDate_: 传入原生Date对象不应该抛错', parsedFromDate instanceof Date);
  check('parseDueDate_: 传入原生Date对象应该得到等值的时间', parsedFromDate.getTime(), nativeDate.getTime());
  checkTrue('parseDueDate_: 传入Date对象应该返回拷贝，不是同一个引用（防御性，避免调用方意外共享可变引用）',
    parsedFromDate !== nativeDate);

  // ---------- batchReadFieldsByKey_ ----------
  global.__resetStore();
  global.__seedSheet('TestTasks',
    ['task_id', 'title', 'status', 'reminder_count', 'last_reminder_at'],
    [
      { task_id: 'T-1', title: '任务一', status: 'PENDING', reminder_count: 2, last_reminder_at: '2026-07-01T00:00:00Z' },
      { task_id: 'T-2', title: '任务二', status: 'PENDING', reminder_count: 0, last_reminder_at: '' },
      { task_id: 'T-3', title: '任务三', status: 'DONE', reminder_count: 5, last_reminder_at: '2026-07-10T00:00:00Z' },
      { task_id: 'T-4', title: '任务四', status: 'PENDING', reminder_count: 1, last_reminder_at: '2026-07-05T00:00:00Z' }
    ]);

  // 命中的 key 故意跳着选（T-1 和 T-4，中间隔着 T-2/T-3），验证新的
  // "包络读取"重写不会因为命中的行不连续而读串数据。
  var readResult = SheetUtils.batchReadFieldsByKey_(
    'TestTasks', 'task_id', ['T-1', 'T-4', 'T-NOT-EXIST'], ['reminder_count', 'last_reminder_at']);
  check('batchReadFieldsByKey_: 命中的key数量应该是2（T-NOT-EXIST不存在，不出现在结果里）',
    Object.keys(readResult).length, 2);
  check('batchReadFieldsByKey_: T-1的reminder_count应该正确', readResult['T-1'].reminder_count, 2);
  check('batchReadFieldsByKey_: T-4的reminder_count应该正确（验证不连续命中行不会读串到别的行）',
    readResult['T-4'].reminder_count, 1);
  check('batchReadFieldsByKey_: T-4的last_reminder_at应该正确',
    readResult['T-4'].last_reminder_at, '2026-07-05T00:00:00Z');
  checkTrue('batchReadFieldsByKey_: 没有要求读取的字段（title）不应该出现在返回对象里',
    readResult['T-1'].title === undefined);
  check('batchReadFieldsByKey_: 一个key都没命中时应该返回空对象',
    Object.keys(SheetUtils.batchReadFieldsByKey_('TestTasks', 'task_id', ['NOPE'], ['reminder_count'])).length, 0);
  check('batchReadFieldsByKey_: fields全部不存在于表头时应该返回每个命中key对应一个空对象',
    SheetUtils.batchReadFieldsByKey_('TestTasks', 'task_id', ['T-1'], ['not_a_real_field']),
    { 'T-1': {} });

  // ---------- batchDeleteRowsByKey_ ----------
  global.__resetStore();
  global.__seedSheet('TestRules',
    ['rule_id', 'value'],
    [
      { rule_id: 'R-1', value: 'a' },
      { rule_id: 'R-2', value: 'b' },
      { rule_id: 'R-3', value: 'c' },
      { rule_id: 'R-4', value: 'd' },
      { rule_id: 'R-5', value: 'e' }
    ]);
  // 故意删中间和两端混合的行（R-2、R-4），验证降序删除不会因为前一次
  // 删除导致后面待删的行号整体错位——如果实现漏掉降序排序，这个用例
  // 会失败（会错误删掉 R-3 或 R-5，而不是精确删掉 R-2/R-4）。
  var deleteResult = SheetUtils.batchDeleteRowsByKey_('TestRules', 'rule_id', ['R-2', 'R-4', 'R-NOT-EXIST']);
  check('batchDeleteRowsByKey_: 应该成功删除2行', deleteResult.deleted, 2);
  check('batchDeleteRowsByKey_: notFound应该包含不存在的key', deleteResult.notFound, ['R-NOT-EXIST']);
  var remaining = global.__readSheetRows('TestRules');
  check('batchDeleteRowsByKey_: 剩余行数应该是3', remaining.length, 3);
  var remainingIds = remaining.map(function (r) { return r.rule_id; }).sort();
  check('batchDeleteRowsByKey_: 剩余的应该正好是R-1/R-3/R-5（没有删错行/漏删/多删）',
    remainingIds, ['R-1', 'R-3', 'R-5']);
  check('batchDeleteRowsByKey_: 空keyValues数组应该是no-op，返回deleted:0',
    SheetUtils.batchDeleteRowsByKey_('TestRules', 'rule_id', []), { deleted: 0, notFound: [] });

  Logger.log('========== SheetUtils 测试结束: ' + pass + ' passed, ' + fail + ' failed ==========');
  return { pass: pass, fail: fail };
}
