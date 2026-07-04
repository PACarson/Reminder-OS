/**
 * 02_EventBus.gs
 * Reminder OS v1.0 — 事件总线（本项目负责的那部分 Events 表写入口）
 *
 * ⚠️ 2026-07-03 拆分说明：这是 Personal AI Core 02_EventBus.gs 的本地副本，
 * 精简版——Reminder OS 只会 publish('REMINDER_SENT', ...)，而且
 * Tasks.reminder_count 的实际更新走的是 92_ReminderEngine.gs 里的直接
 * upsertRowByKey_（safety-net-as-primary，见那个文件的说明），不依赖这里
 * 的 publish() 内部触发 ProjectionEngine.dispatch()。所以本项目不需要
 * 自己的 10_ProjectionEngine.gs——下面 publish() 里那个
 * "typeof ProjectionEngine !== 'undefined'" 检查会直接判否，安全跳过，
 * 不会报错。发布到 Events 表纯粹是为了保留一条完整、按时间顺序的审计记录
 * （跟 Core / Productivity OS 写的其他类型事件混在同一张共享表里）。
 *
 * _sheet_() 用 SpreadsheetApp.openById() 而不是 getActiveSpreadsheet()——
 * Reminder OS 是独立（standalone）脚本，没有"容器"，必须显式指定
 * Spreadsheet ID（Script Properties 里的 SPREADSHEET_ID，要跟 Core /
 * Productivity OS 项目设成同一个值）。
 */

var EventBus = (function () {
  var SHEET_NAME = 'Events';
  var COLS = ['event_id', 'timestamp', 'type', 'chat_id', 'payload', 'source'];

  var _cachedEvents = null;
  var _inExecIdentityCache_ = {};

  function _spreadsheet_() {
    var id = SecureConfig.getKey('SPREADSHEET_ID');
    if (!id) {
      throw new Error('缺少 SPREADSHEET_ID（Script Properties）。去 Personal AI Core 那张 ' +
        'Spreadsheet 的 URL 复制 ID，然后 SecureConfig.setKey("SPREADSHEET_ID", "你复制的ID")。');
    }
    return SpreadsheetApp.openById(id);
  }

  function _sheet_() {
    var ss = _spreadsheet_();
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      throw new Error('Events sheet 不存在——去 Personal AI Core 项目跑 setupSheets() 建表，' +
        '或确认 SPREADSHEET_ID 指对了表。');
    }
    return sheet;
  }

  function _generateEventId_() {
    return 'EVT-' + new Date().getTime() + '-' + Math.floor(Math.random() * 1000);
  }

  function publish(type, payload, chatId, source, identity) {
    if (identity) {
      if (_inExecIdentityCache_[identity]) {
        Logger.log('[EventBus] 执行内去重命中，跳过: type=' + type + ' identity=' + identity.slice(0, 12) + '...');
        return null;
      }
      _inExecIdentityCache_[identity] = true;
    }

    var event = {
      event_id: _generateEventId_(),
      timestamp: new Date().toISOString(),
      type: type,
      chat_id: chatId || '',
      payload: payload || {},
      source: source || ''
    };

    _sheet_().appendRow([
      event.event_id,
      event.timestamp,
      event.type,
      event.chat_id,
      JSON.stringify(event.payload),
      event.source
    ]);

    _cachedEvents = null;

    // 本项目没有自己的 ProjectionEngine，这个检查会判否，安全跳过
    if (typeof ProjectionEngine !== 'undefined' && typeof ProjectionEngine.dispatch === 'function') {
      try {
        ProjectionEngine.dispatch(event);
      } catch (projErr) {
        Logger.log('[EventBus] Projection 失败（非致命）: ' + projErr.message);
      }
    }

    return event;
  }

  function getAllEvents() {
    if (_cachedEvents !== null) return _cachedEvents;

    var sheet = _sheet_();
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      _cachedEvents = [];
      return _cachedEvents;
    }

    var rows = sheet.getRange(2, 1, lastRow - 1, COLS.length).getValues();
    _cachedEvents = rows.map(function (r) {
      var payload = {};
      try {
        payload = r[4] ? JSON.parse(r[4]) : {};
      } catch (e) {
        payload = {};
      }
      return {
        event_id:  r[0],
        timestamp: r[1],
        type:      r[2],
        chat_id:   r[3],
        payload:   payload,
        source:    r[5]
      };
    });
    return _cachedEvents;
  }

  function getEventsByType(type) {
    return getAllEvents().filter(function (e) {
      return e.type === type;
    });
  }

  return {
    publish:         publish,
    getAllEvents:    getAllEvents,
    getEventsByType: getEventsByType
  };
})();
