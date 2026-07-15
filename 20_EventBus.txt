/**
 * 20_EventBus.gs   [原 02_EventBus.gs — 2026-07-06 按 Domain OS Blueprint
 * 迁入 2_Runtime/（Event 子分类）。详见 00_File_Map.txt。]
 *
 * 🐛 2026-07-06 外部审计修复（LOW RISK 2，核实属实后采纳，完整决策依据见
 * 00_ADR_002_ReminderEngine_Audit_Fixes.txt）：_sheet_() 现在把拿到的
 * Sheet 对象缓存在闭包里，同一次执行内重复调用不再重新 openById，见下方
 * _sheet_() 的注释。
 *
 * 🐛 2026-07-10 第四轮外部审计新增（HIGH RISK 1，核实属实后采纳，完整
 * 决策依据见 00_ADR_002_ReminderEngine_Audit_Fixes.txt「第四轮」）：
 * 新增 publishBatch()。25_ReminderEngine.gs 的 checkReminders 循环里，
 * 之前每成功发送一条提醒就立刻调一次 publish()——publish() 内部同步执行
 * appendRow()，是单行 I/O。Tasks 表的状态更新在第一轮就已经改成循环外
 * 批量写（见下方旧注释），但 Events 表这条线一直是逐行同步写，没有跟着
 * 一起改，这次审计指出的正是这个"改了一半"的遗漏。publishBatch() 把
 * appendRow 换成一次 getRange(...).setValues(...) 写连续多行，调用方
 * （25_ReminderEngine.gs）改成跟 Tasks 批量写用同一套分批节奏（累积到
 * BATCH_WRITE_CHUNK_SIZE 就一起 flush），不是本文件自己决定什么时候批量、
 * 什么时候不批量。原来的单条 publish() 不删、行为不变——本文件内部
 * 没有其他调用方，但作为一个通用工具方法，"发单条事件"仍然是合理的
 * 独立能力，不因为 ReminderEngine 这一个调用方改成批量就把单条能力也
 * 拿掉。
 *
 * Reminder OS v1.0 — 事件总线（本项目负责的那部分 Events 表写入口）
 *
 * ⚠️ 2026-07-03 拆分说明：这是 Personal AI Core 02_EventBus.gs 的本地副本，
 * 精简版——Reminder OS 只会 publish('REMINDER_SENT', ...)，不依赖这里的
 * publish() 内部触发 ProjectionEngine.dispatch()。所以本项目不需要
 * 自己的 10_ProjectionEngine.gs——下面 publish() 里那个
 * "typeof ProjectionEngine !== 'undefined'" 检查会直接判否，安全跳过，
 * 不会报错。发布到 Events 表纯粹是为了保留一条完整、按时间顺序的审计记录
 * （跟 Core / Productivity OS 写的其他类型事件混在同一张共享表里）。
 * Tasks.reminder_count 的实际更新走 2_Runtime/25_ReminderEngine.gs 里
 * checkReminders() 循环结束后的批量 batchUpsertRowsByKey_（2026-07-06
 * 起改成批量，之前是逐任务直接 upsertRowByKey_，见那个文件的 HIGH RISK 1
 * 修复说明），不再依赖这里 publish() 内部的 Projection 分发。
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
  var _cachedSheet = null; // 🐛 LOW RISK 2 fix: 惰性缓存 Sheet 句柄

  function _spreadsheet_() {
    var id = SecureConfig.getKey('SPREADSHEET_ID');
    if (!id) {
      throw new Error('缺少 SPREADSHEET_ID（Script Properties）。去 Personal AI Core 那张 ' +
        'Spreadsheet 的 URL 复制 ID，然后 SecureConfig.setKey("SPREADSHEET_ID", "你复制的ID")。');
    }
    return SpreadsheetApp.openById(id);
  }

  /**
   * 🐛 bugfix（2026-07-06，外部审计 LOW RISK 2，核实属实后采纳）：
   * 之前每次 publish()/getAllEvents() 都会重新 SecureConfig.getKey +
   * SpreadsheetApp.openById，哪怕同一次执行里已经打开过。现在把拿到的
   * Sheet 对象缓存在闭包里，同一次执行内第二次调用直接复用。
   * GAS 的 Sheet 对象本身是"引用"不是数据快照——缓存这个引用不会读到
   * 过期数据，appendRow/getRange 等操作永远打到实时的 Spreadsheet，只是
   * 省掉重复 openById 的开销。这个缓存只在本次执行的生命周期内有效
   * （GAS 每次新的触发/调用都是全新的顶层作用域），不存在跨执行的脏缓存
   * 问题，也不需要手动失效。
   */
  function _sheet_() {
    if (_cachedSheet) return _cachedSheet;
    var ss = _spreadsheet_();
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      throw new Error('Events sheet 不存在——去 Personal AI Core 项目跑 setupSheets() 建表，' +
        '或确认 SPREADSHEET_ID 指对了表。');
    }
    _cachedSheet = sheet;
    return _cachedSheet;
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

  /**
   * 🐛 2026-07-10 第四轮外部审计新增（HIGH RISK 1，核实属实后采纳，完整
   * 决策依据见 00_ADR_002_ReminderEngine_Audit_Fixes.txt「第四轮」，也见
   * 本文件头的说明）。
   *
   * 批量发布：一次 setValues() 写入多行连续的 Events 记录，取代"每条
   * 事件各自 appendRow() 一次"。
   *
   * @param {object[]} eventDrafts  每个元素 { type, payload, chatId, source, identity? }
   *                                identity 沿用单条 publish() 的执行内去重语义
   * @returns {object[]}  实际写入（未被去重跳过）的 event 对象数组
   */
  function publishBatch(eventDrafts) {
    if (!eventDrafts || eventDrafts.length === 0) return [];

    var published = [];

    eventDrafts.forEach(function (draft) {
      if (draft.identity) {
        if (_inExecIdentityCache_[draft.identity]) {
          Logger.log('[EventBus] 执行内去重命中，跳过: type=' + draft.type +
            ' identity=' + draft.identity.slice(0, 12) + '...');
          return;
        }
        _inExecIdentityCache_[draft.identity] = true;
      }

      published.push({
        event_id: _generateEventId_(),
        timestamp: new Date().toISOString(),
        type: draft.type,
        chat_id: draft.chatId || '',
        payload: draft.payload || {},
        source: draft.source || ''
      });
    });

    // 🐛 bugfix（外部审计 HIGH RISK 2，2026-07-15，核实属实后采纳）：原来
    // 用 getLastRow()+1 算起始行、一次 setValues() 写连续多行——"先读行数、
    // 再写入"这两步不是原子操作。Reminder OS / Personal AI Core /
    // Productivity OS 三个独立 Apps Script 项目共享同一张 Events 表，
    // 任何一个项目在这两步之间插进自己的写入，都会让本次算出的起始行
    // 过期，导致后写入的这一批把那次并发写入的内容覆盖掉——数据丢失，
    // 不只是排序问题。
    // 改成逐行调用 appendRow()：GAS 官方文档明确 appendRow 是原子操作
    // （"prevents issues where a user asks for the last row, and then
    // writes to that row, and an intervening mutation occurs between the
    // last row and the write operation"）——服务端在处理这次调用的当下
    // 才决定"当前实际的最后一行是哪一行"，不依赖调用方之前缓存的行号，
    // 天然避免了上面这种竞态。本文件的单条 publish() 一直用的就是
    // appendRow，也一直没被历次审计点名过这个问题，是同一个平台保证在
    // 起作用。代价：从"1次 setValues() 写N行"退化成"最多N次 appendRow()
    // 各写1行"——两个调用方（25_ReminderEngine.gs /
    // 26_ReminderOffsetEngine.gs）的批量节奏都是 BATCH_WRITE_CHUNK_SIZE
    // =5，单次 flush 最多5次同步调用，拿这点可接受的性能回退换掉数据
    // 丢失风险，划算。
    // ⚠️ 范围边界：这只保证 Reminder OS 自己这一侧的写入不再因为"读跟写
    // 不是原子的一步"而丢数据；如果 Personal AI Core / Productivity OS
    // 各自的 EventBus 副本内部也用类似 getLastRow()+setValues() 的写法，
    // 那两个项目自己的这条线仍然需要各自去修，不是本项目这一次改动能
    // 覆盖到的范围（本项目看不到那两个项目的代码，也没有办法替它们改）。
    if (published.length > 0) {
      var sheet = _sheet_();
      published.forEach(function (event) {
        sheet.appendRow([
          event.event_id,
          event.timestamp,
          event.type,
          event.chat_id,
          JSON.stringify(event.payload),
          event.source
        ]);
      });
      _cachedEvents = null;
    }

    // 跟单条 publish() 保持一致：本项目没有自己的 ProjectionEngine，这个
    // 检查会判否，安全跳过；写在这里是为了跟单条 publish() 行为对齐，
    // 万一以后接了 ProjectionEngine，批量发布不会漏掉分发。
    published.forEach(function (event) {
      if (typeof ProjectionEngine !== 'undefined' && typeof ProjectionEngine.dispatch === 'function') {
        try {
          ProjectionEngine.dispatch(event);
        } catch (projErr) {
          Logger.log('[EventBus] Projection 失败（非致命）: ' + projErr.message);
        }
      }
    });

    return published;
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
    publishBatch:    publishBatch,
    getAllEvents:    getAllEvents,
    getEventsByType: getEventsByType
  };
})();
