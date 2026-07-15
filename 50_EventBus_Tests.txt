/**
 * 50_EventBus_Tests.gs
 * Reminder OS — 20_EventBus.gs 的测试
 *
 * 跟其余 50_*_Tests.gs 同款风格：手动 Logger.log PASS/FAIL。
 *
 * 范围：只覆盖这次外部审计（2026-07-15，HIGH RISK 2）改动的
 * publishBatch——原来 getLastRow()+setValues() 改成逐行 appendRow()。
 * "改了之后并发场景下不会再丢数据"这件事本身不是单元测试能验证的（要
 * 真的模拟两个独立进程并发写同一个 Sheet，不是这份 mock 基础设施的
 * 目标），这里验证的是"重写之后，正常（非并发）场景下数据依然写得
 * 完全正确"——参数到字段的映射、去重、写入行数都不因为这次重构跑偏。
 * 单条 publish() 这次没有改动，不重复补测。
 *
 * 涉及 SpreadsheetApp 依赖，只能通过 Node 沙盒（run_eventbus_tests.js）
 * 运行，不支持直接在 GAS 编辑器里跑，原因同其余几份 mock 测试文件。
 */

function runEventBusTests() {
  if (typeof global === 'undefined' || typeof global.__resetStore !== 'function') {
    var envMsg = '[EventBusTests] 这份测试套件只能通过 Node 沙盒运行' +
      '（项目根目录下执行 node run_eventbus_tests.js），不支持直接在 GAS 编辑器里跑。';
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

  Logger.log('========== EventBus 测试开始 ==========');

  global.__resetStore();
  global.__seedSheet('Events', ['event_id', 'timestamp', 'type', 'chat_id', 'payload', 'source'], []);

  // ---------- publishBatch: 基本正确性（重写appendRow循环后不应该跑偏）----------
  var published = EventBus.publishBatch([
    { type: 'REMINDER_SENT', payload: { task_id: 'T-1' }, chatId: 'CHAT-1', source: 'ReminderEngine' },
    { type: 'REMINDER_SENT', payload: { task_id: 'T-2' }, chatId: 'CHAT-1', source: 'ReminderEngine' },
    { type: 'REMINDER_FAILED', payload: { task_id: 'T-3' }, chatId: 'CHAT-2', source: 'ReminderOffsetEngine' }
  ]);
  check('publishBatch: 返回的published数组长度应该是3', published.length, 3);

  var eventsAfterFirstBatch = EventBus.getAllEvents();
  check('publishBatch: Events表应该恰好多3行（逐行appendRow不应该多写或漏写）',
    eventsAfterFirstBatch.length, 3);
  check('publishBatch: 第1条的type应该正确', eventsAfterFirstBatch[0].type, 'REMINDER_SENT');
  check('publishBatch: 第3条的type应该正确（验证顺序没有因为改成逐行写而打乱）',
    eventsAfterFirstBatch[2].type, 'REMINDER_FAILED');
  check('publishBatch: 第3条的chat_id应该正确', eventsAfterFirstBatch[2].chat_id, 'CHAT-2');
  check('publishBatch: payload应该被正确写入并可以反序列化',
    eventsAfterFirstBatch[0].payload.task_id, 'T-1');

  // ---------- publishBatch: 连续两次调用，行不应该互相覆盖 ----------
  // 这是HIGH RISK 2原本要防的问题在"同一个执行内"的简化版验证——appendRow
  // 逐行写，不依赖调用前缓存的行号，第二批应该正确追加在第一批之后，
  // 不会覆盖掉第一批已经写入的数据。
  EventBus.publishBatch([
    { type: 'REMINDER_CANCELLED', payload: { task_id: 'T-4' }, chatId: 'CHAT-1', source: 'ReminderOffsetEngine' }
  ]);
  var eventsAfterSecondBatch = EventBus.getAllEvents();
  check('publishBatch: 第二批写入后，总行数应该是4（第一批3条依然都在，没被覆盖）',
    eventsAfterSecondBatch.length, 4);
  check('publishBatch: 第一批的第1条在第二批写入后应该原封不动',
    eventsAfterSecondBatch[0].payload.task_id, 'T-1');
  check('publishBatch: 第二批新增的那一条应该正确追加在末尾',
    eventsAfterSecondBatch[3].payload.task_id, 'T-4');

  // ---------- publishBatch: 执行内去重（identity）应该继续生效 ----------
  var dedupResult = EventBus.publishBatch([
    { type: 'REMINDER_SENT', payload: { task_id: 'T-5' }, chatId: 'CHAT-1', source: 'ReminderEngine', identity: 'DUP-KEY' },
    { type: 'REMINDER_SENT', payload: { task_id: 'T-5-again' }, chatId: 'CHAT-1', source: 'ReminderEngine', identity: 'DUP-KEY' }
  ]);
  check('publishBatch: 同一个identity在同一次调用里应该只写入1条，第2条被去重跳过',
    dedupResult.length, 1);

  // ---------- publishBatch: 空数组/未传入不应该抛错 ----------
  check('publishBatch: 空数组应该返回空数组，不抛错', EventBus.publishBatch([]), []);
  check('publishBatch: 不传参数应该返回空数组，不抛错', EventBus.publishBatch(), []);

  Logger.log('========== EventBus 测试结束: ' + pass + ' passed, ' + fail + ' failed ==========');
  return { pass: pass, fail: fail };
}
