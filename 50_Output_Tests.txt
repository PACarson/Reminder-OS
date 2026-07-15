/**
 * 50_Output_Tests.gs
 * Reminder OS — 40_Output.gs 的测试
 *
 * 跟其余 50_*_Tests.gs 同款风格：手动 Logger.log PASS/FAIL。
 *
 * 范围：只覆盖这次 GAS Console 实测发现的 bug——sendMessage 在 Telegram
 * API 返回 ok:false（比如 chat not found）时，原样转发 Telegram 的原始
 * 响应体，没有补上本函数其余三条失败路径都有的 error 字段，导致调用方
 * （25_ReminderEngine.gs/26_ReminderOffsetEngine.gs）读
 * sendResult.error 永远是 undefined。missing_token/missing_chat_id 两条
 * 分支这次没有改动，顺手一并确认没有被这次修改影响到。
 *
 * 涉及 UrlFetchApp/SecureConfig 依赖，只能通过 Node 沙盒
 * （run_output_tests.js）运行，不支持直接在 GAS 编辑器里跑。
 */

function runOutputTests() {
  if (typeof global === 'undefined' || typeof global.UrlFetchApp === 'undefined') {
    var envMsg = '[OutputTests] 这份测试套件只能通过 Node 沙盒运行' +
      '（项目根目录下执行 node run_output_tests.js），不支持直接在 GAS 编辑器里跑。';
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

  Logger.log('========== Output 测试开始 ==========');

  // ---------- sendMessage: 成功路径不应该被这次修改影响 ----------
  global.__telegramShouldSucceed = true;
  var okResult = Output.sendMessage('CHAT-1', '测试消息');
  check('sendMessage: 成功时ok应该是true', okResult.ok, true);
  check('sendMessage: 成功时应该能读到message_id', okResult.result.message_id, 1);

  // 🐛 bugfix回归（2026-07-15，GAS Console 实测：调用方日志打出
  // "error=undefined"）：Telegram API 返回 ok:false 时（比如 mock 里的
  // 'mock failure'，对应真实场景的 "Bad Request: chat not found"），
  // 原来直接 return body，body 只有 description/error_code，没有 error
  // 字段——调用方统一读的是 sendResult.error。
  global.__telegramShouldSucceed = false;
  var failResult = Output.sendMessage('CHAT-1', '测试消息');
  check('sendMessage: Telegram API级失败时ok应该是false', failResult.ok, false);
  check('sendMessage: 修复后error字段应该正确取到description的值（不再是undefined）',
    failResult.error, 'mock failure');
  check('sendMessage: 原始的description字段应该继续保留（不删信息，只是补齐）',
    failResult.description, 'mock failure');

  // ---------- sendMessage: 另外两条既有失败路径应该维持不变 ----------
  var noTokenSecureConfig = SecureConfig; // 保存引用，测完还原
  global.SecureConfig = { getKey: function () { return null; } };
  var noTokenResult = Output.sendMessage('CHAT-1', '测试消息');
  check('sendMessage: 缺TELEGRAM_TOKEN时应该返回ok:false,error:missing_token（这条路径这次没有改动）',
    noTokenResult, { ok: false, error: 'missing_token' });
  global.SecureConfig = noTokenSecureConfig;

  var noChatResult = Output.sendMessage('', '测试消息');
  check('sendMessage: 缺chatId时应该返回ok:false,error:missing_chat_id（这条路径这次没有改动）',
    noChatResult, { ok: false, error: 'missing_chat_id' });

  // ---------- send('telegram', ...) 适配器应该原样透传同一个修复 ----------
  global.__telegramShouldSucceed = false;
  var adapterResult = Output.send('telegram', 'CHAT-1', '测试消息', {});
  check('send(telegram): 适配器透传的失败结果也应该有正确的error字段（26_ReminderOffsetEngine.gs走的是这条路径）',
    adapterResult.error, 'mock failure');

  Logger.log('========== Output 测试结束: ' + pass + ' passed, ' + fail + ' failed ==========');
  return { pass: pass, fail: fail };
}
