/**
 * 11_Setup.gs   [原 15_Setup.gs — 2026-07-06 按 Domain OS Blueprint 迁入
 * 1_Foundation/（Configuration 子分类为主；runDiagnostics 那部分严格算
 * 是 Testing/Validation，但整份文件不到 40 行，为了不过度拆分（P6）先
 * 放一起，没有强行拆成两个文件，理由见 00_ADR_001_Domain_OS_Blueprint_
 * Adoption.gs 判断5）。
 *
 * ✅ 2026-07-06 更正：上一版这里放的是我（Claude）按文档反推的重建版，
 * 因为你上传的 zip 里 15_Setup.txt 内容意外变成了 12_QueryEngine.txt 的
 * 复制。现在已经收到你的真实代码，替换成下面这份逐字保留的版本，之前的
 * 重建版作废。跟重建版的主要差异：runDiagnostics() 是逐条 Logger.log
 * 输出诊断信息的风格，不返回结构化对象；而且多做了 SPREADSHEET_ID /
 * TELEGRAM_TOKEN 各自独立的存在性检查，比重建版更细。
 * ]
 *
 * 🐛 2026-07-06（同日，稍晚）外部审计修复（MEDIUM RISK 1 关联，核实属实
 * 后采纳）：runDiagnostics() 新增了 Telegram webhook 可达性检查（调
 * getWebhookInfo），其余逻辑逐字未改。完整决策依据见
 * 00_ADR_002_ReminderEngine_Audit_Fixes.txt。
 *
 * 🐛 2026-07-10 第四轮外部审计关联（HIGH RISK 2，核实属实后采纳，完整
 * 决策依据见 00_ADR_002_ReminderEngine_Audit_Fixes.txt「第四轮」）：
 * runDiagnostics() 新增 checkReminders 名下 trigger 数量检查，其余逻辑
 * 逐字未改。这里读的两个 Script Property 键名（
 * REMINDER_ENGINE_RETRY_TRIGGER_ID / REMINDER_ENGINE_RETRY_COUNT）是
 * 硬编码的字符串字面量，跟 2_Runtime/25_ReminderEngine.gs 里
 * RETRY_FLAG_KEY/RETRY_COUNT_KEY 两个常量的实际值必须保持一致——这两个
 * 常量是那个文件 IIFE 内部的私有变量，没有对外暴露，这里没有更干净的
 * 引用方式，只能靠注释手动维护同步，如果以后改了那边的键名，要记得
 * 回来同步这里。
 *
 * Reminder OS v1.0 — 一键初始化
 *
 * ⚠️ 2026-07-03 拆分说明：新文件。Reminder OS 不需要建任何新表——它读写的
 * Tasks 表已经在共享 Spreadsheet 里（由 Productivity OS 项目建），Events
 * 表也已经在（由 Personal AI Core 项目建）。本项目只需要：
 *
 *   1. 设置 SPREADSHEET_ID（跟 Core / Productivity OS 项目一样）：
 *      SecureConfig.setKey('SPREADSHEET_ID', '共享的那个ID')
 *   2. 设置 TELEGRAM_TOKEN、TELEGRAM_CHAT_ID（跟 Core 项目一样的值——
 *      Reminder OS 自己直接发 Telegram 消息，不经过 Core，需要自己的
 *      Token，见本项目 4_Integration/40_Output.gs）
 *   3. 跑一次 createTriggers() —— 挂上 checkReminders（每小时）
 *
 * 不需要 Deploy as Web App（Reminder OS 不接 Telegram webhook，只是被动
 * 触发器 + 主动发消息），也不需要 registerWebhook()。
 *
 * 🆕 2026-07-14（Time-Based Offset Reminder Engine）：上面这段"不需要建
 * 任何新表"从这次起不再完全成立——ReminderRules/ReminderOccurrences/
 * ReminderHistory 三张表由本项目自己拥有，需要额外跑一次
 * setupOffsetReminderSheets()（幂等，已存在就跳过）。createTriggers() 也
 * 相应新增了 checkOffsetReminders（每5分钟）。完整设计依据见
 * Reminder-OS_Time-Based-Reminder-Engine_Design-Proposal.md §9。
 */

