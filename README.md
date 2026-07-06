# Reminder OS

2026-07-03 从 Personal AI Core 拆出来的独立项目。定位：**全平台共享的
时间与通知服务**——不是 Productivity OS 专属，未来 Property/Finance/
Vehicle OS 的到期提醒也会用这一套（见 Personal AI Core 项目
`00_Project_Constitution.gs` 的 D2/D5）。

2026-07-06 更新：修复了 HIGH RISK 2（提醒过早触发的 bug），并把全部文件
按平台统一的 **Domain OS Blueprint** 重新组织。见下方「目录结构」和
`0_Governance/00_ADR_001_Domain_OS_Blueprint_Adoption.gs`。

## 这个项目完全独立运作

不接 Telegram webhook，不被谁当 Library 调用——它靠自己的时间触发器
主动醒来、主动查、主动发消息。跟 Personal AI Core / Productivity OS
唯一的联系是"读写同一张共享 Google Sheet"。

## 目录结构（Domain OS Blueprint）

```
0_Governance/    Project Constitution / Project State / File Map / ADR
1_Foundation/    Configuration（SecureConfig, Setup）
2_Runtime/       Event / Projection / Query / Decision / Execution
                 （EventBus, SheetUtils, QueryEngine, ReminderEngine）
3_Intelligence/  暂无内容（见该目录 _RESERVED.txt）
4_Integration/   APIs / External Systems（Output → Telegram Bot API）
5_Testing/       暂无内容（见该目录 _RESERVED.txt）
```

⚠️ **这个资料夹结构只是这份 zip / repo 里的组织方式，方便对照 blueprint
看。Google Apps Script 是扁平命名空间，编辑器里不认目录**——第 1 步部署
的时候，把下面所有文件不分资料夹、全部贴成 Apps Script 项目里的独立文件
即可，文件名（含数字前缀）保留，目录路径不用管。

## 部署步骤（在 Productivity OS 之后、Core 之前或之后都可以）

### 1. 新建 Apps Script 项目，把下面全部文件粘贴进去（不分资料夹，一个文件对应一个 .gs）

### 2. 设置 Script Properties
- `SPREADSHEET_ID` —— 跟 Core / Productivity OS 项目【同一张】表的 ID
- `TELEGRAM_TOKEN` —— 跟 Core 项目一样的 Bot Token（这个项目自己直接发
  消息，不经过 Core，所以需要自己也配一份）
- `TELEGRAM_CHAT_ID` —— 跟 Core 项目一样

### 3. 跑一次 `createTriggers()`
挂上 `checkReminders`（每小时）。不需要建任何新 Sheet——Tasks 表已经在
共享 Spreadsheet 里了（Productivity OS 建的）。

### 4. 跑一次 `runDiagnostics()` 验证
应该能看到"能读到 Tasks 表"和一条测试 Telegram 消息。

⚠️ `createTriggers()`/`runDiagnostics()` 所在的 `1_Foundation/11_Setup.gs`
这次是重建版本，不是你原始代码，见下方文件清单里的标注和
`0_Governance/00_Project_State.gs`「已知问题」。

## 文件清单

| 文件（新） | 原文件 | blueprint 分类 | 说明 |
|---|---|---|---|
| `0_Governance/00_Project_Constitution.gs` | 同名 | Project Constitution | P1-P3 未变，P4 更新，新增 P5 |
| `0_Governance/00_Project_State.gs` | 同名 | Project State | HIGH RISK 2 移到已完成，新增已知问题 |
| `0_Governance/00_File_Map.gs` | 同名 | File Map | 全面重写 |
| `0_Governance/00_ADR_001_Domain_OS_Blueprint_Adoption.gs` | （新增） | ADR | 记录这次 blueprint 采用的理由和判断 |
| `1_Foundation/10_SecureConfig.gs` | `01_SecureConfig.gs` | Configuration | 逐字未改 |
| `1_Foundation/11_Setup.gs` | `15_Setup.gs` | Configuration | ⚠️ 重建版本，待你确认，见上 |
| `2_Runtime/20_EventBus.gs` | `02_EventBus.gs` | Event | 逐字未改 |
| `2_Runtime/21_SheetUtils.gs` | `05_SheetUtils.gs` | Projection + Decision支撑 + 通用工具 | 逐字未改 |
| `2_Runtime/22_QueryEngine.gs` | `12_QueryEngine.gs` | Query | 逐字未改 |
| `2_Runtime/25_ReminderEngine.gs` | `92_ReminderEngine.gs` | Decision + Execution | **修复 HIGH RISK 2**，见下 |
| `4_Integration/40_Output.gs` | `03_Output.gs` | APIs / External Systems | 逐字未改 |

`3_Intelligence/`、`5_Testing/` 暂无 `.gs` 文件，各自资料夹里的
`_RESERVED.txt` 说明原因，不用贴进 Apps Script。

## 25_ReminderEngine.gs（原92_ReminderEngine.gs）这次具体改了什么

**2026-07-06，修复 HIGH RISK 2**：`_shouldRemind` 之前完全没有校验当前
时间是否接近 `due_date`——任务一旦 PENDING，哪怕 due_date 在一个月后，
也会立刻按优先级对应间隔（比如 MEDIUM=12小时）开始高频提醒。现在新增
`REMINDER_ADVANCE_HOURS` 常量（默认 72 小时，可自行调整）和
`_hoursUntilDue` 辅助函数：未逾期且距 due_date 超过这个提前量时，直接
不提醒。里程类 due_date（`'40000km'`）无法计算距今多久，维持原行为不受
影响（等 RiderConnector 接好再处理）。`REMINDER_INTERVAL_HOURS` 数值
本身没变。

2026-07-03 拆分时的 2 处改动继续保留：

1. `checkReminders()` 里 `getPendingTasks()` → `QueryEngine.getPendingTasks()`
   （原来那个裸调用是 20_ProductivityModule.gs 的全局包装函数，现在没有
   那个文件了，直接调 QueryEngine）
2. `_updateReminderCount()` 里 `_materializeTaskRow_(task.task_id, task)` →
   `upsertRowByKey_('Tasks', 'task_id', task.task_id, task)`（原函数在
   20_ProductivityModule.gs，这里改成直接调等价的 SheetUtils 函数，效果
   完全一样）

## 关于 Reminder OS 未来接入其他 Domain OS

目前 `checkReminders()` 只查 Tasks 表。如果以后 Property OS 也想用这个
服务提醒房租到期，做法是：Property OS 往共享 Spreadsheet 写自己的
`Property` 表，这个项目加一段"也查 Property 表里快到期的"逻辑——不需要
Property OS 反过来调用这个项目，也不需要这个项目反过来调用 Property OS，
只需要都读写同一张共享表，按各自的 Sheet 名分开就行（blueprint 里这属于
Runtime/Query 的扩展，不需要新建 4_Integration 的 Bridge/Connector）。
