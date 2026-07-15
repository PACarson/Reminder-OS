/**
 * 21_SheetUtils.gs   [原 05_SheetUtils.gs — 2026-07-06 按 Domain OS
 * Blueprint 迁入 2_Runtime/。这个文件横跨多个子分类，没有拆分，见
 * 00_ADR_001_Domain_OS_Blueprint_Adoption.txt 的说明：
 *
 * 🐛 2026-07-10 第四轮外部审计修复（MEDIUM RISK 1，核实属实后采纳，完整
 * 决策依据见 00_ADR_002_ReminderEngine_Audit_Fixes.txt「第四轮」）：
 * 新增 batchUpdateFieldsByKey_()。25_ReminderEngine.gs 的 _persistBatch
 * 之前复用 batchUpsertRowsByKey_ 做分批持久化——但那个函数是为"批量
 * 建/改任意字段、找不到就 append"场景设计的通用 upsert，每次调用都会
 * 整表读（getRange(2,1,lastRow-1,numCols)）+ 整表写（setValues 覆盖全部
 * 现有行），成本随表的总行数增长，而不是随本批实际改动的行数增长。
 * Reminder OS 每次持久化只需要更新【已确定存在】的任务的 reminder_count/
 * last_reminder_at 两个字段，不需要 upsert 的"找不到就插入"语义，也不
 * 需要整表覆写——这是一个更窄、更适合"稀疏字段更新"的操作形状，所以新增
 * 一个独立函数而不是改造 batchUpsertRowsByKey_ 本身（改造会让那个函数
 * 同时承担两种不同的成本模型，其他调用方——如果未来出现整表重建场景——
 * 会意外变慢）。
 *
 * batchUpdateFieldsByKey_ 只读 key 列定位行号（不读其余列），只对
 * 实际要改的字段做单元格级 setValue()（不做整行/整表 setValues()）——
 * 读的宽度从 numCols 列降到 1 列，写的范围从"整张表"降到"本批实际改动
 * 的单元格"，两者都不再随表的总行数/总列数线性增长。
 *
 * ⚠️ 刻意不做的优化：没有把"读 key 列定位行号"这一步也跨多次调用缓存
 * 起来（比如整个 checkReminders 执行期间只读一次）。原因：Reminder OS
 * 和 Productivity OS 是两个独立的 GAS 项目，各自的 LockService 互不
 * 感知对方——本项目的锁只保证"同一时间只有一个 checkReminders 在跑"，
 * 不能阻止 Productivity OS（或用户直接在 Sheet UI 里操作）在
 * checkReminders 执行期间（分批持久化跨越好几分钟）并发修改 Tasks 表。
 * 如果缓存一份行号映射跨多次调用重用，理论上没问题（行号本身不受这
 * 次改动影响——只要没有物理插入/删除行）；但如果改成像
 * batchUpsertRowsByKey_ 那样缓存整份"现有行数据"再整表覆写，一旦
 * Productivity OS 在这期间改了某个不相关字段（比如用户改了任务标题），
 * 本项目基于缓存旧数据的整表覆写会把那次改动悄悄覆盖掉——用"偶发重复
 * 提醒"的性能问题去换"偶发数据丢失"的正确性问题，不是划算的交易。新
 * 函数每次调用都重新读 key 列（成本已经压得很低），只对自己要改的具体
 * 单元格做定点写入，不接触任何其他字段，天然规避了这个风险，不需要
 * 额外加缓存失效逻辑。
 *   - Runtime/Projection（主）：upsertRowByKey_ / deleteRowByKey_ /
 *     batchUpsertRowsByKey_ —— 维护 Tasks 等派生视图表
 *   - Runtime/Decision 支撑：isOverdue_ / parseDueDate_ —— 供
 *     25_ReminderEngine.gs 的 _shouldRemind/_isOverdue/_hoursUntilDue 用
 *   - Foundation 级跨领域工具：round1_ / round2_ / shallowCopy_ /
 *     _cleanTitle_ —— 跟提醒/Sheet 都无关的通用小工具，历史上就是为了
 *     避免重复实现（犯C5）才统一搬到这里，这次不再拆出去，保留这个
 *     "反重复"的决定。]
 *
 * 🐛 2026-07-06 第二轮外部审计修复（LOW RISK 1，核实属实后采纳，完整
 * 决策依据见 00_ADR_002_ReminderEngine_Audit_Fixes.gs 文末补充记录）：
 * 全部函数包进 IIFE（SheetUtils 模块），不再平铺全局——跟
 * 22_QueryEngine.gs/40_Output.gs/2_Runtime/25_ReminderEngine.gs 的写法
 * 一致，是这几个"引擎风格"文件里最后一个还没 IIFE 化的。
 *
 * ⚠️ 调用方同步更新：22_QueryEngine.gs 的 getSheet_/getHeaderMap_、
 * 25_ReminderEngine.gs 的 isOverdue_/parseDueDate_/batchUpsertRowsByKey_，
 * 全部从裸调用改成 SheetUtils.xxx 的命名空间形式。11_Setup.gs 不直接调
 * 这个文件的函数（它直接用 SpreadsheetApp.openById，不经过 SheetUtils），
 * 不受影响。函数内部互相调用（比如 upsertRowByKey_ 调 getSheet_）不需要
 * 加前缀，因为都在同一个 IIFE 闭包里。
 *
 * ⚠️ 这次审计还提到 MEDIUM RISK 2（getSheet_ 硬编码单一 SPREADSHEET_ID，
 * 未来多个 Domain OS 全部挤在同一张物理表，有 Google Sheets 单表容量
 * 上限和数据隔离的顾虑）——核实这条技术上是对的，但没有在这里改，理由：
 * "一张共享 Spreadsheet、每个 Domain OS 各自一个分页"是 00_Project_
 * Constitution.gs P1/P2 明确写下的既有架构决定（2026-07-03 拆分时就
 * 定的，不是这次疏漏），改成"每个 Domain OS 各自的 Spreadsheet、动态
 * 解析 ID"是一次影响全平台的架构级变动，会牵动 Personal AI Core、
 * Productivity OS 等这次看不到代码的其他项目，不是能在 Reminder OS
 * 这一个项目里单方面决定+改掉的事。真的接近 Google Sheets 容量上限、
 * 需要物理拆表时，应该是一次跨项目评估之后的决定，见
 * 00_Project_State.txt「已知问题」。
 *
 * JARVIS CORE v3.1 — 共用 Sheet 工具 + 共用小工具
 *
 * 用途：Tasks / Inventory 这类「派生视图」表，字段经常会改/加列，
 * 所以一律按表头名字找列，不写死列号。
 *
 * ⚠️ 这些函数只用来维护「派生视图」表（Tasks, Inventory），
 * 不允许用来写 EVENTS 表 —— EVENTS 表只能通过 EventBus.publish() 写。
 *
 * 本次修改（2026-06-27，外部审计MEDIUM RISK 7 / LOW RISK 9，核实属实后采纳）：
 * 新增 isOverdue_/parseDueDate_/round1_/round2_ 四个共用函数。这些原本
 * 各自散落在 92_ReminderEngine.gs（isOverdue_/parseDueDate_）和
 * 93_MemoryEngine.gs（round1_/round2_，且93自己另外重复实现了一份过期判断
 * 逻辑），21_InventoryModule.gs 和 94/95_*Engine.gs 又跨文件隐式调用它们——
 * 这种"调用方靠猜全局作用域里有这个函数"的写法，一旦被调用的那个文件
 * 重构（比如加IIFE），调用方会直接 ReferenceError 崩溃，犯C5。统一搬到
 * 这里，所有调用方改成调这份。
 *
 * 本次修改（2026-06-29，外部审计HIGH RISK 2 / MEDIUM RISK 1，核实属实后采纳）：
 * 1. 新增 batchUpsertRowsByKey_()：11_ProjectionRebuilder.gs 的全量重建
 *    之前是循环里逐个调 upsertRowByKey_（每个 task/item 一次读+一次写），
 *    历史 Events 数到几百上千条时极易触发 GAS 6 分钟执行超时。这个新函数
 *    一次性读全表 → 内存里合并 → 最多两次 setValues() 写回（一次覆写已有行、
 *    一次追加新行），I/O 次数跟数据量无关。upsertRowByKey_ 本身不删，
 *    正常单行更新场景（如 completeTask 的安全兜底）继续用它，没有批量
 *    需求时没必要换。
 * 2. 新增共用 shallowCopy_(obj) / _cleanTitle_(text)：之前
 *    20_ProductivityModule.gs 全局定义了 shallowCopy_，21_InventoryModule.gs
 *    又用不同名字（shallowCopyInv_）重复实现了一份完全一样的逻辑；
 *    06_TaskIntentParser.gs 和 22_InventoryIntentParser.gs 各自全局定义了
 *    一份完全相同的 _cleanTitle_ —— 后加载的文件会静默覆盖先加载的同名声明
 *    （GAS 全局命名空间扁平化），现在两边代码相同所以没事，但只要未来
 *    任意一处改了逻辑，另一处就会出现隐蔽的业务异常（犯C5）。统一搬到
 *    这里，06/20/21/22 的同名声明全部删除，调用方不用改任何调用代码
 *    （函数名没变，只是声明的物理位置变了，GAS 全局作用域下完全透明）。
 *
 * 本次修改（2026-06-29，ActiveTasks/ArchiveTasks 落地新增）：
 * 新增 deleteRowByKey_()：ActiveTasks 是"只放未完成任务"的工作台表，
 * 任务一旦 DONE/CANCELLED 就要把整行从这张表物理删除（不是覆写状态）。
 * upsertRowByKey_ 只会"找到就覆写/找不到就append"，没有删除语义，
 * 所以单独加一个按主键删行的函数，跟 upsertRowByKey_ 配对使用。
 */

