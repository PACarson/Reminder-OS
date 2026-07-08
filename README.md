/**
 * README.gs
 * Personal AI Core — Connector Layer V1（08_Connector/）说明文档
 *
 * 本文件不含可执行代码，只是这个模块的说明书。放成 .gs 而不是 .md，
 * 是延续 00_Project_Constitution.gs / 00_File_Map.gs / 00_Project_State.gs
 * 的既有做法——纯文档也用注释块的形式放进 Apps Script 项目里，贴进编辑器
 * 后不会因为文件类型报错，也方便和其他治理文件一起被搜索到。
 *
 * ⚠️ 目录结构说明（GAS 没有真正的文件夹）：
 * 跟 Reminder OS 项目交付时的说明一致——"08_Connector/" 只是这次交付/看
 * repo 时用来组织文件的路径标签，不是 Apps Script 项目里真实存在的文件夹。
 * 把下面 6 个文件贴进 Apps Script 编辑器时：
 *   - 如果你的编辑器版本支持文件名里带"/"（较新版本的 Apps Script 编辑器
 *     支持用"/"在左侧文件列表里显示出树状分组），可以保留
 *     "08_Connector/ProductivityConnector.gs" 这样的完整名字；
 *   - 如果不支持，直接去掉前缀，用 "ProductivityConnector.gs" 等平铺文件名
 *     贴进去即可——所有跨文件引用都是通过 GAS 扁平全局命名空间解析的，
 *     不认目录，两种贴法功能上完全等价。
 *
 * ============================================================
 * 一、这一层解决什么问题
 * ============================================================
 *
 * 需求方给的架构图：
 *   User → Conversation → Planner → Decision → Workflow → Connector Layer → Domain OS
 *
 * 也就是说：Connector Layer 是 Personal AI Core 跟"每一个 Domain OS"之间
 * 唯一被允许穿越的公开边界——Core 的其他任何代码（现在的、未来的）都不
 * 应该直接摸 Domain OS 的内部 Engine。
 *
 * ⚠️ 重要的范围说明：Planner/Decision/Workflow 这几层目前在 Core 里还
 * 不存在（现有的 04_Main.gs 是"解析意图后直接调 ProductivityOS.xxx()"，
 * 中间没有这几层）。本次交付只落地"Connector Layer"这一层本身，作为
 * 面向未来的新增基础设施——不修改、不重构 04_Main.gs / 80_RiderConnector.gs /
 * 21_InventoryModule.gs 这些现有直接调用 ProductivityOS Library 的代码。
 * 这些既有调用点继续正常工作，未采用新 Connector 层之前行为完全不变。
 * 要不要、什么时候把它们迁移过来改走 ConnectorRegistry，是后续单独的
 * 决定（已记录进 00_Project_State.gs 下一步），不在本次范围内、也没有
 * 在本次改动——这是刻意的最小化改动范围，参照
 * 00_Project_Constitution.gs P6.2 "现有系统不需要为了新标准立即重构，
 * 走适配器模式逐步迁移"的既有原则。
 *
 * ============================================================
 * 二、六个文件各自的职责
 * ============================================================
 *
 * ConnectorResponse.gs   —— 统一响应 DTO 工厂（success/failure），零依赖
 * ConnectorTypes.gs      —— 错误分类、ConnectorError 信号异常、输入校验
 *                           小工具、ConnectorSupport.handle（每个 Connector
 *                           方法体的标准执行骨架：计时+try/catch+分类+
 *                           日志+组装响应）
 * ConnectorRegistry.gs   —— 注册表：register/get/has/list/invoke/
 *                           healthCheckAll/capabilitiesAll，懒加载
 * ProductivityConnector.gs —— Productivity OS 的唯一 Connector（Library
 *                           调用，全功能）
 * ReminderConnector.gs   —— Reminder OS 的唯一 Connector（无 Library/无
 *                           webhook，只读共享 Sheet，诚实标注能力缺口）
 * README.gs              —— 本文件
 *
 * 依赖方向（箭头表示"依赖于"，只能单向，不能出现环）：
 *
 *   ProductivityConnector.gs ─┐
 *   ReminderConnector.gs    ──┼──→ ConnectorTypes.gs ──→ ConnectorResponse.gs
 *   ConnectorRegistry.gs    ──┘         │
 *                                       └─（懒引用，仅在 handle() 被调用
 *                                          的那一刻才需要 ConnectorResponse
 *                                          已存在，不依赖文件加载顺序，
 *                                          详见 ConnectorTypes.gs 文件头）
 *
 *   ConnectorRegistry.gs 额外懒引用 ProductivityConnector / ReminderConnector
 *   （同样是"调用时才需要存在"，不是"加载时"，见该文件 registerCoreConnectors_）
 *
 * ============================================================
 * 三、Standard Connector Interface（统一接口）
 * ============================================================
 *
 * 每个 Connector 必须实现这九个方法，签名统一为 (..., context) ——
 * context 永远是最后一个参数，形状是 { chatId?: string }：
 *
 *   create(payload, context)
 *   update(id, changes, context)
 *   delete(id, context)
 *   get(id, context)
 *   list(filters, context)
 *   search(query, context)
 *   execute(action, params, context)
 *   health(context)
 *   capabilities()
 *
 * 六个通用方法（create/update/delete/get/list/search）对应需求方规格里
 * "看起来像 CRUD"的动作（CreateTask/GetTask/ListTasks 等）；不像 CRUD 的
 * 具名动作（CompleteTask/TodayTasks/Statistics/UpcomingReminders 等）
 * 全部走 execute(action, params, context) 统一分发，具体支持哪些 action
 * 查每个 Connector 自己的 capabilities()，不需要看代码去猜。
 *
 * 写操作（create/update/delete/execute 的 mutating action）要求
 * context.chatId 必须是非空字符串；读操作（get/list/search/execute 的
 * 只读 action/health/capabilities）里 chatId 是可选的——不传代表"跨所有
 * 用户"，这跟 Core/Productivity OS 现有 QueryEngine 系列函数的既有约定
 * 一致，没有引入新规则。
 *
 * ============================================================
 * 四、响应 DTO 形状（所有九个方法，无论成功失败，返回值都是这个形状）
 * ============================================================
 *
 *   {
 *     success:   boolean,
 *     data:      any | null,
 *     error:     { category, code, message, details } | null,
 *     message:   string,
 *     metadata:  { connector, method, action, chatId, ...（execute 类
 *                  方法可能附加 count/horizonDays 等） },
 *     timestamp: string (ISO 8601),
 *     duration:  number (毫秒),
 *     traceId:   string
 *   }
 *
 * 错误分类（error.category）固定四选一：
 *   VALIDATION_ERROR —— 输入形状不对，Domain OS 根本没被调用
 *   BUSINESS_ERROR   —— 输入没问题，但 Domain OS（或已知的能力边界）
 *                       判定这个请求做不到，比如任务不存在、Reminder OS
 *                       没有对应的写能力
 *   SYSTEM_ERROR     —— 基础设施问题：Library 没挂、共享 Sheet 读不到等
 *   UNKNOWN_ERROR    —— 兜底，捕获到的异常不属于以上任何一类
 *
 * ============================================================
 * 五、⚠️ 两个 Domain OS 的真实能力边界（务必读完，不是次要信息）
 * ============================================================
 *
 * 这是本次实现里最重要的发现，也是"照单全收字面需求"跟"照真实系统
 * 正确实现"之间会分岔的地方：
 *
 * 5.1 Productivity OS —— 两个操作是"语义映射"，不是原样透传：
 *   - DeleteTask → 内部调用 cancelTask()（状态改 CANCELLED）。
 *     Productivity OS 是事件溯源架构（真相=不可变、只追加的 Events 表），
 *     设计上没有硬删除操作，只有 create/update/complete/cancel 四种。
 *   - ReopenTask → 不支持。updateTask() 的 UPDATABLE_FIELDS 白名单里
 *     没有 status，也没有 TASK_REOPENED 事件类型——这不是漏做，是当前
 *     Productivity OS 版本确实没有这个能力。
 *
 * 5.2 Reminder OS —— 六个写操作在当前版本下【没有可路由的后端】：
 *   CreateReminder / UpdateReminder / DeleteReminder / DismissReminder /
 *   SnoozeReminder / TriggerReminder。
 *
 *   根本原因：Reminder OS v1.0 是完全独立运作的项目——自己的每小时触发器，
 *   不接受任何项目把它当 Library 调用，也不接受 webhook（见 Reminder OS
 *   00_Project_Constitution.gs P2）。它没有"提醒"这个独立实体，"提醒"
 *   就是每小时扫一遍 Productivity OS 的 Tasks 表、用 due_date+priority
 *   算出该不该发，算完直接发 Telegram。没有请求队列、没有规则表、没有
 *   任何外部可以调用的入口。
 *
 *   额外发现：CompleteReminder 的正确落地方式其实已经存在，只是不在
 *   Reminder OS 里——完成提醒背后的任务这件事，04_Main.gs 现有的
 *   task_done: Telegram callback 早就在做（调 ProductivityOS.completeTask）。
 *   本 Connector 不重复实现这条路径。
 *
 *   另一个发现：SnoozeReminder 的 Telegram 按钮（"⏰ Snooze 1h"）背后
 *   目前【没有任何真实状态变更】——04_Main.gs 现有的 task_snooze:
 *   callback 只回复一句确认文案，不改任何存储。这是现有系统本来就有的
 *   行为（本次没有引入新问题），只是通过写这个 Connector 的过程中被
 *   明确追溯确认了，一并记录进 00_Project_State.gs。
 *
 *   这六个操作在 capabilities() 里都能查到 supported:false + 具体原因，
 *   调用了也会诚实返回 BUSINESS_ERROR，不会假装成功、不会静默不做事。
 *
 * 为什么不干脆在 Connector 里"补上"这些能力（比如自己在 Core 里存一张
 * 提醒规则表）？因为那等于在 Core 里发明第二套提醒业务逻辑，直接违反
 * 需求方"Connector 不能有业务逻辑/不能重复实现业务逻辑"的硬性要求，也
 * 违反 Reminder OS 自己 Constitution 里"提醒逻辑只允许存在一套实现"的
 * 规则。真要补这些能力，正确的地方是 Reminder OS 项目本身（其
 * 00_ADR_003 已经有一份未采纳的 V2 方案评估，覆盖了大部分这里缺失的
 * 能力），不是这个 Connector。
 *
 * ============================================================
 * 六、设计取舍（几处不是"唯一正确答案"、值得记录原因的决定）
 * ============================================================
 *
 * 1. 两个 Connector 用 IIFE 模块（var X = (function(){...return {...}})()）
 *    包裹，而不是照抄 80_RiderConnector.gs 的裸全局函数风格。原因：
 *    RiderConnector 是"Phase 1, Module 3"时期的产物，早于本项目后来
 *    在 Engine 文件上统一采用的 IIFE 惯例（TaskEngine/TaskQueryEngine/
 *    EventBus/QueryEngine 等全部是 IIFE）。本次要落地一个"统一接口"，
 *    IIFE 返回固定形状的公开方法集合是这个项目里更成熟、更普遍的既有
 *    写法，因此选择跟随 Engine 文件的惯例，而不是 RiderConnector 这个
 *    风格上的个例。
 *
 * 2. Connector Contract 文件头（Responsibilities/Owns/Calls Into/...）
 *    借用了 Productivity OS 00_Project_Constitution.gs"零之三 Engine
 *    Contract Standard"的字段格式。Personal AI Core 自己的 Constitution
 *    目前没有强制要求 Connector 文件写这个级别的结构化文件头，这里主动
 *    采用纯粹是因为格式本身好用——沿用比自创一套新格式更省心，也让
 *    以后可能想给 Core 自己的 Constitution 补一条"Connector Contract
 *    Standard"时有个现成模板可以抄。
 *
 * 3. ConnectorRegistry 的自注册（registerCoreConnectors_）用"懒加载时
 *    触发"而不是"文件顶层立即执行"，是为了不依赖 GAS 按文件名字母序
 *    拼接代码这件事——05_SheetUtils.gs 文件头记录过_cleanTitle_/
 *    shallowCopy_ 因为这个假设而真实踩过的坑，这里主动绕开同类风险，
 *    不是过度设计。
 *
 * 4. ReminderConnector 的 get/list/search/execute(Today/Upcoming/
 *    Statistics) 全部经由 Personal AI Core 本地既有的全局 QueryEngine/
 *    EventBus（12_QueryEngine.gs / 02_EventBus.gs），不是新写一套读
 *    共享 Sheet 的代码——这两个模块本来就是读同一张共享 Sheet，复用
 *    它们既是"不重复实现"，也保证这里看到的数据跟 Core 其他地方（比如
 *    80_RiderConnector.gs）看到的是同一份，不会出现两套并行的读取
 *    逻辑将来悄悄跑出不一致结果。
 *
 * ============================================================
 * 七、调用示例
 * ============================================================
 *
 *   // 建任务（Productivity OS）
 *   var res = ConnectorRegistry.get(ConnectorNames.PRODUCTIVITY)
 *     .create({ title: '交房租', due_date: '2026-07-25', priority: 'HIGH' },
 *             { chatId: '123456789' });
 *   if (res.success) { ... res.data.task_id ... }
 *
 *   // 等价的一步式写法（经 Registry.invoke，找不到 connector/方法都会
 *   // 标准化成同一种失败形状，不需要自己判空）
 *   var res2 = ConnectorRegistry.invoke(
 *     ConnectorNames.PRODUCTIVITY, 'create',
 *     { title: '交房租', due_date: '2026-07-25', priority: 'HIGH' },
 *     { chatId: '123456789' }
 *   );
 *
 *   // 今天该关注哪些提醒（Reminder OS，只读）
 *   var todayRes = ConnectorRegistry.get(ConnectorNames.REMINDER)
 *     .execute('TodayReminders', {}, { chatId: '123456789' });
 *
 *   // 查两个 Domain OS 各自真正支持什么，不需要翻代码
 *   var caps = ConnectorRegistry.capabilitiesAll();
 *   // → { Productivity: <ConnectorResponse>, Reminder: <ConnectorResponse> }
 *
 * ============================================================
 * 八、给未来新 Domain OS 的扩展指引（Future Expansion）
 * ============================================================
 *
 * 新增一个 Domain OS（比如 00_Project_State.gs 下一步第17条提到的
 * Property OS/Finance OS）时，理论上不需要改这四个共用文件
 * （ConnectorResponse/ConnectorTypes/ConnectorRegistry）里的任何一行：
 *
 *   1. 写一个新的 NN_XxxConnector.gs（照抄 ProductivityConnector.gs 或
 *      ReminderConnector.gs 的骨架，取决于新 Domain OS 是 Library 形态
 *      还是共享 Sheet 形态——两种真实前例都已经有了）
 *   2. 在 ConnectorNames 里加一个新名字（ConnectorTypes.gs 唯一需要碰的
 *      地方，且只是加一行，不改现有逻辑）
 *   3. 在 ConnectorRegistry.gs 的 registerCoreConnectors_() 里加三行
 *      同款注册代码——或者让新文件自己在某个会被调用到的函数里调
 *      ConnectorRegistry.register(...)（不要在文件顶层裸调，理由见
 *      本文件"设计取舍"第3点）
 *
 * 这就是需求方"No future architecture changes should be required when
 * adding a new connector"的具体落地方式。
 */
