/**
 * 00_ADR_001_Domain_OS_Blueprint_Adoption.gs
 * Reminder OS — 架构决策记录 #001
 *
 * STATUS: Accepted
 * DATE: 2026-07-06
 */

/**
 * === 背景 ===
 *
 * Carson 给出了一份跨所有 Domain OS 项目通用的分层 blueprint：
 *
 *   0. Governance   — Project Constitution / Project State / File Map / ADR(可选)
 *   1. Foundation   — Configuration / Schema / Identity / Event Definitions /
 *                      Permissions / Versioning
 *   2. Runtime      — Request / Planner / Decision / User Confirmation /
 *                      Execution / Event / Projection / Query
 *   3. Intelligence — Knowledge / Analytics / Prediction / Suggestions /
 *                      Insights / Learning
 *   4. Integration  — Bridge / Connectors / APIs / Import-Export /
 *                      External Systems
 *   5. Testing      — Unit / Integration / Migration / Validation
 *
 * 要求：把这份 blueprint 写入 governance files，并把 Reminder OS 现有代码
 * 按这个 blueprint 重新组织。
 *
 * 这份 blueprint 是平台级约定（适用于所有 Domain OS，不是 Reminder OS
 * 专属），按 00_Project_Constitution.gs 一贯的分工，权威/完整定义理论上
 * 该记在 Personal AI Core 项目里——但这次对话只上传了 Reminder OS 的代码，
 * 没有 Core 项目的文件，所以没有一并去改那边，只在 Reminder OS 自己的
 * Constitution（P5）和这份 ADR 里记了一份本地副本。
 *
 * === 决策 ===
 *
 * 1. 物理落地方式：GAS 是扁平命名空间、没有 import/require，重命名或挪动
 *    文件不影响任何函数/变量的可达性（都是全局作用域）。所以"套 blueprint"
 *    做成：按层建资料夹（0_Governance ... 5_Testing）+ 每层内部用两位数字
 *    前缀分配号段，取代原本的扁平编号（00/01/02/03/05/12/15/92）。
 *    资料夹结构在 Apps Script 编辑器里贴代码时会消失（GAS 只认档名，不认
 *    目录）——资料夹是为了这次交付、以及以后看 repo 时能一眼对上 blueprint，
 *    不是运行时会用到的东西，README.md 里也补了这句提醒。
 *
 * 2. 号段分配：
 *      0_Governance   → 00 番号不变
 *      1_Foundation   → 10-19
 *      2_Runtime      → 20-29
 *      3_Intelligence → 30-39（保留，本项目暂无文件）
 *      4_Integration  → 40-49
 *      5_Testing      → 50-59（保留，本项目暂无文件）
 *    每层号段内部刻意留空号（比如 Runtime 只用了 20/21/22/25），跟 Carson
 *    原本编号习惯（01/02/03/05/12/15/92 中间也有跳号）一致，给以后插入
 *    新文件留位置。
 *
 * 3. 现有文件 → blueprint 映射：
 *
 *      旧文件                    新位置                        blueprint 子分类
 *      ─────────────────────────────────────────────────────────────────
 *      00_Project_Constitution   0_Governance/00_...           Project Constitution
 *      00_Project_State          0_Governance/00_...           Project State
 *      00_File_Map               0_Governance/00_...           File Map
 *      (新增)                    0_Governance/00_ADR_001...     ADR
 *      01_SecureConfig           1_Foundation/10_SecureConfig   Configuration
 *      15_Setup ⚠️见下方4            1_Foundation/11_Setup          Configuration
 *                                                               （+部分 Testing/
 *                                                                Validation，
 *                                                                见下方判断5）
 *      02_EventBus               2_Runtime/20_EventBus          Event
 *      05_SheetUtils             2_Runtime/21_SheetUtils        Projection（主）+
 *                                                               Decision支撑+
 *                                                               跨层通用工具
 *                                                               （见下方判断6）
 *      12_QueryEngine            2_Runtime/22_QueryEngine       Query
 *      92_ReminderEngine         2_Runtime/25_ReminderEngine    Decision+Execution
 *                                                               （见下方判断7）
 *      03_Output                 4_Integration/40_Output        APIs / External
 *                                                               Systems（Telegram）
 *      —                         3_Intelligence/                本项目暂无内容
 *      —                         5_Testing/                     本项目暂无内容
 *
 * 4. 【重要发现，不是这次 blueprint 决策的一部分，是执行过程中顺带核实出
 *    来的】上传的 15_Setup.txt 内容实际是 12_QueryEngine.txt 的完整复制，
 *    文件头注释都写着"12_QueryEngine.gs"，不是 File_Map/README 描述的
 *    createTriggers/runDiagnostics。这不符合 Carson"以实际代码为准，不
 *    单信文档"的一贯要求——但这次是反过来：文档（File_Map/README）彼此
 *    一致地描述了 Setup.gs 该做什么，唯独这份代码文件本身的内容跟文件名/
 *    自己的用途对不上，判断是打包 zip 时的复制粘贴失误。已在
 *    1_Foundation/11_Setup.gs 里按文档描述重建了一份、并在文件头+
 *    00_Project_State.gs 明确标注"这是重建、不是原始代码，待确认"，
 *    没有假装这是验证过的真实代码。
 *
 *    ✅ 【2026-07-06 同日跟进】Carson 提供了 15_Setup.gs 真实代码，已替换
 *    掉重建版。File_Map/README 当初对这个文件行为的文字描述本身没有问题
 *    （createTriggers 挂 checkReminders 每小时触发器、runDiagnostics 验证
 *    Tasks 表可读+发测试消息，两边都对得上），确认纯粹是 zip 打包环节的
 *    复制粘贴失误，不是文档跟代码脱节。真实版 runDiagnostics() 比重建版
 *    多了 SPREADSHEET_ID / TELEGRAM_TOKEN 各自独立的存在性检查，且是逐条
 *    Logger.log 输出诊断信息，不返回结构化对象——这类实现细节上的差异，
 *    印证了当初"具体实现我没有依据，只能按最保守写法猜"那句话是对的，
 *    没有虚构不存在的行为，只是猜得不够细。
 *
 * 5. 15_Setup 的分层归属：createTriggers（挂 trigger）比较像 Foundation/
 *    Configuration（部署时的基础设施设置），runDiagnostics（验证部署是否
 *    正常）比较像 Testing/Validation。文件本身不到 40 行，两个函数放一起
 *    多年一直没出过问题，为了不做过度设计（P6）没有强行拆成两个文件——
 *    以 Foundation 为主分类，Testing 那一半在这条 ADR 和 File_Map 里
 *    文字说明即可，不体现在实际拆分上。
 *
 * 6. 21_SheetUtils.gs 为什么没有拆分：这个文件本身就是历史上"反重复实现"
 *    （C5）的产物——isOverdue_/parseDueDate_ 原本散落在 ReminderEngine，
 *    round1_/round2_ 原本散落在 MemoryEngine，21_InventoryModule 等文件
 *    又各自重复实现或隐式跨文件调用，2026-06-27/06-29 的审计把它们统一
 *    搬到了这一个文件。如果这次为了套 blueprint 又把它按子分类拆回去
 *    （Projection 一个文件、Decision支撑一个文件、通用工具再一个文件），
 *    等于重新引入"同一类逻辑散落在多处"的风险，跟当初合并的理由正面冲突。
 *    所以选择保留合并、只在文档层面（File_Map/这条ADR）标注它横跨哪些
 *    子分类，而不是物理拆分。
 *
 * 7. 25_ReminderEngine.gs（原92）为什么没有拆分：这是本项目唯一的核心域
 *    引擎，_shouldRemind/_isOverdue 是 Decision，checkReminders/_buildReminder/
 *    _sendReminder 是 Execution，_updateReminderCount 会触发 Event
 *    （EventBus.publish）和 Projection（upsertRowByKey_）。对于一个只有
 *    6 个函数、单一职责（提醒）的引擎，拆成 Decision.gs/Execution.gs 两个
 *    文件不会让代码更清楚，只会让人要来回切文件看一个完整的提醒判断流程，
 *    违反 P6。保留单文件，子分类归属在文档层面说明。
 *
 * 8. Intelligence / Testing 两层留空文件夹 + _RESERVED.txt 说明，而不是
 *    干脆不建：这样 blueprint 六层结构在这个项目里完整可见，以后要往这两
 *    层加东西时有现成位置；同时 _RESERVED.txt 明确写"为什么是空的"，
 *    避免以后有人（包括我自己）看到空文件夹以为是漏做了，制造新的
 *    doc/code drift。
 *
 * === 后果 ===
 *
 * - 00_File_Map.gs 整份重写，反映新结构。
 * - 00_Project_Constitution.gs 新增 P5，P4 补充"已修复"更新，避免 P4
 *   原文（"HIGH RISK 2 还没修"）在 bug 修复后变成过时/误导的陈述。
 * - README.md 的文件清单+部署步骤同步更新新文件名，并加一句"资料夹结构
 *   只是这份交付/repo 里的组织方式，贴进 Apps Script 编辑器时都是平铺文件"
 *   的提醒。
 * - 不影响任何运行时行为——这条 ADR 涉及的改动全部是文件物理位置、文件名、
 *   文档，唯一的代码行为变化是 HIGH RISK 2 的修复（见 25_ReminderEngine.gs
 *   和 00_Project_State.gs「已完成」），那是独立于这次分层决策的另一个改动。
 */