function createTriggers() {
  var handlerNames = ['checkReminders', 'checkOffsetReminders'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (handlerNames.indexOf(t.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('checkReminders').timeBased().everyHours(1).create();

  // 🆕 2026-07-14（Time-Based Offset Reminder Engine 设计 §6）：单独的
  // trigger，不是把 checkOffsetReminders 塞进 checkReminders 里合并成
  // 一个——V1 现有的按优先级重复提醒逻辑跟这里新的一次性 offset 提醒是
  // 两套不同的行为，分开挂 trigger 可以让两边独立跑一段时间，不需要
  // 一次性切换。5分钟是 GAS 时间触发器支持的最小粒度，跟设计文档里最细
  // 的 offset 选项（5分钟前）对齐。
  ScriptApp.newTrigger('checkOffsetReminders').timeBased().everyMinutes(5).create();

  Logger.log('✅ Reminder OS 自己的触发器挂好了:');
  Logger.log('  checkReminders — 每小时（V1，按优先级重复提醒）');
  Logger.log('  checkOffsetReminders — 每5分钟（Offset Reminder Engine，一次性提前提醒）');
}

/**
 * 🆕 2026-07-14（Time-Based Offset Reminder Engine 设计 §9 迁移计划）：
 * ReminderRules/ReminderOccurrences/ReminderHistory 三张表由 Reminder OS
 * 自己创建和拥有——不像 Tasks（Productivity OS 建）、Events（Personal AI
 * Core 建）那样已经在共享 Spreadsheet 里，需要专门跑一次这个函数。
 * 幂等：表已存在就跳过，不会清空已有数据、不会重复建。
 */
function setupOffsetReminderSheets() {
  var id = SecureConfig.getKey('SPREADSHEET_ID');
  if (!id) {
    Logger.log('❌ SPREADSHEET_ID 没设置，无法建表');
    return;
  }
  var ss = SpreadsheetApp.openById(id);

  var schemas = {
    ReminderRules: ['rule_id', 'task_id', 'chat_id', 'offset_minutes', 'offset_label',
      'channels', 'rule_status', 'source', 'resolved_fire_ats', 'created_at'],
    ReminderOccurrences: ['idempotency_key', 'rule_id', 'task_id', 'chat_id', 'channel',
      'computed_fire_at', 'status', 'attempt_count', 'last_attempt_at', 'snoozed_until'],
    ReminderHistory: ['idempotency_key', 'rule_id', 'task_id', 'chat_id', 'channel',
      'computed_fire_at', 'final_status', 'attempt_count', 'resolved_at', 'resolved_reason', 'archived_at']
  };

  Object.keys(schemas).forEach(function (sheetName) {
    var sheet = ss.getSheetByName(sheetName);
    if (sheet) {
      Logger.log('ℹ️ ' + sheetName + ' 已存在，跳过（不清空已有数据）');
      return;
    }
    sheet = ss.insertSheet(sheetName);
    sheet.getRange(1, 1, 1, schemas[sheetName].length).setValues([schemas[sheetName]]);
    sheet.setFrozenRows(1);
    Logger.log('✅ 已创建 ' + sheetName + '，表头: ' + schemas[sheetName].join(', '));
  });
}

function runDiagnostics() {
  Logger.log('========== Reminder OS 诊断开始 ==========');

  var id = SecureConfig.getKey('SPREADSHEET_ID');
  if (!id) {
    Logger.log('❌ SPREADSHEET_ID 没设置');
  } else {
    try {
      var sheet = SpreadsheetApp.openById(id).getSheetByName('Tasks');
      if (!sheet) {
        Logger.log('❌ 打开了 Spreadsheet，但找不到 Tasks 表——SPREADSHEET_ID 指对了吗？' +
          '或者先去 Productivity OS 项目跑 setupSheets()');
      } else {
        Logger.log('✅ 能读到 Tasks 表，当前行数（含表头）: ' + sheet.getLastRow());
      }
    } catch (e) {
      Logger.log('❌ 打不开 SPREADSHEET_ID 指定的表: ' + e.message);
    }
  }

  var token = SecureConfig.getKey('TELEGRAM_TOKEN');
  var chatId = SecureConfig.getKey('TELEGRAM_CHAT_ID');
  Logger.log(token ? '✅ TELEGRAM_TOKEN 已设置' : '❌ TELEGRAM_TOKEN 没设置');
  Logger.log(chatId ? '✅ TELEGRAM_CHAT_ID 已设置' : '❌ TELEGRAM_CHAT_ID 没设置');

  // 🐛 新增（2026-07-06，外部审计 MEDIUM RISK 1 关联，核实属实后采纳）：
  // _sendReminder 发的 Done/Snooze 按钮，点击后依赖【另一个项目】
  // （Personal AI Core）注册了 webhook 才能接住 callback_query——本项目
  // 自己不接 webhook（见上方文件头注释）。这里只能检测"webhook 有没有
  // 注册"，检测不了"Core 项目是否正确解析了 task_done:/task_snooze: 这
  // 两种 callback_data"，后者没法从这边验证，完整契约见
  // 0_Governance/00_Project_Constitution.gs 新增的 P6。
  if (token) {
    try {
      var webhookRes = UrlFetchApp.fetch(
        'https://api.telegram.org/bot' + token + '/getWebhookInfo',
        { muteHttpExceptions: true }
      );
      var webhookInfo = JSON.parse(webhookRes.getContentText());
      if (webhookInfo.ok && webhookInfo.result && webhookInfo.result.url) {
        Logger.log('✅ Telegram webhook 已注册: ' + webhookInfo.result.url +
          '（pending_update_count=' + webhookInfo.result.pending_update_count + '）');
        if (webhookInfo.result.last_error_message) {
          Logger.log('⚠️ webhook 最近一次投递报错: ' + webhookInfo.result.last_error_message);
        }
      } else {
        Logger.log('❌ Telegram webhook 未注册（url 为空）——这个 Bot 目前在用 getUpdates/' +
          '长轮询，不是 webhook。如果 Core 项目应该注册了 webhook 来处理本项目提醒消息里的 ' +
          'Done/Snooze 按钮点击，这里说明两边没对齐，用户点按钮不会有任何反应。');
      }
    } catch (e) {
      Logger.log('❌ getWebhookInfo 请求失败: ' + e.message);
    }
  }

  if (chatId) {
    try {
      var res = Output.sendMessage(chatId, '🔧 这是 Reminder OS runDiagnostics() 的测试消息');
      Logger.log('✅ Output.sendMessage 测试结果: ' + JSON.stringify(res));
    } catch (e) {
      Logger.log('❌ Output.sendMessage 报错: ' + e.message);
    }
  }

  try {
    var pending = QueryEngine.getPendingTasks();
    Logger.log('✅ QueryEngine.getPendingTasks() 测试结果，共 ' + pending.length + ' 条（全部用户）');
  } catch (e) {
    Logger.log('❌ QueryEngine.getPendingTasks() 报错: ' + e.message);
  }

  // 🐛 新增（2026-07-10，第四轮外部审计 HIGH RISK 2 关联，核实属实后
  // 采纳）：checkReminders 名下当前的 trigger 数量。稳态应该只有1个
  // （createTriggers() 建的每小时那个）。如果是2个，多半是恰好有一次
  // 锁竞争重试在排队中（正常，见下面的 Script Property 是否也有记录）；
  // 如果超过2个，或者下面显示没有重试记录但数量却大于1，说明大概率是
  // 25_ReminderEngine.gs 的 _cleanupStaleRetryTrigger_ 没生效、trigger
  // 在累积，需要手动排查——临时手段是重新跑一次本文件的 createTriggers()，
  // 它会把 checkReminders 名下所有 trigger 清掉重建。
  var reminderTriggers = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'checkReminders';
  });
  Logger.log((reminderTriggers.length === 1 ? '✅' : '⚠️') +
    ' checkReminders 名下当前有 ' + reminderTriggers.length + ' 个 trigger（稳态应为1个）');
  var retryTriggerId = PropertiesService.getScriptProperties().getProperty('REMINDER_ENGINE_RETRY_TRIGGER_ID');
  var retryCount = PropertiesService.getScriptProperties().getProperty('REMINDER_ENGINE_RETRY_COUNT');
  if (retryTriggerId || retryCount) {
    Logger.log('ℹ️ 当前有锁竞争重试记录在案（trigger id=' + retryTriggerId + '，已重试次数=' +
      (retryCount || '0') + '）——如果上面 trigger 数是2，大概率就是它，不算异常');
  }

  // 🆕 2026-07-14（Time-Based Offset Reminder Engine）：新引擎自己的
  // trigger + 三张自己拥有的表，跟上面 V1 的检查是同一个思路，key 名字
  // 换成这个引擎自己的前缀（见 26_ReminderOffsetEngine.gs 文件头）。
  var offsetTriggers = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'checkOffsetReminders';
  });
  Logger.log((offsetTriggers.length === 1 ? '✅' : '⚠️') +
    ' checkOffsetReminders 名下当前有 ' + offsetTriggers.length + ' 个 trigger（稳态应为1个）');
  var offsetRetryTriggerId = PropertiesService.getScriptProperties().getProperty('REMINDER_OFFSET_ENGINE_RETRY_TRIGGER_ID');
  var offsetRetryCount = PropertiesService.getScriptProperties().getProperty('REMINDER_OFFSET_ENGINE_RETRY_COUNT');
  if (offsetRetryTriggerId || offsetRetryCount) {
    Logger.log('ℹ️ Offset Engine 当前有锁竞争重试记录在案（trigger id=' + offsetRetryTriggerId +
      '，已重试次数=' + (offsetRetryCount || '0') + '）');
  }

  if (id) {
    try {
      var ss = SpreadsheetApp.openById(id);
      ['ReminderRules', 'ReminderOccurrences', 'ReminderHistory'].forEach(function (sheetName) {
        var sheet = ss.getSheetByName(sheetName);
        Logger.log((sheet ? '✅' : '❌') + ' ' + sheetName +
          (sheet ? '（当前行数含表头: ' + sheet.getLastRow() + '）' : '——请先跑一次 setupOffsetReminderSheets()'));
      });
    } catch (e) {
      Logger.log('❌ 检查 Offset Engine 的表时出错: ' + e.message);
    }
  }

  Logger.log('========== 诊断结束 ==========');
}
