# Architecture Review — Reminder OS Temporal Engine (Phase A)

**Standard used:** Universal Engineering Framework, `02_Architecture_Review_Standard/` — full workflow (Profile Selection → Checklist Execution → Findings → Disposition → Gate Decision), no bespoke checklist.

---

## 1. Review Request

| Field | Value |
|---|---|
| Scope | `12_TemporalEngine.gs`, `50_TemporalEngine_Tests.gs`, `00_ADR_004_Temporal_Engine_Design.gs` |
| Review Profile | **Engine** |
| Feeds gate | Testing Gate (retroactive) — Architecture/Contract/Implementation Gates were already cleared 2026-07-06 via an internal "Gate Review A0→A1," predating UEF's ratification (2026-07-10) |
| Trigger | First UEF-conformant review for Reminder OS — no prior entry exists in `06_Review_History.md` (Investment OS has the only entry so far, 2026-07-10) |
| Prior review | Internal Gate Review, recorded inline in ADR-004's revision log, not in UEF vocabulary |
| Requested by | Carson |
| Date | 2026-07-12 |

**Profile confirmation:** Engine, not Platform. `12_TemporalEngine.gs` is designed to be *copied whole* into future sibling projects (Finance OS, Vehicle OS), not called as one shared running service the way `01_Review_Profiles.md` §3.5's Platform examples (a shared webhook receiver, a shared job queue) are. Each future copy will be its own Engine-profiled artifact in its own project. This matters for scoping: Engine's minimum checklist is Separation of Concerns / Reusability / Performance / Testing / YAGNI, not Platform's Scalability / Dependency Direction / Security.

**Out of scope — marked N/A, not reviewed, not designed:** Reminder Scheduler, Dispatcher, History, Analytics, Escalation, Snooze, and any Phase B–F design. Per `00_ADR_003_Reminder_OS_V2_Vision_Evaluation.txt`'s Progression Rule, none of this exists in code and none of it should be speculatively designed by this review.

**Verification method:** every finding below was checked against the actual, verbatim uploaded files — not against ADR-004's description of them. The 39 checked-in tests were independently re-executed (byte-identical copy of both files, run in Node — the module's own zero-dependency design is what makes this possible) and confirmed 39/39 passing, matching `00_Project_State.txt`'s claim exactly. Beyond that, additional probes were run against the real implementation to test conditions the checked-in suite doesn't cover; two of those probes surfaced real, reproducible gaps (Findings 1 and 2 below).

---

## 2. Checklist Execution (Engine minimum + Contract Stability / Governance / Doc-Code Drift, per this review's explicit scope)

| Item | Result | Note |
|---|---|---|
| A1 — Separation of Concerns | **Pass** | Single, stated responsibility ("rule → occurrence times"). Private helpers (`_xxx`) never exposed. `grep`'d the actual file for any Reminder/task/chat_id/Telegram/Sheet/other-file identifier — zero hits in executable code (only in comments explaining what it deliberately avoids). ADR-004's "no Reminder bias" claim is verified at the code level, not just asserted. |
| A4 — Contract Stability | **Pass, 3 LOW findings** | Findings 1, 2, 3 below — all concern what happens on input the Contract doesn't explicitly cover, not the documented happy-path shapes. |
| B3 — Reusability | **Pass** | Constants (`MAX_OCCURRENCES`, `MONTHLY_SEARCH_LIMIT`, `YEARLY_SEARCH_LIMIT`) defined once. One deliberate duplication exists (see §4 "Checked, not a finding" below) — already has an accepted disposition, not re-flagged. |
| B4 — Performance | **Pass** | Search-limit guards (48 months / 12 years) and the 1000-occurrence cap all verified correct by direct execution, not just by reading. `every_n_days`' estimate-then-correct anchor arithmetic was stress-tested across a 10-year gap and lands on the exact correct date — no drift. |
| C1 — Testing | **Pass, 1 LOW finding** | 39/39 re-executed and confirmed. Finding 4 below is a coverage gap, not a behavior defect — the guarded code works, it's just not exercised by anything that runs automatically. |
| D1 — Governance | **Pass** | ADR-004 is current and detailed. `00_Project_State.txt` accurately reflects Phase A = Done / Phase B = not started — checked against actual files, not taken on faith. |
| D2 — YAGNI | **Pass — exemplary** | Every excluded V1 feature (timezone parameter, multiple times per day, quiet hours, N-week/month/year intervals) has stated reasoning in ADR-004, including an explicit "considered and rejected" section for the timezone parameter. No dead code found. |
| D3 — Doc/Code Drift | **Pass, findings noted** | The "39 tests passing" claim is accurate (re-verified by execution). The only real drift is Findings 1–2: the Contract's error-handling language is slightly more absolute than what the implementation actually guarantees. |

