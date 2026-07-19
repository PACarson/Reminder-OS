/**
 * 00_ADR_004_Temporal_Engine_Design.gs
 * Reminder OS — 架构决策记录 #004
 *
 * STATUS: Accepted — Gate Review（A0→A1）已过，A1 实现 + Disposition
 * Review 的全部4项 Finding（1/2/3/4）已完成，无遗留 Fix Later 项
 * DATE: 2026-07-06（初版），2026-07-06（同日修订：并入 Gate Review 确认
 * 的5点 + 4条精化，见「2026-07-06 修订记录」），2026-07-13（Disposition
 * Review 后的 Contract 补充，见文末「2026-07-13 修订记录」），2026-07-15
 * （Finding 3 从 Fix Later 提升为 Fix Now 并完成，见文末「2026-07-15
 * 修订记录」）
 */

/**
 * === 背景 ===
 *
 * 00_ADR_003_Reminder_OS_V2_Vision_Evaluation.gs 的 Architecture Roadmap
 * 把 Phase A（Temporal Engine）再拆成 A0（这份文档：Contract/数据模型/
 * 边界设计）和 A1（实现）。这份文档锁 Contract；A1 的实现见
 * 1_Foundation/12_TemporalEngine.gs。
 *
 * 定位重申：Temporal Engine 不知道"提醒"是什么，不知道 task、chat_id、
 * Telegram。它只回答一个问题——"给定一条重复规则，下一次/未来若干次
 * 触发时间是什么"。Reminder OS（未来的 Reminder Scheduler，Phase B）是
 * 它的第一个消费者，不是唯一注定的消费者——Finance（账单周期）、Property
 * （租金周期）、Vehicle（保养周期）以后应该直接复用这同一份 Contract，
 * 不需要各自演化出不同的时间规则模型。
 *
 * === 模块结构（吸取 ADR-002 MEDIUM RISK 2 的教训）===
 *
 * 从一开始就用 IIFE 包装，不平铺全局——ADR-002 里 25_ReminderEngine.gs
 * 因为一开始平铺全局、后来才补 IIFE，多花了一次返工。Temporal Engine
 * 直接照 22_QueryEngine.gs/40_Output.gs 的写法来：
 *
 *   var TemporalEngine = (function () {
 *     function parseRule(ruleSpec) { ... }
 *     function calculateNextOccurrence(schedule, fromTime) { ... }
 *     function calculateOccurrences(schedule, fromTime, untilTime) { ... }
 *     function isDue(schedule, checkTime) { ... }
 *     return {
 *       parseRule: parseRule,
 *       calculateNextOccurrence: calculateNextOccurrence,
 *       calculateOccurrences: calculateOccurrences,
 *       isDue: isDue
 *     };
 *   })();
 *
 * 放在 1_Foundation/12_TemporalEngine.gs（10=SecureConfig，11=Setup，
 * 12=这个——不知道"提醒"、不含业务逻辑、纯计算能力，跟 Foundation 的
 * 定位一致）。
 *
 * === Dependency Rule（2026-07-06 补充，Gate Review 第5点关联）===
 *
 * Temporal Engine MUST NOT reference any Reminder-OS-specific concept
 * (task, chat_id, checkReminders, REMINDER_INTERVAL_HOURS, Output,
 * EventBus, QueryEngine, 等). Reminder OS depends on Temporal Engine.
 * Never the opposite.
 *
 * ⚠️ GAS 补充说明：这条规则在 GAS 里不是靠 import/require 强制的（GAS
 * 没有这个机制，扁平全局命名空间），只能靠写代码时的自律 + code review
 * 检查——12_TemporalEngine.gs 里不应该出现任何 Reminder/Task/Telegram
 * 相关的标识符，这是人工检查的重点，不是工具能自动挡住的。
 *
 * 【2026-07-06 A1 实现时补充的更强版本】不只是不碰 Reminder 概念——
 * 12_TemporalEngine.gs 不调用这个项目里任何【其他文件】的函数（包括
 * 21_SheetUtils.gs 的 parseDueDate_ 这类看起来"通用"的工具函数），
 * 只用 JS/GAS 内建的 Date/Array/Math 等。日期字符串解析这类小工具，
 * Temporal Engine 自己重新写一份，不复用 SheetUtils 的。这不是不知道
 * SheetUtils 已经有类似逻辑，而是 Temporal Engine 的定位是"以后能单独
 * 复制这一个文件到 Finance OS/Vehicle OS 等全新项目里就能跑"——一旦它
 * 依赖了本项目的其他文件，复制过去的时候就得把依赖链一起搬过去，"单文件
 * 可移植"这个定位就名不副实了。跟 21_SheetUtils.gs 里 parseDueDate_ 的
 * 日期解析逻辑刻意保留两份、不合并，是有意的重复，不是疏忽（跟这个项目
 * 一贯的"避免重复实现"C5 原则look起来矛盾，实际不矛盾——C5 说的是同一个
 * 项目内部不要有两份，Temporal Engine 定位是未来要独立搬到其他项目的
 * 平台级能力，等真的搬出去自成一个项目之后，这份"重复"就会消失，现在
 * 留在 Reminder OS 项目里的这份重复是过渡期的合理代价）。
 *
 * 调用关系（确定后不会是反过来）：
 *
 *   ReminderScheduler（Phase B，未来）
 *           │
 *           ▼
 *   TemporalEngine（Phase A，这份 ADR）
 *           │
 *           ├── parseRule()
 *           ├── calculateNextOccurrence()
 *           ├── calculateOccurrences()
 *           └── isDue()
 *
 * === RuleSpec（调用方提供的输入格式）===
 *
 * JSON 对象（跟 EventBus 的 payload 一样，存进 Sheet 时是 JSON.stringify
 * 之后的字符串，读出来 JSON.parse 还原——沿用这个项目已有的约定，不另外
 * 发明一套格式）：
 *
 *   {
 *     type: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'every_n_days',
 *     interval: number,       // 只有 type='every_n_days' 时必填且必须
 *                             // >=1（每N天的N）。其余四种 type 在 V1
 *                             // 固定当作 interval=1，就算 RuleSpec 传了
 *                             // 别的值也会被 parseRule 拒绝——"每2周"/
 *                             // "每3个月"这类不在 V1 支持范围，见下面
 *                             // 「V1 明确不支持」。
 *     start_date: string,     // 【2026-07-06 A1 实现时补上，见文末修订
 *                             // 记录】只有 type='every_n_days' 时必填，
 *                             // 'YYYY-MM-DD'，格式跟这个项目其他地方的
 *                             // due_date 字段一致。"每N天"必须有个锚点
 *                             // 才有意义——不然同一条规则在不同时间点
 *                             // 查询，"第几天算一次"这件事没有固定
 *                             // 参照，结果会不一致。
 *     time: string,           // 'HH:mm' 24小时制，比如 '09:00'。V1 每条
 *                             // 规则只有一个触发时刻，"一天两次"不支持，
 *                             // 见下面「V1 明确不支持」。
 *     days_of_week: number[], // 只有 type='weekly' 时必填。0=周日～
 *                             // 6=周六，跟 JS 原生 Date.getDay() 的编号
 *                             // 一致——这个项目所有日期计算都是原生 Date
 *                             // 对象，跟它的编号对不上会自找麻烦。
 *     day_of_month: number,   // 只有 type='monthly' 时必填，1-31。
 *     month: number,          // 只有 type='yearly' 时必填，1-12。
 *     day: number             // 只有 type='yearly' 时必填，1-31。
 *   }
 *
 * === Schedule Model（parseRule 的输出，其余三个函数的输入）===
 *
 * 之所以跟 RuleSpec 分开命名、不是同一个东西：RuleSpec 是"外部输入格式"，
 * 以后如果有别的输入方式（比如自然语言经过 intent parser 转成规则、或者
 * 类 cron 字符串），都只需要新增一个"转成 Schedule Model"的函数，
 * calculateNextOccurrence/calculateOccurrences/isDue 三个函数永远只认
 * 这一种内部形状，不用跟着输入格式的变化改。
 *
 * ⚠️ 2026-07-06 补充（Gate Review 关联）：Schedule Model is immutable.
 * Consumers MUST NOT mutate Schedule objects after parseRule() returns
 * them. Every TemporalEngine function that would logically "transform"
 * a schedule instead returns a new value, never mutates its input.
 * 原因：以后 Scheduler/Finance/Vehicle 可能都拿着同一个 Schedule 对象
 * 用，任何一处 schedule.hour = 10 这样的原地修改，都会让其他持有同一个
 * 引用的调用方莫名其妙跟着变。12_TemporalEngine.gs 的实现里，parseRule
 * 返回的对象不提供、也不依赖任何会修改自身字段的方法。
 *
 * V1 阶段，Schedule Model 跟 RuleSpec 长得几乎一样（parseRule 主要做
 * 校验 + 把 'time' 拆成 hour/minute 两个整数），这是正常的——两者分开
 * 是为了未来的扩展点，不是因为 V1 就需要它们长得不一样：
 *
 *   {
 *     type: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'every_n_days',
 *     interval: number,        // 已校验：every_n_days 时 >=1 的整数，
 *                              // 其余四种固定是 1
 *     hour: number,            // 0-23，从 RuleSpec.time 拆出来
 *     minute: number,          // 0-59，从 RuleSpec.time 拆出来
 *     startYear: number,       // 只有 every_n_days 才有，从
 *     startMonth: number,      // RuleSpec.start_date 拆出来（startMonth
 *     startDay: number,        // 是 0-11，跟 JS Date 的月份编号一致）
 *     daysOfWeek: number[],    // 只有 weekly 才有，已排序、已去重、
 *                              // 已校验每个值在 0-6 之间
 *     dayOfMonth: number,      // 只有 monthly 才有，已校验 1-31
 *     month: number,           // 只有 yearly 才有，已校验 1-12
 *     day: number              // 只有 yearly 才有，已校验 1-31
 *   }
 *
 * === 四个函数的精确签名 ===
 *
 * parseRule(ruleSpec: object): ScheduleModel
 *   - 校验 ruleSpec 是否合法（type 是否是五种之一、必填字段是否都在、
 *     数值是否在合法范围、interval 是否符合上面「只有 every_n_days
 *     才能 >1」的限制）。
 *   - 【错误处理】校验不通过时 throw 一个描述清楚哪里错了的 Error——
 *     不返回 null、不返回 {ok:false}。这跟 21_SheetUtils.gs 的
 *     getSheet_()（sheet 找不到时 throw，不是返回 null）是同一个约定：
 *     "调用方传的东西本身就不对"用 throw，"外部系统调用可能失败但输入
 *     合法"（比如 Output.sendMessage 调 Telegram API）才用
 *     {ok:false,...} 这种返回值。RuleSpec 校验属于前者。
 *   - 【yearly 校验补充，Disposition Review Finding 2，2026-07-13】除了
 *     month(1-12)、day(1-31) 各自的范围校验之外，还要校验 day 是否可能
 *     出现在 month 里（按闰年评估，即 day=29,month=2 合法）。calendrically
 *     不可能的组合（如 2/30、4/31——在任何年份都不存在，跟"闰年才有"的
 *     2/29 是两回事）在这里 throw，不允许流入 calculateNextOccurrence
 *     才因为 YEARLY_SEARCH_LIMIT 耗尽而失败，报出跟真实原因无关的错误。
 *   - 成功时返回上面定义的 Schedule Model（不可变，见上）。
 *   - 【Pure Function，2026-07-06 补充，Gate Review 关联】No IO. No
 *     Sheet access. No Logger.log. No PropertiesService/SecureConfig.
 *     No Date.now()/new Date()（当前时间）——只用传进来的参数计算。
 *     Deterministic：同样的输入永远得到同样的输出。这条约束不只是
 *     parseRule 一个函数的，是 12_TemporalEngine.gs 整个模块的硬性要求，
 *     四个函数全部适用。Foundation 层一旦开始掺 IO/日志/缓存，"纯计算、
 *     可无限复用"这个定位就名不副实了。
 *
 * calculateNextOccurrence(schedule: ScheduleModel, fromTime: Date): Date
 *   - 返回严格晚于 fromTime 的下一次触发时间点（不包含 fromTime 本身，
 *     即使 fromTime 恰好等于一个触发时间点，也返回再下一次的）。
 *   - 【错误处理，Gate Review 第2点确认】输入合法（schedule 是 parseRule
 *     返回的对象，fromTime 是合法 Date）时，这个函数保证不会 throw。
 *     校验职责全部在 parseRule 一次性做完，这里不重复校验、不会因为
 *     "看起来奇怪的数据"意外抛错。
 *   - 【schedule.type 不合法时的行为，Disposition Review Finding 1，
 *     2026-07-13】上面这条"输入合法时不 throw"的承诺，反过来说：如果
 *     schedule.type 不属于 parseRule 输出的五种合法类型之一（调用方绕过
 *     了 parseRule，或者传入的对象根本不是真正的 ScheduleModel），函数
 *     throw 一个具名错误，不静默返回 undefined。这不是对上面承诺的例外——
 *     按定义，合法的 ScheduleModel 的 type 只可能是这五种之一，所以这种
 *     情况从一开始就不算"输入合法"。
 *   - 【边界情况，已决定】type='monthly' 且 dayOfMonth=31，遇到没有31号
 *     的月份（4/6/9/11月）或者29/30号遇到没有那天的月份（比如2月，含
 *     闰年判断——闰年2月29号存在、平年不存在，这个函数要能正确处理）：
 *     V1 选择"跳过这个月，找下一个真的有这天的月份"，不是"退到当月最后
 *     一天"。理由：退到月底那种"clamp"处理，会让"每月31号"在2月变成
 *     "2月28/29号触发"，这是一种隐式改变了规则语义的行为，容易让人没
 *     发现规则被悄悄改了；跳过更符合字面意思，且用户如果真的想要"每月
 *     最后一天"这种语义，那是一个单独的规则类型（"最后一天"），V1 没做
 *     这个类型（见下面「V1 明确不支持」），不应该靠 dayOfMonth=31 加
 *     clamp 逻辑去模拟它。
 *
 * calculateOccurrences(schedule: ScheduleModel, fromTime: Date, untilTime: Date): Date[]
 *   - 返回 (fromTime, untilTime] 这个区间内全部触发时间点，按时间升序
 *     排列（不包含 fromTime，包含 untilTime 本身如果它恰好是一个触发
 *     点）。区间为空或 untilTime <= fromTime 时返回空数组，不 throw。
 *   - 这是 Phase B（Reminder Scheduler）处理"missed occurrence"最主要
 *     会用到的函数：调用方式是
 *     calculateOccurrences(schedule, 上次检查时间, 现在) ——如果返回
 *     数组非空，就说明这段间隙里有该触发但还没处理的时间点，不管这段
 *     间隙是正常的一小时（每小时触发器）还是异常的更长时间（触发器
 *     故障暂停了几小时）。
 *   - 【Performance Guard，2026-07-06 补充，Gate Review 第4点确认】
 *     硬上限：单次调用最多返回 1000 个 occurrence，超过时不 throw，
 *     直接截断在第1000个（并且只在 daily/every_n_days 这种触发频率高
 *     的规则、配合调用方传了过大的 [fromTime, untilTime] 区间时才可能
 *     真的撞到这个上限——weekly/monthly/yearly 正常时间跨度下几乎不会
 *     碰到）。这是防御性保护，不是业务需求：调用方如果需要超过1000个
 *     occurrence，应该分批多次调用，不应该依赖单次调用返回全部。
 *
 * isDue(schedule: ScheduleModel, checkTime: Date): boolean
 *   - 【语义特意收窄，避免被误用】只回答"checkTime 这一分钟是不是恰好
 *     等于一个触发时间点"，是一个精确匹配，不做任何"附近/差不多"的模糊
 *     判断。
 *   - 【错误处理】同 calculateNextOccurrence：输入合法时保证不 throw。
 *   - ⚠️ 这个函数对"每小时轮询一次"的实际使用场景（checkReminders 现在
 *     的运作方式）不是最合适的主力工具——GAS 时间触发器本身不保证精确
 *     到分钟触发，再加上如果一次触发器故障跳过了几小时，isDue 单点检查
 *     根本无法感知"过去这段时间是不是错过了"。Phase B 大概率应该主要靠
 *     calculateOccurrences(schedule, 上次检查时间, 现在) 来判断"这段
 *     期间要不要提醒"，isDue 只是给需要"这一刻是否恰好触发"这种精确
 *     判断的场景用（比如未来某个功能需要在触发的瞬间做什么，而不是靠
 *     轮询）。这一点特意写清楚，避免 Phase B 顺手就拿 isDue 当轮询判断
 *     用、复现现在 checkReminders 潜在的"轮询间隙里漏掉触发"问题。
 *
 * === Time Semantics（2026-07-06 补充，Gate Review 第1点确认）===
 *
 * All Temporal Engine calculations operate at minute precision.
 * 具体：
 *   - 所有计算统一用脚本时区（Session.getScriptTimeZone()对应的时区，
 *     实务上就是部署这个 Apps Script 项目时设定的时区）。V1 不支持
 *     跨时区场景（见下面「V1 明确不支持」），不接受调用方传入不同
 *     timezone 的场景。
 *   - 秒和毫秒一律忽略——所有比较、所有返回的 Date 对象，秒和毫秒
 *     字段固定为 0。这样"09:00:00.000"和"09:00:37.842"在这个引擎眼里
 *     是同一个触发点，不会因为 GAS 触发器实际唤醒的时间有几秒/几毫秒
 *     误差就判断"没对上"。
 *
 * === V1 支持的规则形状 ===
 *
 *   ✓ daily              — 每天同一个时刻触发一次
 *   ✓ weekly             — 每周指定的一或多个星期几，同一个时刻触发
 *   ✓ monthly            — 每月指定的某一天，同一个时刻触发
 *   ✓ yearly             — 每年指定的某月某日，同一个时刻触发（比如生日）
 *   ✓ every_n_days        — 每隔 N 天触发一次（N>=1）
 *
 * === V1 明确不支持（不是遗漏，是刻意排除，等真的需要再加）===
 *
 *   ✗ 每N周 / 每N个月 / 每N年（interval 只对 every_n_days 生效）
 *   ✗ 每月最后一天（这是独立的规则类型，不是 dayOfMonth 的特例）
 *   ✗ 一天多个触发时刻（比如"每天9点和18点"）
 *   ✗ Business hours only / Quiet hours（触发时间避开某个时间段）
 *   ✗ Timezone-aware（V1 假设全部计算都在脚本时区，没有跨时区场景，
 *     函数签名里也不带 timezone 参数——见下面「考虑过但没采纳」）
 *   ✗ "提前N天/N小时提醒" 这种基于另一个日期反推的规则（这类更接近
 *     25_ReminderEngine.gs 现有 REMINDER_ADVANCE_HOURS 那套"距 due_date
 *     多久"的逻辑，不是 Temporal Engine 该管的"重复规律"计算）
 *
 *   上面这些以后如果要加，预期都是在 RuleSpec/Schedule Model 里加新的
 *   可选字段或新的 type 值，不需要推翻 parseRule/calculateNextOccurrence/
 *   calculateOccurrences/isDue 这四个函数的签名——这正是先把 Contract
 *   定清楚的意义所在。
 *
 * === 考虑过但没采纳：给 calculateNextOccurrence 加 timezone 参数 ===
 *
 * 有一版建议是把签名改成 calculateNextOccurrence(schedule, fromTime,
 * timezone)，哪怕 V1 永远传 'Asia/Kuala_Lumpur'，先把参数位置占住，
 * 以后要支持多时区就不用改函数签名。
 *
 * 考虑之后没有采纳，理由：这个项目里目前【没有任何一处】真的处理过
 * 跨时区数据——05_SheetUtils.gs 一直到现在的 21_SheetUtils.gs，
 * parseDueDate_/isOverdue_ 全部隐式假设脚本时区，Reminder OS 现在
 * 服务的就是 Carson 一个人、一个时区。现在加一个永远只传同一个值的
 * 参数，不会让代码更正确，只会让调用方多记一件事、多一个"这个参数应该
 * 传什么"的疑问。等真的出现第二个时区（比如真的有 Domain OS 要服务
 * 不同时区的场景）时，加这个参数是一次性、明确原因的改动，比现在猜一个
 * 可能一直用不到的参数位置更干净。这跟"V1 明确不支持 Timezone-aware"
 * 是同一个判断，只是这里单独说明为什么连"占位参数"都没加。
 *
 * === 为什么没有另开一份 ADR-005（Foundation Module Rules）===
 *
 * 收到的建议是：另立一份 ADR，规定所有 Foundation 层模块（不只是
 * Temporal Engine）必须 Pure/Stateless/No IO/Reusable/No Business
 * Logic，禁止碰 Sheet/Telegram/Logger/Cache/Trigger/EventBus，理由是
 * "这样 QueryEngine/Parser/Normalizer/Validator 以后全部都遵守"。
 *
 * 没有采纳，两个理由：
 *   1. 事实错误：QueryEngine（22_QueryEngine.gs）不属于 Foundation，
 *      在这个项目的 blueprint 映射里它是 Runtime/Query（见
 *      00_File_Map.gs），而且它现在的实现本来就会读 Sheet（getSheet_/
 *      getHeaderMap_）——如果照字面把"禁止碰 Sheet"这条规则套到
 *      QueryEngine 头上，等于要求一个"读表查询引擎"不能读表，这是对
 *      现有架构的误读，不是可以直接采纳的规则。
 *   2. 时机不对：现在只有 Temporal Engine 一个 Foundation 层的新模块，
 *      "所有 Foundation 模块都要遵守的规则"这句话目前只有一个真实案例
 *      在支撑，本质上是在为还不存在的未来模块（Parser/Normalizer/
 *      Validator，都还没有任何具体需求驱动）预先定规则——这正是
 *      00_ADR_003 的 Progression Rule 想避免的事：不因为"以后可能需要"
 *      就现在做。Pure/Stateless/No IO/依赖方向这几条原则，这份 ADR-004
 *      已经作为 Temporal Engine 自己的 Contract 写清楚了；等真的出现
 *      第二个 Foundation 层模块、且这些规则被证明是这一层普遍适用的
 *      （而不只是 Temporal Engine 一个模块碰巧适用），再抽成独立的
 *      跨模块 ADR-005 更合适，到时候有两个真实案例可以对照，规则会定
 *      得更准，不是靠现在的猜测。
 *
 * === Test Matrix（2026-07-06 补充，Gate Review 第3点确认，实现见
 * 5_Testing/50_TemporalEngine_Tests.gs）===
 *
 *   □ daily：基本情况 + fromTime 恰好等于当天触发时刻（应返回明天同一
 *     时刻，不是今天）
 *   □ weekly：单一星期几 + 多个星期几 + fromTime 落在两个触发日中间
 *   □ monthly：基本情况 + day_of_month=31 遇到4/6/9/11月（应跳过）
 *   □ monthly：day_of_month=29 遇到平年2月（应跳过，不当作28号）
 *   □ yearly：基本情况（生日场景）+ 跨年边界（12月查询，下一次在明年）
 *   □ yearly：2月29日（闰年生日）遇到平年——按"跳过非闰年"处理，是
 *     yearly 版本的31号问题，处理方式跟 monthly 一致
 *   □ every_n_days：N=1（等同于daily的特例）、N>1 的基本情况；
 *     start_date 早于 fromTime（正常情况）和 start_date 晚于/等于
 *     fromTime（第一次触发就是 start_date 本身）；同一条规则从不同
 *     fromTime 查询，结果必须跟 start_date 锚点一致（不能因为查询时间
 *     点不同就"数错第几天"）
 *   □ 闰年：2024/2028这类闰年 vs 2026/2027这类平年，2月29日相关计算
 *     都要覆盖
 *   □ fromTime 正好命中一个触发点（calculateNextOccurrence 应跳过它，
 *     返回下一个；calculateOccurrences 的区间不应该包含 fromTime 本身）
 *   □ untilTime 正好等于一个触发点（calculateOccurrences 应该包含它）
 *   □ calculateOccurrences 空区间 / untilTime <= fromTime（应返回空
 *     数组，不 throw）
 *   □ parseRule 的非法输入（缺字段、type不认识、interval用在非
 *     every_n_days、超范围的数值）全部应该 throw，且不同错误有可辨识
 *     的 message
 *   □ 【两个消费者验证，见下方 Exit Criteria 调整】至少各写1-2个用例，
 *     分别从"Reminder"视角（比如"每天早上提醒吃药"）和"非Reminder"
 *     视角（比如"Finance：每月15号信用卡账单"、"Vehicle：每180天保养"）
 *     调用同一组函数，证明 Contract 没有偷偷带 Reminder 专属假设
 *
 * === Exit Criteria 调整（呼应 00_ADR_003 的 Phase A Exit Criteria）===
 *
 * 00_ADR_003 原本写"至少有一个真实调用方"，这次收紧为"至少两个不同
 * 视角的调用方"——不需要真的建 Finance OS，Test Matrix 里"非Reminder
 * 视角"那几个用例就足够充当这第二个消费者，用来证明 Temporal Engine
 * 没有 Reminder Bias。00_ADR_003 会同步这个调整。
 *
 * === 2026-07-06 修订记录 ===
 *
 * 初版之后同一天，根据 Gate Review 讨论，并入以下修订：
 *   1. 新增 Dependency Rule 一节（含调用关系图）
 *   2. Schedule Model 明确标注 Immutable
 *   3. 四个函数明确标注 Pure Function 约束（No IO/No Logger/No Clock/
 *      Deterministic），且明确 calculateNextOccurrence/
 *      calculateOccurrences/isDue 三个在输入合法时保证不 throw
 *   4. 新增 Time Semantics 一节（分钟精度、忽略秒毫秒、统一脚本时区）
 *   5. calculateOccurrences 新增 Performance Guard 具体数字（1000个
 *      occurrence 硬上限），不再是「留给A1决定」
 *   6. 新增「考虑过但没采纳：timezone 参数」一节，明确记录讨论过、
 *      为什么没加
 *   7. 新增「为什么没有另开 ADR-005」一节，说明采纳原则、不采纳新增
 *      独立文档的理由（含 QueryEngine 分类的事实核对）
 *   8. 新增 Test Matrix，明确列出 A1 实现时要覆盖的用例
 *   9. Exit Criteria 从"至少一个调用方"收紧为"至少两个不同视角的调用方"
 *   10. STATUS 从 Proposed 改为 Accepted，进入 A1 实现
 *   11. 物理位置从"待定"改为确定的 1_Foundation/12_TemporalEngine.gs
 *   12. 【A1 实现时发现并修的 Contract 漏洞】every_n_days 原本没有锚点
 *       日期——"每3天"从不同时间点查询，"第几天算一次"没有固定参照，
 *       结果会不一致。补上必填的 start_date（RuleSpec）/
 *       startYear+startMonth+startDay（Schedule Model）。这条不是
 *       Gate Review 5点确认里的任何一条，是写实现代码时才发现的，直接
 *       回来改这份 ADR，符合"实现中发现 Contract 问题就回来修"的既定
 *       流程，没有绕开 Contract 直接在代码里悄悄兼容。
 *   13. 明确 Temporal Engine 不调用本项目任何其他文件的函数（包括看起来
 *       通用的 parseDueDate_），保证单文件可移植，日期字符串解析逻辑
 *       自己重新写一份，不是疏忽性的重复
 *
 * === 后果 ===
 *
 * - A1（1_Foundation/12_TemporalEngine.gs 的实现 + 5_Testing/
 *   50_TemporalEngine_Tests.gs 的测试）在这份 ADR 的同一轮里一并完成，
 *   不再是"以后再做"的独立任务——Gate Review 5点确认 + 4条精化已经
 *   落到这份文档里，没有遗留的模糊地带需要在写代码时临时决定。
 * - 不会另外新增 00_ADR_005；如果以后真的出现第二个 Foundation 模块、
 *   且需要跨模块共用规则，那时候再评估要不要抽出来，理由见上面对应
 *   小节。
 * - 如果实现过程中发现这份 Contract 有问题，直接回来修订这份 ADR-004
 *   （更新 DATE +「修订记录」），这正是 Contract → Implementation →
 *   Feedback 这个流程该发挥作用的地方。
 *
 * === 2026-07-13 修订记录 ===
 *
 * UEF Architecture Review（Engine Profile，2026-07-12）产出 Gate:
 * Conditional Go，4个LOW finding。Disposition Review（2026-07-13，见独立
 * 文档《Reminder-OS_LOW-Findings-Disposition_2026-07-12.md》）逐条评估后：
 *   1. parseRule 新增 yearly day-in-month 校验（Finding 2，Fix Now，已
 *      实现）——见上面 parseRule 小节新增的对应条目
 *   2. calculateNextOccurrence 新增 schedule.type 不合法时的 throw 行为
 *      （Finding 1，Fix Now，已实现）——见上面对应小节新增的条目
 *   3. Finding 3（Object.freeze 未强制 immutability）：disposition 结论
 *      Fix Later，不在这次修订范围。理由跟「考虑过没采纳 timezone 参数」
 *      是同一个逻辑——目前零调用方，保护的场景还不存在；等 TemporalEngine
 *      有了第一个真实调用方再回来做。这份 Contract 不需要为此改动，因为
 *      Contract 本来就已经写明 Schedule Model immutable，Finding 3 缺的
 *      是 runtime 强制，不是 Contract 本身有漏洞，所以不算 Contract 修订。
 *   4. Finding 4（MAX_OCCURRENCES 缺自动化测试）：disposition 结论
 *      Fix Now，已实现，纯测试新增，不改 Contract 也不改实现。
 *
 * === 后果（2026-07-13 更新）===
 *
 * - Finding 1、2、4 已实现并验证：12_TemporalEngine.gs + 5_Testing/
 *   50_TemporalEngine_Tests.gs，测试从 39/39 增加到 43/43（Finding 1 一条
 *   回归测试 + Finding 2 两条回归测试 + Finding 4 一条 Performance Guard
 *   测试），全部通过——用独立的 Node harness 实际跑过一次，不是改完代码
 *   直接假设没问题。
 * - 就 Gate Review 明确写的 Condition（"fix Findings 1 and 2 before
 *   anything begins depending on the current permissive behavior"）而言，
 *   这次修订已经满足；Finding 3 维持 Fix Later，本来就不在 Condition
 *   范围内，不影响 Gate 从 Conditional Go 走向 Go。
 * - Phase A 的 Exit Criteria 本来就已在 2026-07-06 全部满足，这次修的是
 *   Gate Review 额外发现的边界情况，不重新打开 Exit Criteria 本身。
 * - Phase B（Reminder Scheduler，recurring reminder）依然按 Progression
 *   Rule 不自动开始，需要真实需求驱动，这次修订不改变这一点。
 *
 * === 2026-07-15 修订记录 ===
 *
 * 外部审计（第五轮，见 00_ADR_002_ReminderEngine_Audit_Fixes.gs「第五轮
 * 外部审计」章节 LOW RISK 1）独立重新点名 Finding 3（Object.freeze 未
 * 强制 immutability）——不是一个新发现，是 2026-07-13 修订记录里已经
 * Confirmed、但当时 disposition 为 Fix Later 的同一条。评估后确认
 * 2026-07-12 架构评审当时的结论依然成立（"return
 * Object.freeze(schedule); 一行、对现有测试零影响"），予以采纳，
 * disposition 从 Fix Later 提升为 Fix Now。
 *
 * 提升理由：当时 Fix Later 的核心依据是"目前零调用方，保护的场景还不
 * 存在"——这一点本身没有变化（TemporalEngine 到这次修订为止依然没有
 * 任何调用方，Phase B 仍未开始），不是"因为出现了真实调用方才被迫修"。
 * 单纯是因为这次有了第二个独立信号（外部审计重新点名同一个问题）、且
 * 修复本身成本极低（一行、零测试影响，2026-07-13 评估时已经确认过），
 * 所以按这次审计的要求一并处理，不再等待真实调用方出现——这跟 Fix
 * Later 当初"不为还不存在的场景抢跑"的判断不矛盾，只是优先级判断在
 * 新增信息（第二次独立点名）下的重新校准。
 *
 * 修复：parseRule 返回前 Object.freeze(schedule)，本身不涉及 Contract
 * 变更（跟 2026-07-13 记录的判断一致：Contract 本来就已经写明 Schedule
 * Model immutable，缺的一直是 runtime 强制，不是 Contract 本身有漏洞）。
 * 5_Testing/50_TemporalEngine_Tests.gs 新增2个断言：直接验证
 * Object.isFrozen(schedule) 为 true；以及对已冻结对象的字段赋值会静默
 * 失败、不生效（sloppy mode 下不抛错，这一点在两处运行环境——GAS 默认
 * 运行时、这份文件被 eval 进 Node 沙盒时——都成立）。测试从 43/43 增加到
 * 45/45，全部通过。
 *
 * === 后果（2026-07-15 更新）===
 *
 * - Finding 3 现在也已实现并验证，4个 LOW finding（Finding 1/2/3/4）
 *   全部处理完毕，没有遗留的 Fix Later 项。
 * - 这不改变 Gate 已经是 Go（不再是 Conditional Go）的结论——Finding 3
 *   本来就不在 Gate Review 的 Condition 范围内，这次只是把一条本来就
 *   打算"以后有需要再做"的可选加固提前做掉，不是补一个之前被忽略的
 *   必要条件。
 * - Phase A/Phase B 的状态不变，完整历史见上面「2026-07-13 修订记录」
 *   和「后果」。
 */
