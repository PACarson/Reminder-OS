/**
 * 00_ADR_003_Reminder_OS_V2_Vision_Evaluation.gs
 * Reminder OS — 架构决策记录 #003
 *
 * STATUS: Proposed — 范围需要 Carson 拍板，见下方「建议」
 * DATE: 2026-07-06
 */

/**
 * === 背景 ===
 *
 * 收到一份"Reminder OS V2 (AI-Native Reminder Platform)"的完整 Prompt，
 * 核心诉求：把现在这个"只会查 Tasks 表 due_date、按优先级发提醒"的单一
 * ReminderEngine，升级成服务全部 Domain OS 的平台级提醒基础设施，包含：
 *   - 7个新 Runtime 引擎：Rule Engine（后来建议拆成 Temporal Engine +
 *     Reminder Engine）/ Scheduler / Dispatcher / History / Escalation /
 *     Snooze / Analytics
 *   - Foundation 新增 10 个 schema 概念（Reminder Rule/Schedule/Window/
 *     Escalation Policy/History/Analytics/Channel/State/Timezone/
 *     Preferences）
 *   - Intelligence 层预留 5 个未来 AI 模块
 *   - Integration 层支持 8 个 Domain OS（Productivity/Finance/Inventory/
 *     Property/Vehicle/Health/Shopping/Travel）
 *   - 11 种新 Event 类型
 * 明确要求：只生成 governance 文档（Constitution/State/File_Map/ADR），
 * 不生成任何实现代码。
 *
 * === 评估 ===
 *
 * 好的部分，而且不小：
 *   1. "Reminder OS 是全平台共享服务、不是 Productivity OS 专属"这个
 *      定位本身不是新东西——00_Project_Constitution.gs 的 P1 从
 *      2026-07-03 拆分那天起就是这么写的。这份 proposal 没有改变方向，
 *      只是提议在这个已经确立的方向上走得更远、更快。
 *   2. 建议把"Reminder Rule Engine"拆成"Temporal Engine（时间引擎）+
 *      Reminder Engine（提醒引擎）"——这个判断是对的。"每N天/每月最后
 *      一天/特定星期几"这类日期规则计算，跟"要不要因为这个规则发提醒"
 *      是两件可以分开的事，前者对 Finance（账单周期）、Property（租金
 *      周期）、Vehicle（保养周期）这些 OS 同样有用，不是提醒专属的东西。
 *      这是这份 proposal 里最站得住脚的一条架构判断。
 *   3. "Recurring 提醒"确实是当前系统一个真实存在的缺口，不是凭空想象
 *      出来的需求——现在的 25_ReminderEngine.gs 只认单次 due_date，
 *      没有"每周一提醒我"这种能力。这一点不需要等未来的 Domain OS 出现
 *      才成立，现在就缺。
 *
 * 让我没法直接照单全收的地方：
 *   1. 跟 P6 冲突。现在的系统是"一个函数（checkReminders）+ 一种规则
 *      形状（due_date + priority）"，proposal 要求一次性规划 7 个引擎 +
 *      10 个 schema 概念 + 5 个 AI 模块预留 + 8 个 Domain OS 集成 + 11 种
 *      事件类型——这个规模是现状的十几倍，而且大半是为还不存在的东西
 *      预留的（Vehicle/Health/Shopping/Travel OS 目前都没有代码；
 *      Escalation/Snooze/Analytics/多渠道 Dispatcher 目前没有任何具体
 *      场景在驱动这些需求，是纯粹面向未来的猜测）。
 *   2. Doc/code drift 风险。要求"只生成 governance 文档，不生成实现
 *      代码"——如果真按这个规模写 Constitution/File_Map/State，会变成
 *      一份描述 7 个引擎、几十个函数签名的架构文档，但代码这边一行都
 *      没有。这正是这个项目系列过去反复出现、也反复被你要求我核实纠正
 *      的那种"文档说有、代码里没有"的漂移，只是这次是我自己会成为制造者。
 *   3. Proposal 原话是"设计 governance 使 Claude 以后能独立生成每个引擎、
 *      不需要未来架构重构"——这个假设是"现在就能一次性想清楚正确设计"。
 *      但这个项目自己的历史不支持这个假设：recurring task 自动生成当初
 *      特意收窄成"日/周/月/年、interval=1"这个子集，没有一次性做全；
 *      外部审计提过的"Hybrid Event Pipeline"因为跟实际同步链路对不上被
 *      否决。这两次都是"先想清楚一部分、按实际使用情况再扩展"跑赢了
 *      "一次性设计完整"。这次没理由假设会不一样。
 *
 * === 建议 ===
 *
 * 不按字面把 7 个引擎当成"已经架构好的现实"写进 Constitution/File_Map/
 * State——那几份文档现在的角色是"如实反映当前状态"，不是"记录我们的
 * 野心"。这次改动范围：
 *
 *   1. 这份 ADR：把整个 V2 构想、好的部分、担心的部分都记下来，不丢失
 *      这次讨论——但标注成"Proposed"而不是"Accepted"，范围需要你拍板。
 *   2. 00_Project_Constitution.gs 只加一条指向性的 P7（"长期方向"），
 *      不逐条罗列 7 个引擎当作既定架构，只说"未来可能往这个方向发展，
 *      细节和评估见 ADR-003，目前零实现"。
 *   3. 00_Project_State.gs 只加一行指向这份 ADR，明确写"V1 仍是当前
 *      唯一在跑的实现，V2 是方向性讨论，没有任何代码/schema 落地"。
 *   4. 00_File_Map.gs 不加任何新的"预留"资料夹——Intelligence/Testing
 *      那两个空文件夹是因为 blueprint 本身六层是你明确要采用的架构骨架；
 *      这次 7 个引擎是否都要建、要不要建成这个规模，还没有定论，先建一堆
 *      空文件夹本身就是一种"看起来已经决定了"的暗示，不建。
 *
 * 如果你确认要往这个方向走，比字面这份 proposal 更谨慎、也更可能真正
 * 有用的起步方式：先只做 Temporal Engine 这一块，具体拆解见下面的
 * Architecture Roadmap。
 *
 * === Architecture Roadmap（Phase A → F，2026-07-06 补充）===
 *
 * 这一节采纳了 Carson 转述的第三方评估里"contract 可以先想、不用等到
 * 实现"的意见，但没有对每个 phase 一视同仁地套用——不同 phase 现在
 * 就把接口形状定下来的把握程度差很多，分开处理：
 *
 * Phase A — Temporal Engine（现在就做，唯一进入实现阶段的 phase）
 *   目的：把"规则 → 下次触发时间"这个计算能力做成一个不知道"提醒"、
 *   不知道 task、不知道 chat_id 的纯日期规则引擎——这样 Finance/Property/
 *   Vehicle 以后要复用的时候，直接用这个引擎算它们自己的账单/租金/保养
 *   周期，不需要先长出一层"提醒"外壳才能碰到里面的日期计算。
 *   这次先支持的规则形状：Daily / Weekly / Monthly / Yearly / Every-X-days
 *   ——不是 proposal 里列的 30 多种全部做完，跟当初 recurring task 自动
 *   生成收窄成"日/周/月/年、interval=1"是同一个思路。
 *   接口（这个 phase 会真的实现，不是草稿）：
 *     parseRule(ruleSpec) → 标准化的内部 schedule 模型
 *     calculateNextOccurrence(schedule, fromTime) → 下一次触发时间
 *     calculateOccurrences(schedule, fromTime, untilTime) → 区间内全部触发时间
 *     isDue(schedule, checkTime) → boolean
 *   明确不包含：missed-occurrence 补偿（属于 Phase B，是"提醒"专属的
 *   关注点，不是通用日期计算该管的事）、复杂 timezone 处理（先假设都在
 *   脚本时区，真的需要跨时区时再加）。
 *
 * Phase B — Reminder Scheduler（依赖 Phase A 完成）
 *   目的：把 Temporal Engine 的通用计算接到 Reminder OS 自己的场景——
 *   读新的 Reminder Rule schema（谁的规则、提醒给谁），调 Temporal Engine
 *   算下次触发时间，处理"checkReminders 有一小时没跑、是不是错过了一次
 *   该发的提醒"这类 reminder 专属的补偿逻辑。这一层知道"提醒"是什么，
 *   Temporal Engine 不需要知道。
 *   现在不写具体接口——要等 Phase A 真的跑起来，看 Temporal Engine 暴露
 *   出来的接口用起来顺不顺手，再设计 Scheduler 怎么接它更合适。
 *
 *   Open Questions（2026-07-06 记录，Carson 原文，刻意保留英文措辞）：
 *
 *   These questions are intentionally
 *   left unanswered until Phase A
 *   has been implemented and validated.
 *
 *   - Where should Reminder Rules be stored?
 *   - How should Scheduler integrate
 *     with existing checkReminders()?
 *   - How should missed occurrences
 *     be recovered?
 *
 *   These questions SHALL be answered
 *   using implementation experience,
 *   not speculation.
 *
 *   ⚠️ 下次要写 Phase B 设计（预期是 00_ADR_005）之前，先回来重新过一遍
 *   这三个问题——不是重新讨论"要不要回答"，是拿着 Phase A 实际用下来的
 *   经验（Temporal Engine 的接口用起来顺不顺手、有没有被迫改过 Contract、
 *   哪些假设被证明是错的）去回答，而不是现在凭空猜。这是 Progression
 *   Rule 的具体应用，不是另一条独立规则。
 *
 * Phase C — Snooze（草案级别）
 *   目的：10分钟/30分钟/明天早上/自定义时间 的延后提醒，不破坏原本排程。
 *   粗略方向：snoozeReminder(reminderId, until) 这类形状大概率不会错太
 *   多，但不在这次锁定——真到这个 phase 时手上会有 Phase A/B 跑出来的
 *   真实数据结构，到时候顺着那个设计，比现在凭空猜更准。
 *
 * Phase D — Escalation（暂不写接口）
 *   目的：超过X次没响应就升级（换间隔/换渠道/标记紧急）。
 *   这次评估里我跟第三方建议不完全一致的地方：Escalation 的规则形状
 *   高度依赖"用户实际会怎么忽略提醒"这个现在完全没有数据支撑的东西——
 *   现在写接口，本质上是在猜一个我们连需求都还没观察到的东西该长什么样。
 *   这里只记"这个阶段要解决什么问题"，不写方法签名。等 Snooze/Scheduler
 *   跑一段时间、真的看到"提醒被忽略"的模式之后，Escalation 该长什么样
 *   会清楚很多，那时候设计比现在猜的准。
 *
 * Phase E — Dispatcher 抽象（等第二个通知渠道出现）
 *   目的：send() / retry() / cancel() 这类多渠道发送抽象。今天只有
 *   Telegram，4_Integration/40_Output.gs 本身就是事实上的 Dispatcher，
 *   不需要额外抽象层——抽出来了也没有第二个实现，纯粹是死代码。
 *   这个我倾向同意第三方"可以先定"的判断：跟 Escalation/Analytics 不同，
 *   "发/重试/取消"这个形状不太依赖还没发生的具体使用场景，换成
 *   WhatsApp/Email/Push 也大概率还是这三个动作。所以粗略方向记在这里：
 *     send(channel, target, message, options) → deliveryResult
 *     retry(deliveryId) → deliveryResult
 *     cancel(pendingDeliveryId) → boolean
 *   但依然不是"锁定"，只是"这个猜测比 Escalation/Analytics 的猜测可信
 *   得多"——真的抽这一层出来，还是要等第二个渠道真实出现的那一天。
 *
 * Phase F — Analytics / AI Recommendation（有数据之后，暂不写接口）
 *   目的：完成率、平均响应时间、提醒疲劳检测、AI 推荐更好的提醒时间。
 *   现在没有任何历史数据能告诉我们"什么指标其实有用"，写接口纯粹是
 *   猜。等 Phase A-D 跑起来、真的积累了数据，这个阶段该长什么样会自己
 *   浮现出来，那时候再设计。
 *
 * 一句话概括这节的分寸：Phase A 真做，Phase E 可以先画个草图（因为这类
 * 抽象不太会因为具体用哪个渠道而改变），Phase B/C 等前一个 phase 跑出
 * 真实数据结构后再设计，Phase D/F 现在写接口就是纯猜测，先不写。
 *
 * === Progression Rule（2026-07-06 补充）===
 *
 * A phase MUST NOT be started merely because it exists in this roadmap.
 * Each subsequent phase MUST be justified by real implementation
 * experience or observed usage. The roadmap represents possible
 * evolution, not a delivery commitment.
 *
 * 白话：这份 Roadmap 是"可能会怎么演化"的地图，不是"以后一定会做"的
 * 承诺，更不是 backlog。半年后如果有人（包括我自己）翻到这份 ADR，
 * 看到"还有 Phase D、Phase E 没做"，不能直接得出"所以应该做"的结论——
 * 开始一个新 phase 的理由只能是"前一个 phase 跑出来的真实经验/观察到的
 * 真实用量"证明需要它，不能是"反正 roadmap 上写了"。
 *
 * 这条规则不只适用于 Reminder OS，以后其他 Domain OS 参照这份 roadmap
 * 做类似的分阶段规划时，同样适用。
 *
 * === Exit Criteria（2026-07-06 补充）===
 *
 * Roadmap 不只要说清楚"什么时候可以开始"，也要说清楚"做到什么程度算
 * 完成、可以考虑下一个 phase"，否则每个 phase 都容易无限膨胀。跟上面
 * 的 Progression Rule 合起来看：满足 Exit Criteria 是"可以考虑进入下一
 * phase"的必要条件，不是"自动触发"下一 phase 开工的理由——是否真的开工
 * 下一 phase，仍然要回头看 Progression Rule。
 *
 * 只给现在已经有具体设计（Phase A/B/C）的阶段定 Exit Criteria；Phase
 * D/E/F 连接口都还没写，也没有依据定"做到什么程度算完成"，勉强写只会
 * 是另一种形式的瞎猜，所以留空，等设计阶段到了再补。
 *
 * Phase A（Temporal Engine）Exit Criteria： ✅ 全部满足，2026-07-06
 *   ☑ parseRule/calculateNextOccurrence/calculateOccurrences/isDue 四个
 *     函数都实现，且行为符合 00_ADR_004_Temporal_Engine_Design.gs 里锁定
 *     的 Contract —— 见 1_Foundation/12_TemporalEngine.gs
 *   ☑ Daily / Weekly / Monthly / Yearly / Every-X-days 五种规则形状都有
 *     对应单元测试，覆盖正常情况 + 边界情况（比如 monthly day_of_month=31
 *     遇到没有31号的月份），全部通过 —— 见
 *     5_Testing/50_TemporalEngine_Tests.gs，39项测试全部通过
 *   ☑ 【2026-07-06 收紧，见 ADR-004】至少两个不同视角的调用场景验证过，
 *     不是只有一个——单一视角（哪怕真的接了 Reminder Scheduler）没法
 *     证明这个引擎真的跟"提醒"无关，只是看起来无关。测试矩阵里同时
 *     覆盖"Reminder 视角"和"非 Reminder 视角"（Finance/Vehicle 这类）
 *     的用例即可，不需要真的建一个 Finance OS 项目 —— 测试文件里
 *     medsRule（Reminder）/creditCardRule（Finance mock）/vehicleRule
 *     （Vehicle mock）三组用例都通过
 *
 * Phase B（Reminder Scheduler）Exit Criteria：
 *   □ 能正确处理 missed occurrence（checkReminders 隔了不止一小时才跑，
 *     期间应该触发的 occurrence 不会被静默漏掉）
 *   □ 支持至少一种 recurring reminder 端到端跑通：从 Reminder Rule 记录
 *     到 Temporal Engine 算出触发时间，到 25_ReminderEngine.gs 真的发出
 *     提醒消息
 *
 * Phase C（Snooze）Exit Criteria：
 *   □ Snooze 不会修改原始的 recurring schedule 本身（比如"每周一提醒"
 *     被 snooze 一次之后，下周一还是照常触发，不会因为 snooze 过一次就
 *     从排程里消失或错位）
 *   □ 支持从 snooze 状态恢复到正常排程
 *
 * Phase D/E/F：Exit Criteria 留空，理由同上——等到那个 phase 真的开始
 * 设计（如果真的开始的话，见 Progression Rule）时再定义。
 *
 * === 后果 ===
 *
 * - 本次不产出任何新的实现代码（不管是 V1 的修改还是 V2 的雏形），符合
 *   proposal"这次不写实现"的要求——Architecture Roadmap 里 Phase A 的
 *   接口是"设计"，不是代码，真正写 Temporal Engine 的实现是下一个、
 *   单独的任务。
 * - Constitution/State 各加一条简短的指向性记录，不包含 V2 proposal 或
 *   这份 Roadmap 的具体设计细节（那些留在这份 ADR 里，不散落到多份文档，
 *   避免以后要同步好几处）。
 * - Phase A-F 的颗粒度不是均匀的：Phase A 有具体接口、Phase E 有粗略
 *   草图、Phase B/C/D/F 只有目的、没有接口——这是刻意的，不是漏写，
 *   理由见各 phase 条目。
 * - 下一个决定点：是否现在就开始实现 Phase A（Temporal Engine）。这份
 *   ADR 本身只是设计/评估，不包含任何 .gs 代码；一旦确认要动手，会是
 *   独立的实现任务。
 * - 2026-07-06（同日跟进）：在真的写 TemporalEngine.gs 之前，先把
 *   Phase A 拆成 A0（Contract/数据模型/边界设计）和 A1（实现）——A0 的
 *   具体内容见 00_ADR_004_Temporal_Engine_Design.gs，同样不含实现代码，
 *   只锁定 RuleSpec/Schedule Model 长什么样、四个函数的输入输出、V1
 *   支持和明确不支持哪些规则形状。理由：Temporal Engine 是要被 Finance/
 *   Property/Vehicle 等未来项目复用的平台级能力，Contract 定错了之后
 *   要改，波及的是所有消费者，不是 Reminder OS 一个项目——先把 Contract
 *   钉死、经过 review，比一上来就写实现更划算。
 */