**0 outright Fail.** 4 of 8 groups carry a LOW-severity finding; none block a gate on their own (Architecture Gates §5).

---

## 3. Findings

### Finding 1 — Out-of-contract `schedule.type` degrades to a silent `undefined`, not a clear error

**File / Module:** `12_TemporalEngine.gs`
**Function:** `calculateNextOccurrence` (root cause); `calculateOccurrences` and `isDue` inherit the exposure (both call it and immediately read `.getTime()` on the result)
**Checklist item:** A4 Contract Stability

**Mechanism:** `calculateNextOccurrence`'s `switch (schedule.type)` covers the 5 valid types with no `default` case. If `schedule.type` doesn't match any of them — because a caller built a Schedule-Model-shaped object without going through `parseRule()`, or a stored/deserialized schedule no longer matches a current valid type — the function falls through and implicitly returns `undefined`, no throw.

**Evidence:** ran the verbatim uploaded implementation against `{type:'hourly', hour:9, minute:0}` (bypassing `parseRule`). `calculateNextOccurrence` returned `undefined` with no throw. `calculateOccurrences` on the same input then threw `TypeError: Cannot read properties of undefined (reading 'getTime')` — a generic runtime error with no indication the real problem is an invalid `schedule.type`.

**Severity:** LOW
- Likelihood: Rare (zero callers exist today — confirmed in Project State — so unreachable in production right now; becomes reachable once any consumer reconstructs a schedule without re-running `parseRule`)
- Impact: Medium (misleading, wrong-layer error; costs real debugging time if it ever fires)

**Disposition:** Confirmed

**Recommendation:** Add a `default:` branch (or an upfront type-membership guard) that throws a named, specific error instead of falling through. A few lines, no contract-shape change, no consumers to migrate today.

---

### Finding 2 — `parseRule` accepts calendrically-impossible `yearly` day/month combinations; the failure surfaces later with a misleading message

**File / Module:** `12_TemporalEngine.gs`
**Function:** `parseRule` (missing validation); `_nextYearly` (where it actually breaks)
**Checklist item:** A4 Contract Stability; also directly relevant to ADR-004's own stated principle that invalid caller input should throw *at parse time*

**Mechanism:** For `type:'yearly'`, `parseRule` validates `month` (1–12) and `day` (1–31) independently, never whether `day` can occur in `month` in *any* year. The only combination meant to slip through despite being invalid most years is `day=29, month=2` (a real leap-year birthday) — `_nextYearly`'s 12-year search window exists specifically for that case. A combination that's impossible in *every* year (`day=30, month=2`; `day=31, month∈{4,6,9,11}`) also passes `parseRule` silently, then exhausts that same 12-year search and throws: *"内部错误，yearly 规则在12年内没找到下一次触发（不应该发生，请检查闰年计算或搜索上限）"* — a message that blames leap-year math or the search limit, not the actual defect (a `RuleSpec` that should never have parsed).

**Evidence:** ran `parseRule({type:'yearly', month:2, day:30, ...})`, `month:4, day:31`, and `month:6, day:31` against the verbatim uploaded file — all three returned successfully, no throw. Calling `calculateNextOccurrence` on each then threw the internal-error message above. Control case (`month:2, day:29`) correctly resolved to `2028-02-29`, confirming the defect is specific to impossible-in-any-year combinations. Also confirmed `monthly` does **not** share this exposure — `day_of_month=31` correctly rotates across the 7 months that have a 31st, since `monthly` searches across months rather than fixing one (verified across a full 12-cycle run).