var SheetUtils = (function () {

  function getSheet_(sheetName) {
    // 2026-07-03 拆分说明：Reminder OS 是独立（standalone）脚本，没有
    // "容器"，不能用 getActiveSpreadsheet()。改用 openById 显式打开跟
    // Personal AI Core / Productivity OS 共享的同一张 Spreadsheet
    // （Script Properties 里的 SPREADSHEET_ID 要设成跟另外两个项目一样的值）。
    var id = SecureConfig.getKey('SPREADSHEET_ID');
    if (!id) {
      throw new Error('缺少 SPREADSHEET_ID（Script Properties）。去 Personal AI Core 那张 ' +
        'Spreadsheet 的 URL 复制 ID，然后 SecureConfig.setKey("SPREADSHEET_ID", "你复制的ID")。');
    }
    var sheet = SpreadsheetApp.openById(id).getSheetByName(sheetName);
    if (!sheet) {
      throw new Error('Sheet not found: ' + sheetName + ' — 请确认分页名是否一致');
    }
    return sheet;
  }

  /**
   * 读取表头行，返回 { headerName: 0基索引 }
   */
  function getHeaderMap_(sheet) {
    var lastCol = sheet.getLastColumn();
    if (lastCol === 0) {
      return {}; // bugfix：完全空白的表(没有任何内容)，getRange(1,1,1,0)会直接抛错，这里提前返回空表头
    }
    var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    var map = {};
    headerRow.forEach(function (name, idx) {
      if (name) map[String(name).trim()] = idx;
    });
    return map;
  }

  /**
   * 按 keyHeader 列的值查找/更新一行；找不到就新增一行（append）。
   * rowDataObj 里只需要给出要写的字段，没给的字段（已存在的行）保持原值不变。
   *
   * 适用场景：单行更新（如 completeTask/cancelTask 的安全兜底、ProjectionEngine
   * 的逐事件 O(1) dispatch）。批量重建场景（N 个对象一次性写回）请用下面的
   * batchUpsertRowsByKey_，否则会循环里逐行 I/O，大表会超时（见 HIGH RISK 2）。
   *
   * @param {string} sheetName
   * @param {string} keyHeader     用来定位行的列名，比如 'task_id'
   * @param {string} keyValue      要找的值
   * @param {object} rowDataObj    { 列名: 值, ... }
   */
  function upsertRowByKey_(sheetName, keyHeader, keyValue, rowDataObj) {
    var sheet = getSheet_(sheetName);
    var headerMap = getHeaderMap_(sheet);
    var numCols = sheet.getLastColumn();

    if (!(keyHeader in headerMap)) {
      throw new Error('找不到列: ' + keyHeader + '，请确认 ' + sheetName + ' 表头里有这一列');
    }

    var keyColIndex = headerMap[keyHeader];
    var lastRow = sheet.getLastRow();
    var foundRow = -1;

    if (lastRow >= 2) {
      var keyValues = sheet.getRange(2, keyColIndex + 1, lastRow - 1, 1).getValues();
      for (var i = 0; i < keyValues.length; i++) {
        if (String(keyValues[i][0]) === String(keyValue)) {
          foundRow = i + 2; // +2: 跳过表头 + 0基转1基
          break;
        }
      }
    }

    var rowArray;
    if (foundRow > 0) {
      rowArray = sheet.getRange(foundRow, 1, 1, numCols).getValues()[0];
    } else {
      rowArray = new Array(numCols).fill('');
    }

    for (var key in rowDataObj) {
      if (headerMap.hasOwnProperty(key)) {
        var val = rowDataObj[key];
        rowArray[headerMap[key]] = (val === null || val === undefined) ? '' : val;
      }
    }

    if (foundRow > 0) {
      sheet.getRange(foundRow, 1, 1, numCols).setValues([rowArray]);
    } else {
      sheet.appendRow(rowArray);
    }
  }

  /**
   * 按 keyHeader 列的值删除一行；找不到则静默跳过（不报错，返回false）。
   *
   * 2026-06-29新增（ActiveTasks/ArchiveTasks 落地）：ActiveTasks 的定义是
   * "永远只放未完成任务"，任务一旦 DONE/CANCELLED 就必须把整行物理删掉，
   * 不是覆写状态——upsertRowByKey_ 没有删除语义，所以加这个配对函数。
   *
   * @param {string} sheetName
   * @param {string} keyHeader
   * @param {string} keyValue
   * @returns {boolean}  true=删掉了一行，false=没找到对应行
   */
  function deleteRowByKey_(sheetName, keyHeader, keyValue) {
    var sheet = getSheet_(sheetName);
    var headerMap = getHeaderMap_(sheet);
    if (!(keyHeader in headerMap)) {
      throw new Error('找不到列: ' + keyHeader + '，请确认 ' + sheetName + ' 表头里有这一列');
    }

    var keyColIndex = headerMap[keyHeader];
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return false;

    var keyValues = sheet.getRange(2, keyColIndex + 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < keyValues.length; i++) {
      if (String(keyValues[i][0]) === String(keyValue)) {
        sheet.deleteRow(i + 2); // +2: 跳过表头 + 0基转1基
        return true;
      }
    }
    return false;
  }

  /**
   * 🐛 2026-07-15 外部审计新增（MEDIUM RISK 1 关联，
   * 26_ReminderOffsetEngine.gs checkOffsetReminders 清理失效规则那段，
   * 核实属实后采纳）。
   *
   * 批量【按主键删除多行】：只读 keyHeader 这一列一次，定位给定的一批
   * key 各自对应哪一行，按行号【降序】依次 deleteRow()。降序是必须的，
   * 不是风格选择——deleteRow 物理删除一行后，原本在它下面的所有行行号
   * 都会整体减一，如果按升序删，后面待删的行号会全部失效，删错行。
   *
   * 跟循环调用 deleteRowByKey_ 的差异：deleteRowByKey_ 每次调用都各自
   * 完整地 getSheet_ + getHeaderMap_ + 读一次 key 列来定位，N 个 key 就要
   * 付 N 次"打开表 + 读整列"的开销；这个函数只付一次，行号全部定位完成
   * 后才开始真正的物理删除，不会随 key 数量增加而重复付出"打开表"这部分
   * 的成本。
   *
   * @param {string} sheetName
   * @param {string} keyHeader
   * @param {Array} keyValues
   * @returns {{deleted:number, notFound:string[]}}
   */
  function batchDeleteRowsByKey_(sheetName, keyHeader, keyValues) {
    if (!keyValues || keyValues.length === 0) return { deleted: 0, notFound: [] };

    var sheet = getSheet_(sheetName);
    var headerMap = getHeaderMap_(sheet);
    if (!(keyHeader in headerMap)) {
      throw new Error('找不到列: ' + keyHeader + '，请确认 ' + sheetName + ' 表头里有这一列');
    }

    var keyColIndex = headerMap[keyHeader];
    var lastRow = sheet.getLastRow();

    var wantedKeys = {};
    keyValues.forEach(function (k) {
      if (k !== undefined && k !== null && k !== '') wantedKeys[String(k)] = true;
    });

    var rowNumsToDelete = [];
    var foundKeys = {};
    if (lastRow >= 2) {
      var colValues = sheet.getRange(2, keyColIndex + 1, lastRow - 1, 1).getValues();
      for (var i = 0; i < colValues.length; i++) {
        var k = colValues[i][0];
        if (k === '' || k === null || k === undefined) continue;
        var kStr = String(k);
        if (wantedKeys[kStr]) {
          rowNumsToDelete.push(i + 2); // +2: 跳过表头 + 0基转1基
          foundKeys[kStr] = true;
        }
      }
    }

    rowNumsToDelete.sort(function (a, b) { return b - a; }); // 降序，避免前面删除导致后面行号错位
    rowNumsToDelete.forEach(function (rowNum) {
      sheet.deleteRow(rowNum);
    });

    var notFound = [];
    for (var keyStr in wantedKeys) {
      if (!foundKeys[keyStr]) notFound.push(keyStr);
    }

    return { deleted: rowNumsToDelete.length, notFound: notFound };
  }

  /**
   * 批量 upsert：一次性读全表 → 内存合并 → 最多两次 setValues() 写回。
   *
   * 🐛 bugfix（2026-06-29，外部审计HIGH RISK 2，核实属实后采纳）：
   * 11_ProjectionRebuilder.gs 之前对 N 个 task/item 循环调 upsertRowByKey_，
   * 每个对象触发一次"读整表找行号"+一次"写一行"——O(N) 次 Sheet I/O。
   * 这里改成：先一次性读出全表现有行（1次I/O），在内存数组里原地合并需要
   * 更新的字段、把全新的对象单独收集起来，最后已存在的行整块覆写一次
   * （1次I/O），全新的行整块追加一次（1次I/O）。无论 N 多大，物理 Sheet
   * I/O 调用次数固定在 ≤3 次，不会再随 Events 历史增长而逼近 6 分钟执行超限。
   *
   * @param {string} sheetName
   * @param {string} keyHeader        用来定位行的列名，比如 'task_id'
   * @param {object[]} rowDataObjArray  每个元素是 { [keyHeader]: value, 其余要写的字段... }
   *                                    数组内 keyValue 不应重复（重建场景下每个
   *                                    task_id/item_id 在 stateMap 里本来就只有一份）
   * @returns {{updated:number, appended:number}}
   */
  function batchUpsertRowsByKey_(sheetName, keyHeader, rowDataObjArray) {
    if (!rowDataObjArray || rowDataObjArray.length === 0) {
      return { updated: 0, appended: 0 };
    }

    var sheet = getSheet_(sheetName);
    var headerMap = getHeaderMap_(sheet);
    var numCols = sheet.getLastColumn();

    if (!(keyHeader in headerMap)) {
      throw new Error('找不到列: ' + keyHeader + '，请确认 ' + sheetName + ' 表头里有这一列');
    }

    var keyColIndex = headerMap[keyHeader];
    var lastRow = sheet.getLastRow();

    // 一次性读出全部现有数据行（没有数据行时为空数组）
    var existingRows = (lastRow >= 2)
      ? sheet.getRange(2, 1, lastRow - 1, numCols).getValues()
      : [];

    // 建 keyValue → existingRows 下标 的映射，一次扫描，避免每个对象都重新线性查找
    var indexByKey = {};
    for (var i = 0; i < existingRows.length; i++) {
      var existingKey = existingRows[i][keyColIndex];
      if (existingKey !== '' && existingKey !== null && existingKey !== undefined) {
        indexByKey[String(existingKey)] = i;
      }
    }

    var appendedRows = [];
    var updated = 0;
    var appended = 0;

    rowDataObjArray.forEach(function (rowDataObj) {
      var keyValue = rowDataObj[keyHeader];
      if (keyValue === undefined || keyValue === null || keyValue === '') return; // 没有主键值，跳过

      var idx = indexByKey[String(keyValue)];
      if (idx !== undefined) {
        // 已存在 → 在内存里原地合并字段（不立即写 Sheet）
        for (var k1 in rowDataObj) {
          if (headerMap.hasOwnProperty(k1)) {
            var v1 = rowDataObj[k1];
            existingRows[idx][headerMap[k1]] = (v1 === null || v1 === undefined) ? '' : v1;
          }
        }
        updated++;
      } else {
        // 不存在 → 组一行新数组，先收集，最后一次性 append
        var newRow = new Array(numCols).fill('');
        for (var k2 in rowDataObj) {
          if (headerMap.hasOwnProperty(k2)) {
            var v2 = rowDataObj[k2];
            newRow[headerMap[k2]] = (v2 === null || v2 === undefined) ? '' : v2;
          }
        }
        appendedRows.push(newRow);
        // 防止同一批次里出现两个相同 keyValue 时都走 append（重建场景下 stateMap
        // 本身按 id 去重，这里只是防御性补一条索引，避免理论上的重复 append）
        indexByKey[String(keyValue)] = -1; // -1 表示"本批次已处理，不是合法行下标"
        appended++;
      }
    });

    if (existingRows.length > 0) {
      sheet.getRange(2, 1, existingRows.length, numCols).setValues(existingRows);
    }
    if (appendedRows.length > 0) {
      sheet.getRange(lastRow + 1, 1, appendedRows.length, numCols).setValues(appendedRows);
    }

    return { updated: updated, appended: appended };
  }

  /**
   * 🐛 2026-07-10 第四轮外部审计新增（MEDIUM RISK 1，核实属实后采纳，
   * 完整决策依据见 00_ADR_002_ReminderEngine_Audit_Fixes.txt「第四轮」，
   * 也见本文件头的说明）。
   *
   * 批量【稀疏字段更新】：只更新已知存在的行的指定字段，不做整表读/写，
   * 不支持"找不到就插入"（找不到直接跳过，记录进返回值的 notFound
   * 数组，交给调用方决定怎么处理——对 Reminder OS 来说，"任务已经从
   * QueryEngine.getPendingTasks() 读出来了，几分钟后持久化时却在 Tasks
   * 表里找不到对应行"本身就是一种值得留意的异常情况，不应该静默 append
   * 一行不完整的新数据）。
   *
   * 跟 batchUpsertRowsByKey_ 的关键差异：
   *   - 读：只读 keyHeader 这一列（1列 × N行），不读整表（numCols列 × N行）
   *   - 写：对每一行只 setValue() 实际改动的那几个字段对应的单元格，
   *     不做整行/整表 setValues()——不会读取也不会覆盖同一行里没有指定
   *     的其他字段
   *   - 语义：找不到 key 就跳过，不 append 新行
   *
   * @param {string} sheetName
   * @param {string} keyHeader          用来定位行的列名，比如 'task_id'
   * @param {object[]} rowDataObjArray  每个元素是 { [keyHeader]: value, 要改的字段: 新值, ... }
   *                                    只会写明确给出的字段，未列出的字段不受影响。
   * @returns {{updated:number, notFound:Array}}
   */
  function batchUpdateFieldsByKey_(sheetName, keyHeader, rowDataObjArray) {
    if (!rowDataObjArray || rowDataObjArray.length === 0) {
      return { updated: 0, notFound: [] };
    }

    var sheet = getSheet_(sheetName);
    var headerMap = getHeaderMap_(sheet);

    if (!(keyHeader in headerMap)) {
      throw new Error('找不到列: ' + keyHeader + '，请确认 ' + sheetName + ' 表头里有这一列');
    }

    var keyColIndex = headerMap[keyHeader];
    var lastRow = sheet.getLastRow();

    // 只读 key 这一列（不是整表），定位每个 keyValue 对应的实际行号（1基）
    var rowNumByKey = {};
    if (lastRow >= 2) {
      var keyValues = sheet.getRange(2, keyColIndex + 1, lastRow - 1, 1).getValues();
      for (var i = 0; i < keyValues.length; i++) {
        var k = keyValues[i][0];
        if (k !== '' && k !== null && k !== undefined) {
          rowNumByKey[String(k)] = i + 2; // +2：跳过表头 + 0基转1基
        }
      }
    }

    var updated = 0;
    var notFound = [];

    rowDataObjArray.forEach(function (rowDataObj) {
      var keyValue = rowDataObj[keyHeader];
      if (keyValue === undefined || keyValue === null || keyValue === '') return; // 没有主键值，跳过

      var rowNum = rowNumByKey[String(keyValue)];
      if (rowNum === undefined) {
        notFound.push(keyValue);
        return;
      }

      var touchedThisRow = false;
      for (var field in rowDataObj) {
        if (field === keyHeader) continue;
        if (!headerMap.hasOwnProperty(field)) continue;
        var val = rowDataObj[field];
        sheet.getRange(rowNum, headerMap[field] + 1)
          .setValue((val === null || val === undefined) ? '' : val);
        touchedThisRow = true;
      }
      if (touchedThisRow) updated++;
    });

    return { updated: updated, notFound: notFound };
  }

  /**
   * 🐛 2026-07-11 新增（解决第三轮外部审计遗留的 HIGH RISK 2 ——
   * QueryEngine._readAllRows_ 读整张 Tasks 表——现在拿到 Productivity OS
   * 代码后确认可以怎么修，完整决策依据见
   * 00_ADR_002_ReminderEngine_Audit_Fixes.txt「第三轮 HIGH RISK 2 后续
   * 解决」）。
   *
   * 批量【稀疏字段读取】：只读 keyHeader 这一列定位行号，再对给定的一批
   * key，只读 fields 里指定的那几个字段，不读整表其余列——跟
   * batchUpdateFieldsByKey_ 是同一个思路的读版本（那个是写）。
   *
   * 设计用途：22_QueryEngine.gs 现在从 ActiveTasks（小表，只有当前未完成
   * 任务）取候选任务列表，但 reminder_count/last_reminder_at 这两个字段
   * 的权威数据仍然在 Tasks（原因见 22_QueryEngine.gs 文件头）——用这个
   * 函数只为候选列表里的少数几个 task_id 去 Tasks 表定点取这两个字段，
   * 不需要读 Tasks 表的其余16列，也不需要读 Tasks 表里跟候选列表无关的
   * 那些历史行的任何数据。
   *
   * @param {string} sheetName
   * @param {string} keyHeader   用来定位行的列名，比如 'task_id'
   * @param {Array} keys         要查的 key 值列表
   * @param {string[]} fields    每个命中的 key，要读取的字段名列表
   * @returns {object}  { [keyValue的字符串形式]: { field1: val1, field2: val2, ... } }
   *                     没找到的 key 不会出现在返回对象里（不是空对象，是完全不存在这个属性）。
   */
  function batchReadFieldsByKey_(sheetName, keyHeader, keys, fields) {
    if (!keys || keys.length === 0 || !fields || fields.length === 0) return {};

    var sheet = getSheet_(sheetName);
    var headerMap = getHeaderMap_(sheet);

    if (!(keyHeader in headerMap)) {
      throw new Error('找不到列: ' + keyHeader + '，请确认 ' + sheetName + ' 表头里有这一列');
    }

    var keyColIndex = headerMap[keyHeader];
    var lastRow = sheet.getLastRow();

    var wantedKeys = {};
    keys.forEach(function (k) {
      if (k !== undefined && k !== null && k !== '') wantedKeys[String(k)] = true;
    });

    // 只读 key 这一列（不是整表），只记录我们关心的那些 key 对应的行号——
    // 这一步的读取量仍然正比于 sheetName 的总行数（1列宽），但比
    // batchUpdateFieldsByKey_ 更进一步的优化（比如维护一份持久化索引）
    // 目前没有必要，见 22_QueryEngine.gs 文件头关于这一点的说明。
    var rowNumByKey = {};
    if (lastRow >= 2) {
      var keyValues = sheet.getRange(2, keyColIndex + 1, lastRow - 1, 1).getValues();
      for (var i = 0; i < keyValues.length; i++) {
        var k = keyValues[i][0];
        if (k === '' || k === null || k === undefined) continue;
        var kStr = String(k);
        if (wantedKeys[kStr]) rowNumByKey[kStr] = i + 2;
      }
    }

    var matchedKeyStrs = Object.keys(rowNumByKey);
    if (matchedKeyStrs.length === 0) return {};

    // 🐛 bugfix（外部审计 HIGH RISK 3，2026-07-15，核实属实后采纳）：原来
    // 这里对每个命中的 key、每个要读的字段都各自单独调一次
    // sheet.getRange(rowNum, col).getValue()——命中的 key 越多、要读的
    // 字段越多，同步网络调用次数就是两者的乘积，候选任务一多，执行时间
    // 会迅速逼近6分钟上限，也容易撞日配额。改成：先算出命中的所有行号、
    // 要读的所有列号各自的 [min,max] 包络，一次 getValues() 把这个矩形
    // 区域整体读进内存（代价是可能顺带读到一些命中key之间、字段之间用
    // 不上的行/列，但比起"每个单元格各一次调用"，用一次范围读换掉 O(N)
    // 次调用，多读一点暂时用不上的数据远比多一次网络往返划算），再在
    // 内存里按偏移量取值。I/O 调用次数从"命中数 × 字段数"降到最多2次
    // （定位行号1次 + 整块取值1次），不再随命中的 key 数量或字段数量
    // 线性增长。
    var fieldCols = {}; // field -> 0基列索引，只保留 headerMap 里真的存在的字段
    var minCol = null, maxCol = null;
    fields.forEach(function (f) {
      if (!headerMap.hasOwnProperty(f)) return;
      fieldCols[f] = headerMap[f];
      minCol = (minCol === null) ? headerMap[f] : Math.min(minCol, headerMap[f]);
      maxCol = (maxCol === null) ? headerMap[f] : Math.max(maxCol, headerMap[f]);
    });

    var result = {};
    if (minCol === null) {
      // fields 里没有任何一个字段在表头里存在——没有可读的列，直接给每个
      // 命中的 key 一个空对象，维持跟原逻辑（headerMap.hasOwnProperty(f)
      // 为 false 时跳过该字段）一致的外部表现，不额外发起任何范围读取。
      matchedKeyStrs.forEach(function (kStr) { result[kStr] = {}; });
      return result;
    }

    var minRow = null, maxRow = null;
    matchedKeyStrs.forEach(function (kStr) {
      var rowNum = rowNumByKey[kStr];
      minRow = (minRow === null) ? rowNum : Math.min(minRow, rowNum);
      maxRow = (maxRow === null) ? rowNum : Math.max(maxRow, rowNum);
    });

    var block = sheet.getRange(minRow, minCol + 1, maxRow - minRow + 1, maxCol - minCol + 1).getValues();

    matchedKeyStrs.forEach(function (kStr) {
      var rowOffset = rowNumByKey[kStr] - minRow;
      var obj = {};
      fields.forEach(function (f) {
        if (!fieldCols.hasOwnProperty(f)) return;
        obj[f] = block[rowOffset][fieldCols[f] - minCol];
      });
      result[kStr] = obj;
    });
    return result;
  }

  // ============ 共用：过期判断 ============
  // 原本在92_ReminderEngine.gs里，21_InventoryModule.gs跨文件直接调用它的
  // 私有函数（_parseDueDate_），93_MemoryEngine.gs又自己重复实现了一份一样
  // 的逻辑——现在统一成这一份，92/21/93都改成调这里的。

  /**
   * 判断 due_date 是否已经过期。只处理日期类，里程类('40000km'这种)先跳过
   * （依赖 RiderConnector 的当前里程数据，暂时无法判断）。
   * @param {string} dueDateRaw  原始 due_date 字符串
   */
  function isOverdue_(dueDateRaw) {
    if (!dueDateRaw) return false;
    var raw = String(dueDateRaw).trim();

    if (/km$/i.test(raw)) {
      return false;
    }

    var due = parseDueDate_(raw);
    if (!due || isNaN(due.getTime())) return false;
    return due.getTime() < Date.now();
  }

  /**
   * 🐛 bugfix（原在92_ReminderEngine.gs）：纯日期字符串（'2026-06-22'，
   * 没有时间部分）用 new Date() 解析时，JS 会按 UTC 处理，不是本地时区！
   * 对 UTC+8 来说，这会让"到期"判断整体偏移8小时。这里改成纯日期字符串
   * 手动按本地时区午夜算，带时间的字符串则正常解析（ES2015+规范：带T
   * 无offset的日期时间字符串按本地时区解析，只有纯日期才按UTC，2026-06-25
   * 外部审计MEDIUM RISK 2复核确认过，详见25_ReminderEngine.gs历史记录）。
   */
  /**
   * 🐛 bugfix（2026-07-15，GAS Console 实测 TypeError: raw.match is not a
   * function，报错点在 26_ReminderOffsetEngine.gs 的 _resolveEffectiveDueDatetime_）：
   * raw 不一定是字符串——Sheets 对日期/日期时间格式的单元格，getValues()
   * 会直接返回原生 Date 对象。isOverdue_（本文件下方）一直是安全的，
   * 因为它在调用这里之前先 String(dueDateRaw) 过；但
   * 26_ReminderOffsetEngine.gs 的 _resolveEffectiveDueDatetime_ 是直接把
   * task.due_datetime/task.due_date 传进来，不经过这层转换——原来的
   * raw.match(...) 假设 raw 一定是字符串，遇到 Date 对象直接抛错。
   * 这里改成先识别 Date 类型直接返回（拷贝一份，不回传调用方传入的原始
   * 引用），非 Date 的输入才按原逻辑走字符串解析——两个调用方都不用改，
   * 按"任意 Sheet 单元格原始值"的实际形状把这个共用函数加固，不只是
   * 针对这一个调用方打补丁。
   */
  function parseDueDate_(raw) {
    if (raw instanceof Date) {
      return new Date(raw.getTime());
    }
    var str = String(raw === null || raw === undefined ? '' : raw).trim();
    var dateOnlyMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnlyMatch) {
      return new Date(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]) - 1, Number(dateOnlyMatch[3]));
    }
    return new Date(str);
  }

  // ============ 共用：数值四舍五入 ============
  // 原本散落在93_MemoryEngine.gs，94/95跨文件隐式调用——统一成这一份。

  function round1_(n) {
    return Math.round(n * 10) / 10;
  }

  function round2_(n) {
    return Math.round(n * 100) / 100;
  }

  // ============ 共用：浅拷贝 ============
  // 2026-06-29新增（外部审计MEDIUM RISK 1关联项）：原本20_ProductivityModule.gs
  // 全局声明了一份shallowCopy_，21_InventoryModule.gs又用shallowCopyInv_这个
  // 不同名字重复实现了一份完全相同的逻辑。10_ProjectionEngine.gs里也有一份，
  // 但那份是包在IIFE里的私有函数，不会跟全局声明冲突，不动。

  function shallowCopy_(obj) {
    var copy = {};
    for (var k in obj) copy[k] = obj[k];
    return copy;
  }

  // ============ 共用：标题/名称清洗 ============
  // 2026-06-29新增（外部审计MEDIUM RISK 1，核实属实后采纳）：原本
  // 06_TaskIntentParser.gs 和 22_InventoryIntentParser.gs 各自全局声明了
  // 一份完全相同的 _cleanTitle_。GAS按文件名字母序加载，后加载的文件（22）
  // 会静默覆盖先加载的文件（06）的同名声明——目前两份代码完全一致所以没有
  // 实际影响，但只要未来任意一处的清洗规则单独改了（比如06想支持更多标点），
  // 另一处会在不知不觉中被换成不一样的逻辑，犯C5（重复实现要合并）。
  //
  // 🐛 第三轮 bugfix（2026-07-06，外部审计LOW RISK 7，核实属实后采纳）：
  // 原来是 /^[...]+|[...]+$/g 一个正则里用 | 分支同时处理头尾。审计指出
  // 这类"锚定+交替"结构对异常长文本存在非必要回溯的理论风险——实际测过
  // 这个具体正则不会指数级失控（字符类量词没有嵌套歧义），标题类输入也
  // 不会长到有实际影响，但拆成两次独立 replace（一次处理开头，一次处理
  // 结尾）行为完全等价、写法更直白，还能顺手把这个理论疑虑清零，就直接
  // 改了，没有理由为了"理论上没问题"就不做这个几乎零成本的简化。
  function _cleanTitle_(text) {
    return String(text || '')
      .replace(/^[，,：:\s的、]+/, '')
      .replace(/[，,：:\s的、]+$/, '')
      .trim();
  }

  return {
    getSheet_: getSheet_,
    getHeaderMap_: getHeaderMap_,
    upsertRowByKey_: upsertRowByKey_,
    deleteRowByKey_: deleteRowByKey_,
    batchDeleteRowsByKey_: batchDeleteRowsByKey_,
    batchUpsertRowsByKey_: batchUpsertRowsByKey_,
    batchUpdateFieldsByKey_: batchUpdateFieldsByKey_,
    batchReadFieldsByKey_: batchReadFieldsByKey_,
    isOverdue_: isOverdue_,
    parseDueDate_: parseDueDate_,
    round1_: round1_,
    round2_: round2_,
    shallowCopy_: shallowCopy_,
    _cleanTitle_: _cleanTitle_
  };
})();