**Severity:** LOW today, flagged for re-scoring
- Likelihood: Rare now (zero callers); re-scores to Foreseeable the moment any caller constructs `yearly` rules from less-controlled input (day=31 for a 30-day month, or day=30 for February, are ordinary typos, not contrived edge cases)
- Impact: Medium (wrong failure layer, misleading message; a caller trusting "`parseRule` succeeded" as "input is valid" is misled)

**Disposition:** Confirmed

**Recommendation:** In `parseRule`, for `type==='yearly'`, add the same day-fits-in-month check `_nextYearly` already does internally, evaluated against a leap year (so day=29 still passes, day=30 still correctly fails) — reject at parse time with a specific message. Small, local, zero consumers to migrate. Recommend fixing alongside Finding 1, and tightening ADR-004's Contract section to state explicitly which `yearly` combinations are calendrically valid.

---

### Finding 3 — Schedule Model immutability is convention-only, not runtime-enforced

**File / Module:** `12_TemporalEngine.gs`
**Function:** `parseRule`
**Checklist item:** A4 Contract Stability / D3 Doc/Code Drift

**Mechanism:** ADR-004 states consumers "MUST NOT mutate Schedule objects after `parseRule()` returns them." True of the functions themselves — none provide or rely on a mutating method. But the returned object is a plain object, never passed through `Object.freeze()`. Nothing at runtime stops `schedule.hour = 10` from a future caller. GAS's V8 runtime supports `Object.freeze()` natively — this isn't a platform gap, just an unused guard.

**Evidence:** read directly from `parseRule`'s `return schedule;` (line 137) — no freeze anywhere in the file. (Array fields like `daysOfWeek` *are* correctly defensively copied rather than referencing the caller's original array, so that specific sub-case is already sound — the gap is only that the returned object's own fields stay reassignable.)

**Severity:** LOW
- Likelihood: Foreseeable (once more than one consumer can hold the same Schedule reference)
- Impact: Low (per ADR-004's own reasoning — one holder's accidental mutation silently affects others holding the same reference; narrow, traceable blast radius, not a crash)

**Disposition:** Confirmed

**Recommendation:** `return Object.freeze(schedule);` — one line, zero effect on any currently-passing test, closes the gap between what's promised and what's enforced.

---

### Finding 4 — `calculateOccurrences`' 1000-occurrence cap has zero test coverage

**File / Module:** `50_TemporalEngine_Tests.gs`
**Function:** N/A — coverage gap, not an implementation defect
**Checklist item:** C1 Testing

**Mechanism:** The implementation correctly enforces `MAX_OCCURRENCES = 1000` as a silent-truncation cap. None of the 39 checked-in tests exercise a range wide enough to reach it — the only `calculateOccurrences` tests use a 3-day window and an empty-range case.

**Evidence:** ran a 10-year daily range (would produce ~3,650 occurrences uncapped) against the verbatim implementation — returned exactly 1,000. The behavior is correct; it's simply unverified by anything that runs automatically.

**Severity:** LOW
- Likelihood: Rare (correctness confirmed by this review; risk is only that a future change silently breaks the cap with nothing to catch it)
- Impact: Low (bounded even in the worst case)

**Disposition:** Confirmed

**Recommendation:** Add one test asserting a wide-range call returns exactly 1,000 results.

---

### Checked, not a finding — `_parseDateOnly` duplicates `21_SheetUtils.gs`'s `parseDueDate_`

**Checklist item:** B3 Reusability ("never duplicated and left to drift")
**Disposition:** **Won't fix (with ADR)** — ADR-004's Dependency Rule explicitly requires zero dependency on any other file in this project, specifically so `12_TemporalEngine.gs` can be copied whole into a new project later. This is a documented, deliberate exception, not an oversight. Flagging this as fresh "hidden coupling" would contradict a decision already on record — this is exactly the case the Disposition step exists to catch before it becomes wasted rework.

---

## 4. Risk Matrix Summary

| # | Finding | Likelihood | Impact | Severity |
|---|---|---|---|---|
| 1 | Malformed `schedule.type` → silent `undefined` | Rare | Medium | **LOW** |
| 2 | Impossible `yearly` day/month accepted | Rare (→ Foreseeable) | Medium | **LOW**, flagged for re-scoring |
| 3 | Immutability unenforced | Foreseeable | Low | **LOW** |
| 4 | 1000-occurrence cap untested | Rare | Low | **LOW** |

**HIGH: 0 · MEDIUM: 0 · LOW: 4.** All four Confirmed. None require an ADR revision to *accept* — they're fix-it-in-code items, not tradeoffs to ratify.

---

## 5. Scores

UEF doesn't define a formal point formula for these — the numbers below are a transparent proxy over the checklist/severity results above, not an official UEF metric.

**Architecture Score: Strong (~92/100 proxy)**
8/8 checklist groups pass, 0 outright fail, 0 HIGH/MEDIUM findings. Verified strengths beyond what ADR-004 claims about itself: zero Reminder-logic leakage (grep-checked against real code), correct leap-year handling including the century-year exception (2100 not a leap year), correct month-overflow skip-logic across a full annual cycle, and an `every_n_days` anchor algorithm confirmed correct across a 10-year gap. 4 LOW findings, all cheap to close.

**Contract Stability Score: Sound, with 2 confirmed gaps (~85/100 proxy)**
Function signatures, the RuleSpec/Schedule Model split, and the V1 scope boundary are clean and stable. The gap is concentrated specifically in error-handling completeness (Findings 1 and 2) — what happens on input the Contract doesn't explicitly cover — not spread across the whole contract surface.

---

## 6. Go / Conditional Go / No-Go

### Conditional Go

Scoped precisely to: **is Phase A (Temporal Engine) sound enough to stand as a stable foundation, for Phase B to build on whenever Phase B is separately justified by real need (per the Progression Rule)?** This review does not itself decide whether Phase B should start now — that stays a distinct decision, out of scope here.

**Condition:** fix Findings 1 and 2 before anything begins depending on the current permissive behavior. Both are small, local, zero-consumer-today code changes. This is the cheapest possible moment to fix them — after any real caller exists, the same fix becomes a versioned contract change with a consumer to migrate (`08_Migration_Standard.md`), not a free edit.

**Not a No-Go:** 0 HIGH, 0 MEDIUM findings. Per Architecture Gates §5, LOW findings never block a gate on their own.
**Not an unconditional Go:** 2 of the 4 findings are genuine, reproducible Contract gaps (verified by running the code, not just reading it), not cosmetic polish.

Findings 3 and 4 are optional hardening — fine to batch in with 1 and 2, or defer without ceremony.

---

## Appendix — ready-to-append entry for `06_Review_History.md`

```
### 2026-07-12 — Reminder OS — Temporal Engine, Phase A (Profile: Engine)
Reviewer: Claude (session-based review, single-project)
Gate feeding: Testing Gate (retroactive — Architecture/Contract/Implementation Gates
  cleared 2026-07-06 via pre-UEF internal Gate Review)
Findings: 4 (0 HIGH, 0 MEDIUM, 4 LOW)
Dispositions: 4 confirmed; 1 additional checked item (B3 duplication) resolved as
  Won't fix (with ADR) — already covered by ADR-004's Dependency Rule
Notable: all 4 findings concern behavior on input the Contract doesn't explicitly
  cover (invalid schedule.type bypassing parseRule; calendrically-impossible yearly
  day/month combinations; unenforced immutability) rather than the documented
  happy-path shapes, which verified clean. 39/39 checked-in tests independently
  re-executed and confirmed (not just re-read). This is Reminder OS's first
  UEF-conformant review.
Full record: Reminder-OS_TemporalEngine_Architecture-Review_2026-07-12.md
```
