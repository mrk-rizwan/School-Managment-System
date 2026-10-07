# Phase 4 — Academic: build plan

**Audience:** the Opus 5.5 session that writes the code. Self-contained; read `CLAUDE.md` (rules
3, 4, 6, 13, 16, 20 and the 2026-10-07 rules 26–31, the tenancy section, the register), then
`docs/WORKLOG.md` ("What Phase 4 inherits from Phase 3", "Left to do", the process notes), then
this file top to bottom. **Author:** Fable 5.1, 2026-10-07. **Builds on** `phase-1-foundation.md`
(R1–R104), `phase-2-daily-operations.md` (R105–R175) and `phase-3-financial.md` (R176–R253), all
complete; nothing from them is restated unless Phase 4 changes it. **Reviewed** by
`business-rules`, `data-architect`, `security-reviewer` and `api-designer` on 2026-10-07; every
finding is folded in. The first draft's enrolment-keyed composition, whole-class exams, single
own-child flag, lazy sheet creation, `PUT` routes, `Idempotency-Key` on the marks grid, grade-band
table, null-means-final class link, sequential roll numbers at promotion, and position by total
marks were all changed. **Status:** revised after four reviews; **approved by the owner for execution
on 2026-10-07** ("proceed code"), with every §1.1 default and §1.2 stance as written. The owner's decisions (rules 26–31) are settled; §1.2 lists what stays open.

Phase 4 delivers the academic record the school was sold: subjects per class; the terms of a
year; class tests a teacher creates and marks from the phone, offline; the term exam the principal
sets up; a term result composed by one rule from tests and exam, graded by the school's bands;
the result sheet a class teacher submits and the principal approves from the Approvals inbox;
publication to guardians and students by the usual routing; the report card, rendered in the app
and printed from the web, with attendance and the class teacher's remark; corrections as revised
rows that reissue the card; certificates numbered per type and printable years after a student
left; and the year end — a promotion sheet per section that opens the next year's enrolments and
lets the academic year close. Plus the parent's, student's and principal's views and the result
reports.

**Size, stated honestly.** About **33 working days** — three more than the Phase 1 close
estimated, added by the reviews: marks that follow a student across a mid-term section change,
per-section exams, the correction cascade through the final result and an open promotion sheet,
`approved → returned` for two-step schools, the explicit "not held" and "no class teacher" exits
so a year can always close, and the subject-aware scope the repositories need. Slices 29–36
continue Phase 3's numbering; rules continue from R254; waves from M.

---

## 0. Rules that bind every task

Phase 1 §0 rules 1–10, Phase 2 §0 rules 11–17 and Phase 3 §0 rules 18–24 apply unchanged, with
the wave process from `WORKLOG.md` ("Process since 2026-10-03"): groundwork commit, waves, one
security and one correctness review per wave, one fix round, the main thread's full check, one
`phase-gate` at slice 36. Additions for Phase 4:

25. **A mark is a fact about a student; a result is a snapshot of an enrolment.** `marks` rows
    are never edited: a changed mark, an excusal and a correction are new rows that supersede the
    old one (rule 4). A mark names the student, the year and the assessment; composition reads a
    student's live marks **across every enrolment they held in that class and year** (a section
    change is close-old/open-new, R174, and must not lose a mark), and the `results` row hangs off
    the enrolment in force on the term's last day. A `results` row stores every number the card
    prints; the sheet version stores the weights, bands and pass rule used; a later change to any
    of them rewrites nothing. A corrected result is a new sheet version with a full row set, each
    row referencing the one it supersedes.
26. **Composition is one pure function, and the printed figures add up.** `packages/shared/src/
    results/` computes a subject's term percentage, the printed obtained mark, the overall figures,
    the grade, the position, the final result across terms and the pass verdict from plain inputs;
    the API calls it inside the approving transaction and stores the output; the web and the app
    call the same function only to preview a draft sheet. Percentages are integers in **basis
    points** (7850 = 78.50 %), rounded half-up once per figure. **The overall figures are computed
    from the printed per-subject marks**: total = Σ printed obtained, percentage = total ÷ Σ max,
    and the per-subject pass check reads printed obtained ÷ max — so a parent who adds up the card
    gets the card's percentage.
27. **Teacher scope comes from assignments, never from a checkbox** (rule 13), and **it carries the
    subject.** A new branded `MarksScope`, minted only in `src/tenancy/scope.mint.ts` from
    `teacher_assignments` for a given date, carries per section `{ subjectIds, classTeacher,
    cover }`. Every assessment and mark repository method takes it; the predicate is
    "`section_id ∈ scope` and (`subject_id ∈ scope[section].subjectIds` or the caller is that
    section's class teacher reading)". A subject teacher writes only their subject; a class
    teacher reads every subject of their section and writes only a subject they are assigned; a
    cover assignment carries the covered scope for its dates (R175); an office grant of
    `marks.enter` carries `all` scope (as Phase 2's `attendance.student.mark`). The date that mints
    the scope is the assessment's `held_on` for marks, today for sheets. An empty scope reads
    nothing; outside it is `404`.
28. **Approval is an audited state change behind a capability, not a principal gate.**
    `result.approve` approves or returns a sheet and decides excusals and corrections;
    `result.publish` makes an approved sheet visible; `assessment.define` sets up terms, settings,
    exams, "not held" and promotion; `certificate.issue` issues certificates. The principal holds
    all four by default; a custom role may hold a subset (that is the two-step approve-then-publish
    of rule 27). Invariants as triggers and service checks: **the approver is never the submitter
    of a sheet or the author of a correction** (`SELF_ACTION_FORBIDDEN { reason: 'submitter' |
    'author' }`), with Phase 3's **sole-principal exception** (`asms_is_sole_principal`, recorded
    `self_approved`, shown in the inbox — §1.1); **a per-student decision on the actor's own child
    is refused** (excuse, correction decisions: `ownChildCheck`, R232); **a whole-section approval
    is flagged, never blocked** when the approver, the submitter, the remark author or any mark's
    author is a guardian of a student on it — the flags are recomputed from live rows at every
    composition and never copied.
29. **Families see only approved results.** A guardian's or student's route returns class-test
    marks (`kind = test`, live rows, non-voided tests) as soon as they are entered (rule 27), and
    term, final and card data only from a `results` row with `published_at` set and
    `superseded_at` null, belonging to that child (R78). A student's routes resolve the student
    from the session, never from a parameter. No preview for families.
30. **Online-only on the phone:** submit, return, approve, publish, excuse, correction decisions,
    certificates, promotion and year close. Offline through the outbox: creating a class test and
    entering or changing marks on an unlocked assessment (two lanes, §3.8). `ONLINE_ONLY_ACTIONS`
    names the rest; R162 extends to them.
31. **No new capability keys.** `assessment.define`, `marks.enter`, `marks.view_all`,
    `result.approve`, `result.publish`, `certificate.issue`, `subject.manage`, `class.manage`,
    `academic_year.manage`, `student.status.change` and `enrolment.manage` exist since Phase 1 and
    cover every Phase 4 route (§3.1). `timetable.manage` stays unused until Phase 5. No `PUT`:
    whole-list writes are `PATCH /x/:id { list }` or `POST /x/:id/<verb>`, as everywhere else.

---

## 1. Decisions Phase 4 needs

The register in `CLAUDE.md` is canonical; rules 26–31 were confirmed on 2026-10-07 and the owner
accepted every recommendation ("go with recommendations"). Everything below marked
**main-thread default** is a choice inside those rules; each is open to the owner's correction and
changes a named slice, not the schema.

### 1.1 Main-thread defaults (the owner may correct any; the plan changes, the schema does not)

| Rule | Item | Default in this plan | First used |
|---|---|---|---|
| 26 | Terms of a year | Two, `Mid-term` (first half) and `Annual` (the rest), seeded by `asms_seed_year_results` when a year is created (backfilled for existing years); up to six; non-overlapping, inside the year; dates and weight editable until any assessment or any submitted sheet of the term exists | Slice 29 |
| 26 | Term not held for a class | `assessment.define` marks a term `not_held` for a class (nursery has no mid-term); the final result and the year close skip it | Slice 29 |
| 26 | Test types | `daily`, `weekly`, `monthly`, `other` — a label, no behaviour | Slice 30 |
| 26 | Weights | `test_weight` 20, `exam_weight` 80 per year, summing to 100; term weights for the final result equal (`100 ÷ terms held`, remainder to the last) | Slice 29 |
| 26 | Missing component | A subject with no test held for the student carries the exam at 100 %; an excused exam carries the tests at 100 %; both missing → `not_assessed`, excluded from totals, printed "—" | Slice 31 |
| 26 | Missing test mark | A test held before the student's first enrolment in that class is excluded; a test held on or after it with no mark row is a gap: submit lists it under `MARKS_INCOMPLETE` (an absence must be entered, never assumed) | Slice 31 |
| 26 | Pass rule | `pass_rule = all_subjects` (every assessed subject's printed obtained ÷ max ≥ pass mark); `overall` is the alternative; `passed` is **null** when no subject is assessed | Slice 29 |
| 26 | Max marks | Each exam has its own `max_marks` (default from the class-subject's `exam_max_marks`, 100), editable until a mark exists; a test has its own | Slices 29, 30 |
| 26 | Printed marks | Per subject, `obtained = round(percent × max)`; totals and the overall percentage come from the printed marks (§0.26) | Slice 31 |
| 27 | The approval unit | **The section** (a class with one section is the class): the class teacher's own unit; position is within the section (A5) | Slice 31 |
| 27 | Sole principal | In a school with exactly one active principal, that principal may approve a sheet they submitted or a correction they authored, recorded `self_approved` and shown in the inbox (Phase 3 R253's mechanism) | Slice 31 |
| 27 | Who submits | The section's class teacher (or cover); when none is assigned, an `assessment.define` holder may submit | Slice 31 |
| 27 | Submission check | Every student on the sheet has a live mark or absence for every exam and every applicable test of the term; gaps are listed | Slice 31 |
| 27 | Position | Standard competition ranking (1, 1, 3) by `percent_bp` within the section; `position_of` = the number of positioned students; a student with nothing assessed holds no position | Slice 31 |
| 27 | Attendance on the card | The term's dates (the whole year on the final card), from `attendance_day_status` through `attendancePercentage()`, snapshotted at approval | Slice 31 |
| 27 | Notification | `result_published` to the fee-payer guardians, else primary contact, else every live guardian with a phone (the receipt rule), and to the student's own login; SMS allowed by default; `result_revised` the same way for a corrected student only, once per approved correction | Slice 31 |
| 27 | Class-test notification | `notify_class_tests` off; when on, `test_marked` goes by in-app and push (title-only) only, never SMS | Slice 30 |
| 27 | Correction cascade | A correction re-composes the term sheet as a new version with the full row set (`revised` marks the rows whose figures changed), and the published final sheet in the same transaction; an open promotion sheet re-reads at apply; an applied one stands and records `revised_after_apply` | Slice 32 |
| 28 | Withheld card | `withhold_card_for_dues` off; when on, the guardian sees percentage, grade and the outstanding figure but not the per-subject card until the dues endpoint says cleared or overridden; **the student's login sees no figure** | Slice 32 |
| 28 | Term remark | ≤ 300 characters, by the class teacher, on the sheet before submission; printed on the card; separate from Phase 2 remarks | Slice 31 |
| 29 | Certificate numbers | `school_counters` keys `cert_leaving`, `cert_character`, `cert_academic`, `cert_completion`, `cert_other`; printed `LC-0001`, `CC-`, `AC-`, `PC-`, `OC-` with at least four digits, never reset | Slice 34 |
| 29 | Identity number on the leaving certificate | `certificate_show_identity_no` **on**, leaving certificate only: the student's B-Form number appears in the print view (decrypted in the handler, audited `certificate.printed { identityPrinted }`), never in a DTO, a body or a log | Slice 34 |
| 29 | Signatory | `certificate_signatory_name` on school settings, defaulted at first issue to the active principal's name; the issuer prints as "issued by" | Slice 34 |
| 29 | Year on a certificate | `academicYearId` optional; default the student's last enrolment's year | Slice 34 |
| 30 | Roll numbers after promotion | **Null** on the new enrolment (as a section change does); the office assigns through the existing enrolment route | Slice 35 |
| 30 | Target year | One per promotion sheet (`planned` or `active`), default the next year by start date; the next year, its classes and each class's `next_class_id` must exist first (the screen says so) | Slice 35 |
| 30 | Final class | `classes.is_final` (explicit, `class.manage`): a passed student is proposed `complete` → alumni; a non-final class without `next_class_id` proposes `promote` with no target, which the principal fills | Slice 35 |
| 30 | Suspended at year end | Assessed and promoted, detained or completed like anyone (rule 20: still enrolled); `not_continuing` is refused for a suspended student (reactivate first, R36) | Slice 35 |

### 1.2 Open to the owner (the plan does not guess)

| # | Question | Phase 4 stance |
|---|---|---|
| 32 | **Grade bands and pass mark values** (rule 26 seeds a default) | Built as per-year data with a screen; tuned before the first sheet of a year is approved (frozen after, §3.2) |
| 33 | **Does the student's B-Form number print on the leaving certificate?** Standard practice; the security review accepted the default with the conditions of §7.1 | Default on, leaving only, one setting |
| 34 | **Repeat (detained) students and fees** | Nothing built; no admission charge on promotion or detention (readmission charges it) |
| 35 | **Grace marks** — many schools lift a borderline failure by a few marks; the plan's override-with-reason on the promotion sheet covers the decision, but the card still prints the failing mark | Not built by default. Minimal shape if wanted: `grace_marks` per year (default 0), applied by `composeResult` to the subjects nearest the pass mark, printed with a mark; re-sits stay out of scope (a correction with reason type `supplementary` is the workaround) |
| 36 | **Position within the section, not the class** (A5) — rule 28 says "position in class"; sections approve at different times | Section by default; a class-wide `class_position`, filled once when the class's last section publishes, is the cheap addition if wanted |

### 1.3 Assumptions (each marked A*n*; correcting one changes the named slice)

- A1 A class's subject list is the same for all its sections (slice 29).
- A2 One exam per class-subject per section per term; a practical or oral is a test of type
  `other` (slice 30).
- A3 A test belongs to the term whose dates contain `held_on`, fixed at creation; a test dated
  outside every term is refused; moving a term's dates past an assessment is refused (slice 30).
- A4 A sheet is per section; a class with no section cannot exist (Phase 1) (slice 31).
- A5 Position is within the section (item 36) (slice 31).
- A6 The final result composes each subject over the terms in which the student was assessed in
  it, weights renormalised; a term `not_held` for the class is skipped (slice 31).
- A7 Promotion needs the section's final sheet approved; a year with one held term promotes from
  that term's sheet (slice 35).
- A8 Readmission after a `completed` enrolment is the existing flow (Phase 3 R239); promotion never
  readmits (slice 35).
- A9 A `left` enrolment is omitted from a sheet; a student who left mid-term has no result; a
  student who changed section mid-term appears on the new section's sheet with all their marks
  (§0.25) (slice 31).
- A10 Certificates are issued to students of any status; the leaving certificate alone needs
  `withdrawn | transferred | alumni` (slice 34).
- A11 The academic certificate prints the published final result of the named year, else the last
  published term (slice 34).
- A12 Exam fees stay Phase 3 campaigns; nothing in Phase 4 reads a charge except the dues endpoint
  (slices 32, 34).
- A13 No PDF; print views are the Phase 3 scriptless HTML; the app renders cards natively and
  shares them as an image of the view (slice 32).
- A14 A mid-term **class** change (R39) does not carry marks: the new class's subjects start from
  the join; the old class's marks stay as history (slice 31).
- A15 Two pending corrections for one student approved separately send two `result_revised`
  messages (slice 32).

---

## 2. Shape of the system after Phase 4

```
apps/api/src/modules/
  academics/                 + terms, result-settings (with bands), class-subjects, not-held  (29)
  assessments/               NEW  assessments, marks, corrections                              (30, 32)
  results/                   NEW  sheets, composition, publication, cards, reports             (31, 32, 33)
  certificates/              NEW                                                               (34)
  promotion/                 NEW  sheets, decisions, apply, year-close guard                   (35)
  approvals/                 + results section
  me/                        + /me/children/:id/results…, /me/student/results…               (33)
apps/api/src/tenancy/scope.mint.ts   + MarksScope (the only mint)
apps/api/src/repositories/   + academic-term, result-settings, class-subject, assessment, mark,
                               result-sheet, result, certificate, promotion repositories
apps/api/src/jobs/           + result-notify (fan-out after publish, like announcement-send)
packages/shared/src/results/ NEW  compose.ts (pure), grades.ts, position.ts, final.ts, pass.ts
apps/web/app/(school)/
  academics/terms, academics/results-settings, classes/[id]/subjects, exams/   (29)
  marks/  (grid per assessment)                                                 (30)
  results/sheets, results/sheets/[id], approvals (+ results)                    (31)
  results/print, results/corrections                                             (32)
  reports/results/*, my-children/[id]/results, my-results                        (33)
  certificates/, certificates/[id]                                                (34)
  promotion/, promotion/[id], academic-years (+ close guard)                      (35)
apps/mobile/src/
  assessments/  (teacher: tests, marks grid, offline)                            (30)
  results/      (class teacher: sheet, remark, submit; principal: approve)       (31)
  approvals/    (+ results section)                                              (31)
  family/, student/ (+ Results: terms, tests, native card)                       (32, 33)
```

Boundary: `assessments` writes marks; `results` reads marks (through `MarkReadsRepository`,
read-only) and writes sheets and results; `promotion` reads results and writes enrolments only
through `EnrolmentsService` and statuses only through `StudentStatusService.promote`;
`certificates` reads results and the dues endpoint. Lint confines each repository to its module
(§5.1).

---

## 3. Cross-cutting conventions new in Phase 4

### 3.1 Which existing key covers what

| Capability | Routes | Default holders |
|---|---|---|
| `assessment.define` | terms, result settings and bands, not-held, exam set-up, `PATCH`/void of any assessment, submit when no class teacher, promotion sheets and apply, year close with sheets | principal |
| `class.manage` | class-subject list, `next_class_id`, `is_final` | principal (Phase 1 role defaults; office by grant — corrected in wave M) |
| `marks.enter` (`MarksScope`) | create a test, enter marks, request a correction; class teacher: remarks and submit | teacher (assignment scope); office by grant (`all`) |
| `marks.view_all` | read every assessment, mark, sheet and result; the result reports; prints | principal; office by grant |
| `result.approve` | approve or return a sheet, approve the final sheet, excuse, decide corrections | principal |
| `result.publish` | publish an approved sheet (automatic when the approver holds it) | principal |
| `certificate.issue` | issue, reissue, print, the register | principal, office |
| `student.status.change` | the `not_continuing` outcome (re-checked at apply) | principal, office |
| guardian / student capacity | `/me/children/:id/results…`, `/me/student/results…` | parent, student |

Every result route answers `404` for a section, assessment or student outside the caller's scope.

### 3.2 Invariants, in the database

Every Phase 4 tenant table: `school_id NOT NULL`, a plain unique `(school_id, id)`, composite
foreign keys to the enrolment hub, `<table>_no_delete`, `<table>_no_truncate`,
`<table>_school_id_immutable`, an index per foreign key (leading with its columns) and per list
predicate, and an `EXPECTED_OBJECTS` entry per hand-written object; nothing needs a new
`NON_FK_ID_COLUMNS` or `NON_SCHOOL_LEADING_INDEXES` entry.

- **Marks.** Two partial uniques: `marks_live_key (school_id, assessment_id, enrolment_id) WHERE
  status = 'live'` and `marks_pending_key … WHERE status = 'pending'`; `(school_id,
  assessment_id, enrolment_id, client_entry_key)` unique. `max_marks` is denormalised onto the
  mark with FK `(school_id, assessment_id, max_marks) → assessments (school_id, id, max_marks)`
  `ON UPDATE RESTRICT`, so `CHECK (obtained IS NULL OR obtained BETWEEN 0 AND max_marks)` needs
  no trigger and an assessment's max freezes once a mark exists; `(school_id, assessment_id,
  academic_year_id) → assessments` beside the four-column enrolment FK. CHECKs: `(obtained IS
  NULL) = absent`; `NOT excused OR absent`; `(supersedes_id IS NULL) = (correction_reason IS
  NULL)`; `(status = 'superseded') = (superseded_at IS NOT NULL)`; `status = 'pending' OR
  decided_at IS NULL OR status IN ('live','rejected','superseded')`. Frozen after insert except
  `status`, `superseded_at`, `decided_by/at`. An excusal is a superseding row (`absent`,
  `excused`, `entered_by` = the approver, with a reason), never an update.
- **Assessments.** `section_id NOT NULL` (an exam is one row per section);
  `assessments_exam_key (school_id, section_id, class_subject_id, term_id) WHERE kind = 'exam'
  AND voided_at IS NULL`; `held_on` inside the term (trigger joining `academic_terms`);
  `locked_at` set once (tests); an exam is "locked" when its section-term sheet is `submitted` or
  later (one predicate, trigger and service); a locked assessment takes no `live` mark, only
  `pending` corrections; `name`, `held_on`, `max_marks` editable until a mark exists.
- **Result sheets.** `result_sheets_version_key (school_id, section_id, COALESCE(term_id, 0),
  version)` and `result_sheets_open_key (school_id, section_id, COALESCE(term_id, 0)) WHERE
  status <> 'published'`; `CHECK ((version = 1) = (supersedes_id IS NULL))`;
  `asms_status_transition('draft:submitted','submitted:approved','submitted:returned',
  'returned:submitted','approved:returned','approved:published')` BEFORE UPDATE only (a version
  from a correction is inserted `published`); `CHECK ((status IN ('approved','published',
  'returned')) = (decided_at IS NOT NULL))`; the approver trigger: `decided_by ≠ submitted_by`
  unless `asms_is_sole_principal(school_id, decided_by)` and `self_approved`; a final sheet
  (`term_id IS NULL`) has no submitter and is exempt. The settings snapshot lives on the sheet:
  `test_weight`, `exam_weight`, `pass_percent`, `pass_rule`, `bands jsonb`, `term_weights jsonb`
  (final), frozen once `approved`.
- **Result sheet remarks.** `(school_id, sheet_id, enrolment_id)` unique; `remark` with the
  no-identity CHECK; writable only while the sheet is `draft | returned` (trigger joining the
  sheet); approval copies the text into `results.remark`.
- **Results.** Full row set per sheet version; unique `(school_id, sheet_id, enrolment_id)`; live
  per enrolment-term: `(school_id, enrolment_id, COALESCE(term_id, 0)) WHERE superseded_at IS
  NULL`; `(school_id, sheet_id, term_id) → result_sheets (school_id, id, term_id)`; frozen after
  insert except `superseded_at`, `superseded_by`, `published_at`; `revised boolean` (figures
  changed from the superseded row); `own_child_flags jsonb` (array of `{ userId, role }`);
  CHECKs `percent_bp` 0–10000 or null, `(position IS NULL) = (position_of IS NULL)`, `position ≤
  position_of`, `passed IS NULL` iff nothing assessed. `result_subjects` carries
  `class_subject_id` with FK `(school_id, class_subject_id, class_id)` **and** snapshots
  `subject_name`, `sort_order`; `test_bp`, `exam_bp`, `percent_bp` 0–10000 or null;
  `(exam_obtained IS NULL) = exam_absent`; `status = 'not_assessed'` iff `percent_bp IS NULL`;
  `obtained ≤ max`, `max ≥ 1`.
- **Settings.** `result_settings` one row per year: `CHECK (test_weight + exam_weight = 100)`,
  `pass_percent` 0–100, `bands jsonb` (`jsonb_typeof = 'array'`, shape by zod: descending
  `minPercent`, one at 0, unique grades). Trigger `result_settings_locked`: no change for a year
  with any sheet `approved` or `published`; the same lock on `academic_terms` dates and weight
  (`TERM_IN_USE` also once any assessment of the term exists). Term weights summing to 100 is a
  service check.
- **Terms.** `EXCLUDE USING gist (school_id WITH =, academic_year_id WITH =,
  daterange(starts_on, ends_on, '[]') WITH &&)` (btree_gist exists); `ends_on ≥ starts_on`;
  unique `(school_id, academic_year_id, lower(name))` and `sort_order`; inside the year by
  trigger; `created_by` nullable (seeded rows). `term_skips (school_id, term_id, class_id)`
  unique, with the no-delete pair (an `ended_at` to lift it).
- **Classes.** `next_class_id` FK `(school_id, next_class_id) → classes (school_id, id)` with
  index; `is_final boolean NOT NULL DEFAULT false`; `CHECK (NOT (is_final AND next_class_id IS
  NOT NULL))`; the target year of the next class is checked when a promotion sheet opens.
- **Class subjects.** unique live `(class_id, subject_id)`; `(school_id, id, class_id)` unique as
  an FK target; the list is frozen while any sheet of the class is `submitted` or `approved`;
  archiving one with marks or published results is `CLASS_SUBJECT_IN_USE`.
- **Certificates.** `(school_id, type, number, issue_no)` unique; reissue FK `(school_id,
  reissue_of_id, type, number) → certificates (school_id, id, type, number)`; `CHECK ((issue_no
  > 1) = (reissue_of_id IS NOT NULL))`; the void trio set together; `body jsonb` with `CHECK
  (body::text !~ '[0-9]{13}' AND body::text !~ '[0-9]{5}-[0-9]{7}-[0-9]')`; mutable after insert:
  `printed_count` and the void trio only; no `label` column (derived); `academic_year_id`
  nullable for `other`.
- **Promotion.** `promotion_sheets_open_key (school_id, section_id) WHERE status = 'open'`;
  `(school_id, id, target_year_id)` unique as an FK target. `promotion_decisions`: FKs
  `(school_id, sheet_id, target_year_id)`, `(school_id, target_class_id, target_year_id) →
  classes (school_id, id, academic_year_id)`, `(school_id, target_section_id, target_class_id) →
  sections`, `(school_id, new_enrolment_id, student_id) → enrolments`, `(school_id, result_id,
  enrolment_id) → results (school_id, id, enrolment_id)`; CHECKs `(decision IN
  ('promote','detain')) = (target_class_id IS NOT NULL)` once decided, `decision = proposed OR
  reason IS NOT NULL`, `applied_at IS NULL OR decision NOT IN ('promote','detain') OR
  new_enrolment_id IS NOT NULL`; frozen once `applied_at` is set; `revised_after_apply boolean`.
- **Enrolments and students.** `enrolments_status_transition` with
  `asms_status_transition('active:completed','active:left')`; apply updates the old row before
  inserting the new one (the one-active-per-student partial unique is checked per statement).
  `STUDENT_STATUS_TRANSITIONS` is unchanged (the status route still refuses `alumni`);
  `StudentStatusService.promote` alone writes `active → alumni`, with `source: promotion` in the
  status-change row's metadata.

### 3.3 Pure functions (`packages/shared/src/results/`)

- `composeSubject({ tests: [{ obtained, max, absent, excused, applicable }], exam: { obtained,
  max, absent, excused } | null, weights })` → `{ testBp | null, examBp | null, percentBp |
  null, obtained | null, max, status: 'assessed' | 'not_assessed' }` (obtained = round(percentBp
  × max ÷ 10000)).
- `gradeFor(percentBp, bands)` → label; bands `[{ grade, minPercent }]` descending.
- `composeResult({ subjects, bands, passRule, passPercent })` → `totalObtained`, `totalMax`,
  `percentBp` (from the printed marks, §0.26), `grade`, `passed | null`, `failedSubjects`.
- `positions(rows)` → standard competition ranking by `percentBp`, ties shared, `positionOf`.
- `composeFinal({ terms: [{ weight, held, subjects }] })` → the same shape as a term result,
  per subject over the terms in which the student was assessed, weights renormalised.
- Table-tested with the worked examples of §8 (R258–R264); `results.service` has an e2e test
  that the stored rows equal the functions' output for every student of the scripted section.

### 3.4 Results, cards and print views

`GET /results/:id` returns `ResultDto`, the stored row with its subjects — that **is** the report
card; `GET /results/:id/print` renders it through `sendPrintView` (R237); `GET
/result-sheets/:id/print` renders every live card of a sheet, one per page. The app renders
`ResultDto` natively (`ReportCardView`) and shares it as an image of the view. One layout;
toggles from `result_settings`: `show_position`, `show_attendance`, `show_remark`. The card
prints the school name, the student's name, admission number, class, section and roll number, the
term, the per-subject table, totals, percentage, grade, position (`n / m`), attendance `%`, the
remark, "Class teacher" and "Principal" signature lines, "Revised" with the date on a revised row
and "Superseded" on a superseded one.

### 3.5 Message types

`result_published` (guardian + student; title "Term result published"; body "<School>: <Child>'s
<Term> result is published: <percent> %, grade <G>. See the app or collect the report card."),
`result_revised` (the same with "revised"), `test_marked` (in-app and push; "<Child>: <Test>
marked"). All three push bodies are title-only (`TITLE_ONLY_PUSH`); a `push-results.spec.ts`
guardrail renders each with figures and asserts the push body carries none. SMS allow-list
defaults: `result_published` and `result_revised` yes (migration backfill), `test_marked` never.
Messages carry name, term, percentage and grade only — no marks table, position or remark.

### 3.6 Jobs

`result-notify` (queue `messaging`, payload `{ sheetId }` or `{ resultId }` through
`fromQueuePayload`): enqueued after commit through `OutboxDispatcher`; its first statement is a
scoped claim (R105) re-checking `published_at IS NOT NULL AND superseded_at IS NULL`; one message
per family and student under the 120 s job limit, as `announcement-send` does.

### 3.7 Settings

`result_settings` per academic year (created with the year by `asms_seed_year_results`, which
also seeds the two terms; the migration calls it for every existing year): `test_weight`,
`exam_weight`, `pass_percent`, `pass_rule`, `bands`, `show_position`, `show_attendance`,
`show_remark`, `withhold_card_for_dues`, `notify_class_tests`. School settings gain
`certificate_signatory_name` and `certificate_show_identity_no` (additive `PATCH /school/settings`).

### 3.8 Mobile

Two new outbox lanes, in `lanes.ts`:
- `assessment_create` → `POST /assessments`, `idempotencyHeader: true` (like `diary_entry`).
- `marks_enter` → `POST /assessments/:id/submit-marks`, `idempotencyHeader: false`,
  `coalesces: true`, `domainTable: 'local_marks'`; the item depends on the test's server id (the
  `diary_attachment` re-target pattern); remedies `changed_elsewhere → reload`,
  `MARK_EXCEEDS_MAX → edit_resend`, `ASSESSMENT_LOCKED → discard`.
Each entry carries `clientEntryKey` (`^[A-Za-z0-9_-]{16,64}$`, no 13-digit run) and
`basedOnMarkId` (the live mark the phone saw, or null); the server answers per row (§5, slice 30).
Everything else is online-only (§0.30). Secure screens: the marks grid, the sheet, the card.
Teachers' tabs gain **Marks**; the class teacher's sheet lives under Marks; the principal's
Approvals gains **Results**; the parent's child screen and the student's home gain **Results**.

---

## 4. Schema, complete for Phase 4 — the schema-freeze checklist

The conventions and invariants of §3.2 apply to every table below. **Migration order:** (1)
`_phase4_message_types` widens `message_type` alone; (2) `_phase4_groundwork` adds the new enums,
the settings and terms tables with `asms_seed_year_results` and its backfill, `classes` and
`school_settings` columns, the `sms_allowed_types` default and backfill; (3) one migration per
wave for its tables and triggers. `SchoolCounterName` is a TS type; `school_counters_name_check`
already admits `cert_*`.

**Slice 29 — set-up:** `academic_terms` (`academic_year_id`, `name` ≤ 40, `sort_order`,
`starts_on`, `ends_on`, `weight` 0–100, `created_by` nullable), with unique `(school_id, id,
academic_year_id)` · `term_skips` (`term_id`, `class_id`, `reason`, `created_by`, `ended_at/by`) ·
`result_settings` (§3.7, one per year) · `class_subjects` (`class_id` composite to class+year,
`subject_id`, `sort_order`, `exam_max_marks` 1–1000 default 100, `archived_at/by`) ·
`classes.next_class_id`, `classes.is_final`.

**Slice 30 — assessments and marks:** `assessments` (`academic_year_id`, `term_id`, `class_id`,
`section_id`, `class_subject_id`, `kind`, `test_type` nullable, `name` ≤ 80, `max_marks` 1–1000,
`held_on`, `created_by`, `locked_at`, `voided_at/by/reason`) with uniques `(school_id, id,
academic_year_id)` and `(school_id, id, max_marks)` · `marks` (`assessment_id`, `enrolment_id`,
`student_id`, `academic_year_id`, `max_marks`, `obtained` nullable, `absent`, `excused`,
`status`, `supersedes_id`, `correction_reason`, `entered_by`, `entered_at`, `client_entry_key`,
`decided_by/at`, `superseded_at`) with unique `(school_id, id, assessment_id, enrolment_id)`.
Indexes: `marks (school_id, assessment_id) WHERE status = 'live'`, `(school_id, student_id,
academic_year_id)`; `assessments (school_id, section_id, term_id, kind)`, `(school_id, term_id,
class_subject_id)`.

**Slice 31 — sheets and results:** `result_sheets` (`academic_year_id`, `term_id` nullable,
`class_id`, `section_id`, `version`, `status`, `submitted_by/at`, `submitted_under_assignment_id`
nullable, `decided_by/at`, `self_approved`, `return_reason`, `published_by/at`,
`supersedes_id`, the settings snapshot columns) with unique `(school_id, id, term_id)` ·
`result_sheet_remarks` · `results` (`sheet_id`, `enrolment_id`, `student_id`,
`academic_year_id`, `term_id`, `total_obtained`, `total_max`, `percent_bp`, `grade`, `passed`
nullable, `failed_subjects`, `position`, `position_of`, `attendance_bp`, `remark`,
`own_child_flags`, `revised`, `published_at`, `superseded_at`, `superseded_by`, `supersedes_id`)
with unique `(school_id, id, enrolment_id)` · `result_subjects` (`result_id`,
`class_subject_id`, `subject_name`, `sort_order`, `test_bp`, `exam_bp`, `exam_obtained`,
`exam_max`, `exam_absent`, `exam_excused`, `percent_bp`, `obtained`, `max`, `grade`, `status`,
`own_child_of` nullable FK to users). Indexes: `result_sheets (school_id, status,
submitted_at)`, `(school_id, academic_year_id, section_id)`; `results (school_id, sheet_id)`,
`(school_id, student_id, published_at)`, `(school_id, enrolment_id, published_at)`, `(school_id,
term_id) WHERE superseded_at IS NULL`; `result_subjects (school_id, class_subject_id,
result_id)`.

**Slice 34 — certificates:** `certificates` (`student_id`, `type`, `number`, `issue_no`,
`reissue_of_id`, `academic_year_id` nullable, `title` ≤ 80, `body jsonb`, `reason`,
`dues_status`, `issued_by`, `issued_on`, `printed_count`, `voided_at/by`, `void_reason`) with
unique `(school_id, id, type, number)`; indexes `(school_id, student_id)`, `(school_id, type,
issued_on)`, `(school_id, issued_on)`.

**Slice 35 — promotion:** `promotion_sheets` (`academic_year_id`, `class_id`, `section_id`,
`target_year_id`, `status`, `opened_by/at`, `applied_by/at`) · `promotion_decisions` (`sheet_id`,
`target_year_id`, `enrolment_id`, `student_id`, `result_id` nullable, `proposed` nullable,
`decision` nullable, `reason`, `target_class_id`, `target_section_id`, `new_enrolment_id`,
`arrears_flag`, `decided_by/at`, `applied_at`, `revised_after_apply`); index `(school_id,
sheet_id)`.

**Not in Phase 4:** no timetable, no events, no `report_cards` table, no certificate templates
table, no import of past results, no grade-point averages, no grace marks (item 35). **Existing
data touched:** `classes` gains two columns; `school_settings` gains two columns and the
`sms_allowed_types` backfill; existing years get seeded terms and settings; `message_type` is
widened; no existing row is rewritten.

---

## 5. Slice plan

Estimates sum to 33 days. **Waves**: **M** = groundwork + 29 · **N** = 30 + 34 in parallel ·
**O** = 31 · **P** = 32 + 33 + 35 in parallel · **Q** = 36. The groundwork commit before wave M
adds to `packages/shared` the enums, error codes, message types, the results functions (§3.3) and
`IDEMPOTENT_ENDPOINTS`, the migrations (1) and (2) of §4, the lint boundaries and `MarksScope`.
Agents own disjoint files; migrations, `app.module.ts`, `eslint.config.mjs`, `packages/shared`,
`scope.mint.ts` and `lanes.ts` are edited by the main thread. Phase 3's conventions (pagination
on every list with a stated default sort, errors, `Idempotency-Key` on creates, `@Reason()` 3–500,
throttles) are not restated; the per-slice contracts in `contracts/slice-29.md` … supersede the
DTO shapes below where they differ. Every `/me/*` read sits under `MeReadsThrottleGuard`; staff
print routes under a new `print` bucket (20/min, 200/h per user); the reports under
`result-reports` (30/min, 300/h).

### 5.1 Groundwork: shared enums, codes, helpers, lint

Enums: `AssessmentKind`, `TestType`, `AssessmentMarkStatus`, `MarkEntryOutcome`,
`ResultSheetStatus`, `ResultSubjectStatus`, `PassRule`, `CertificateType`, `DuesStatus`,
`PromotionOutcome`, `PromotionSheetStatus`; `SchoolCounterName` widened; `IDEMPOTENT_ENDPOINTS`
+ `assessments | certificates | promotion_sheets` (the marks grid uses per-row keys, not the
header). OpenAPI names must not collide with attendance's `MarkOutcome`, `SubmittedMarkDto`,
`AmendMarkDto`: every Phase 4 marks type is prefixed `Assessment…` or `MarkEntry…`.

Error codes (all `409` unless stated; each with the `// 409, details.x` comment style):

| Code | Details | Raised by |
|---|---|---|
| `TERM_OVERLAPS`, `TERM_OUTSIDE_YEAR`, `TERM_IN_USE` | `termId` | terms |
| `RESULT_SETTINGS_LOCKED` | `academicYearId` | settings after an approved sheet |
| `CLASS_SUBJECT_IN_USE`, `CLASS_SUBJECTS_FROZEN` | `classSubjectId` / `classId` | class-subject list |
| `EXAM_NOT_SET_UP` | `classSubjectId, sectionId, termId` | submit |
| `ASSESSMENT_LOCKED`, `ASSESSMENT_OUTSIDE_TERM`, `ASSESSMENT_VOIDED`, `ASSESSMENT_HAS_MARKS` | `assessmentId` | marks, tests, `PATCH`/void |
| `MARK_EXCEEDS_MAX` | `enrolmentId, max` | submit-marks (whole request) |
| `MARKS_INCOMPLETE` | `missing: [{ enrolmentId, assessmentId }]` (≤ 100) | sheet submit |
| `RESULT_SHEET_NOT_DRAFT`, `RESULT_SHEET_NOT_SUBMITTED`, `RESULT_SHEET_NOT_APPROVED`, `RESULT_SHEET_PUBLISHED`, `RESULT_SHEET_VERSION_OPEN`, `RESULT_SHEET_TERMS_UNPUBLISHED { missingTermIds }` | `sheetId` | sheet verbs |
| `MARK_CORRECTION_NOT_PENDING`, `MARK_CORRECTION_SHEET_NOT_PUBLISHED` | `markId` | corrections |
| `CERTIFICATE_DUES_BLOCK` | `outstanding` | leaving certificate |
| `CERTIFICATE_STUDENT_NOT_LEFT`, `CERTIFICATE_VOIDED`, `CERTIFICATE_NO_RESULT` | `certificateId` | certificates |
| `PROMOTION_FINAL_NOT_APPROVED`, `PROMOTION_SHEET_OPEN`, `PROMOTION_SHEET_NOT_OPEN`, `PROMOTION_INCOMPLETE { enrolmentIds \| sections }`, `PROMOTION_RESULT_SUPERSEDED { enrolmentIds }`, `PROMOTION_TARGET_INVALID { reason: other_year \| archived \| no_target }` | ids | promotion; year close |
| reused: `SELF_ACTION_FORBIDDEN { reason: submitter \| author \| own_child }`, `ILLEGAL_STATUS_TRANSITION`, `CONCURRENT_UPDATE`, `REFERENCE_NOT_FOUND` (`422`), `ACADEMIC_YEAR_CLOSED`, `STUDENT_NOT_ACTIVE`, `PERMISSION_DENIED { reason }` | | |

Lint: `src/modules/assessments/**` alone imports the assessment and mark repositories;
`src/modules/results/**` alone imports the sheet, remark and result repositories, plus
`MarkReadsRepository` (read-only); `src/modules/certificates/**` and `src/modules/promotion/**`
alone import theirs; `promotion` writes enrolments only through `EnrolmentsService` and statuses
only through `StudentStatusService.promote`; `certificates` and `results` read dues only through
`FinanceReportsService.clearance`; `MarksScope` is minted only in `scope.mint.ts`. Fixture tests
plant each forbidden import.

### Slice 29 — Terms, result settings, class subjects, exam set-up (≈ 3 days)

**Goal:** a year carries its terms, weights, pass rule and bands; a class carries its subjects;
the principal sets up a term's exams in one action.

| Method and path | Access | Request | Response | Errors / notes |
|---|---|---|---|---|
| `GET /academic-years/:id/terms` | staff | page, sort `sortOrder` | page of `TermDto` | |
| `POST /academic-years/:id/terms` | `assessment.define` | `{ name, startsOn, endsOn, weight? }` | `201 TermDto` | `TERM_OVERLAPS`, `TERM_OUTSIDE_YEAR`, `ACADEMIC_YEAR_CLOSED` |
| `PATCH /terms/:id` | `assessment.define` | name, dates, weight | `TermDto` | `TERM_IN_USE` |
| `POST /terms/:id/skip-class`, `/unskip-class` | `assessment.define` | `{ classId, reason }` | `TermDto` | not held for that class |
| `GET\|PATCH /academic-years/:id/result-settings` | `assessment.define` (GET: staff) | §3.7 fields incl. `bands?` | `ResultSettingsDto { …, bands }` | `RESULT_SETTINGS_LOCKED` |
| `GET /classes/:id/subjects` | staff | page, sort `sortOrder` | page of `ClassSubjectDto` | |
| `PATCH /classes/:id` | `class.manage` | `+ subjects?: [{ subjectId, sortOrder, examMaxMarks }], nextClassId?, isFinal?, reason?` | existing | omitted subjects are archived (reason required); `CLASS_SUBJECT_IN_USE`, `CLASS_SUBJECTS_FROZEN` |
| `POST /terms/:id/set-up-exams` | `assessment.define` | `{ classIds? }` | `200 ExamSetUpResultDto { created, existing, skipped }` | one exam per class-subject per live section; idempotent by the unique; no key |

**Behaviour:** creating a year calls `asms_seed_year_results`. A term's `weight` defaults so the
held terms of a year sum to 100. **Screens (web):** Academics → Terms and results (terms, weights,
not-held per class, pass rule, bands, toggles), Classes → Subjects (ordered list with max marks,
next class, final), Exams (set up a term's exams, one button). **Tests:** R254–R257; isolation for
the five tables.

### Slice 30 — Assessments and marks, offline on the phone (≈ 6 days)

**Goal:** a teacher creates a class test and enters marks from the phone, offline; exam marks are
entered the same way; a mark is never edited.

| Method and path | Access | Request | Response | Errors / notes |
|---|---|---|---|---|
| `GET /assessments` | `marks.enter` (`MarksScope`) or `marks.view_all` | `termId?, classId?, sectionId?, classSubjectId?, kind?`; sort `-heldOn` | page of `AssessmentDto` | |
| `POST /assessments` | `marks.enter` (scope) + key | `{ classSubjectId, sectionId, testType, name, maxMarks, heldOn }` | `201 AssessmentDto` | tests only; `ASSESSMENT_OUTSIDE_TERM`, `RESULT_SHEET_NOT_DRAFT` when the section-term sheet is submitted or later |
| `PATCH /assessments/:id` | creator (scope) or `assessment.define` | `name?, heldOn?, maxMarks?` | `AssessmentDto` | `ASSESSMENT_HAS_MARKS` for `maxMarks`; `heldOn` stays inside the term |
| `GET /assessments/:id/marks` | scope / view_all | — | `AssessmentMarksDto { assessment, rows: [{ enrolmentId, student, markId, obtained, absent, excused, status, ownChildOf }] }` | the section's enrolments active on `held_on` (a mid-term joiner after `held_on` is absent from the list), intersected with the caller's scope |
| `POST /assessments/:id/submit-marks` | `marks.enter` (scope) | `SubmitMarksDto { entries: [{ enrolmentId, obtained \| absent, clientEntryKey, basedOnMarkId }] }` | `200 SubmitMarksResultDto { assessment, entries: [{ clientEntryKey, enrolmentId, markId, outcome: created \| superseded \| unchanged \| changed_elsewhere }] }` in request order; `Prefer: return=minimal` honoured | one transaction; a row supersedes only when the live mark id equals `basedOnMarkId`, else `changed_elsewhere` for that row and nothing written for it; `MARK_EXCEEDS_MAX`, `ASSESSMENT_LOCKED`, `ASSESSMENT_VOIDED` refuse the whole request; rows outside the scope are omitted with `404` semantics (nothing written) |
| `POST /assessments/:id/void` | creator (scope) or `assessment.define` | `{ reason }` | `AssessmentDto` | a test before its sheet is submitted; an exam before any sheet of that section-term is submitted (set-up recreates it) |
| `POST /marks/:id/excuse` | `result.approve` | `{ reason }` | `AssessmentMarkDto` | an absence only; writes a superseding excused row; `SELF_ACTION_FORBIDDEN { own_child }`; after publication it is a correction (slice 32) |

**Behaviour:** marks entry before submission needs no audit row — the `supersedes_id` chain with
`entered_by/at` is the history. `test_marked` goes out only with `notify_class_tests` on.
**Screens:** web marks grid (keyboard entry, absent toggle, save, per-row outcome banner); mobile
**Marks** tab: assignments → assessments → grid, "New test", offline banner, sync chip,
"changed elsewhere" reconciliation; secure. **Tests:** R258–R266; scope tests (a Maths teacher of
6-A reads neither 6-B nor 6-A English; the class teacher reads all of 6-A, writes only own
subject; cover inherits; office `all`); isolation; Maestro `teacher-marks-offline`.

### Slice 31 — Result sheets: compose, submit, approve, publish (≈ 6.5 days)

**Goal:** the class teacher submits the section's term sheet; the principal approves it from the
Approvals inbox; approval composes and stores every result and publishes it.

| Method and path | Access | Request | Response | Errors / notes |
|---|---|---|---|---|
| `POST /sections/:id/result-sheets` | class teacher (scope) / `assessment.define` | `{ termId: string \| null }` | `201 ResultSheetDto`; `200` the open version on repeat | `null` = the final sheet: `RESULT_SHEET_TERMS_UNPUBLISHED`; a term `not_held` for the class is refused |
| `GET /result-sheets` | class teacher (own section) / `marks.view_all` / `result.approve` | `termId?, classId?, sectionId?, status?`; sort `-updatedAt` | page of `ResultSheetDto` | real rows only |
| `GET /result-sheets/:id` | same | — | `ResultSheetDetailDto extends ResultSheetDto { preview: ResultPreviewRowDto[], flags }` | the preview is §3.3 over live marks; never stored |
| `PATCH /result-sheets/:id` | class teacher (scope) | `{ remarks: [{ enrolmentId, remark }] }` (given rows only) | detail | draft or returned only |
| `POST /result-sheets/:id/submit` | class teacher (scope) / `assessment.define` when no class teacher | `{}` | detail | `MARKS_INCOMPLETE`, `EXAM_NOT_SET_UP`; locks the section's tests of the term; records `submitted_under_assignment_id` (cover) |
| `POST /result-sheets/:id/return` | `result.approve` | `{ reason }` | detail | from `submitted` or `approved` (the latter supersedes that version's stored rows); `SELF_ACTION_FORBIDDEN` |
| `POST /result-sheets/:id/approve` | `result.approve` | `{}` | detail | composes and stores; publishes in the same transaction when the actor holds `result.publish`; the final sheet needs no submission |
| `POST /result-sheets/:id/publish` | `result.publish` | `{}` | detail | `RESULT_SHEET_NOT_APPROVED`; enqueues `result-notify` after commit |
| `GET /me/approvals` | existing | — | `+ results: { count, items: ResultSheetDto[] }` for `result.approve` holders | pending = `submitted`, with the own-child and cover flags |

**Behaviour:** approval is **exactly four reads** under the sheet's row lock — the section's
enrolments active on the term's last day; the live marks of every student on the sheet across
their enrolments in the class for the term's assessments (§0.25); one attendance aggregate over
the term's dates grouped by enrolment; the own-child set (distinct authors × the sheet's students
through live `student_guardians`) — then `composeResult` and `positions` in memory, the settings
snapshot onto the sheet, and batched inserts of `results` and `result_subjects`. The final sheet
composes from the published term results through `composeFinal` with the year's attendance; it
has no submitter and `result.approve` approves it directly. **Screens:** web Results → Sheets
(list, detail with preview, remarks, submit; approve/return), Approvals + Results; mobile: the
class teacher's sheet under Marks (remarks, submit; online); principal's Approvals + Results
(preview, approve, return). **Tests:** R267–R278; the scripted section (R296); Maestro
`principal-approve-result`.

### Slice 32 — Report cards, withholding, corrections (≈ 4 days)

**Goal:** the published result is a report card in the app and on paper; a corrected mark becomes
a revised result that reissues the card.

| Method and path | Access | Request | Response | Errors / notes |
|---|---|---|---|---|
| `GET /results/:id` | `marks.view_all` | — | `ResultDto` | published or superseded; a staff read is never withheld |
| `GET /results/:id/print` | `marks.view_all` | — | HTML | audited `result.printed` |
| `GET /result-sheets/:id/print` | `marks.view_all` | — | HTML, one card per page | audited `result_sheet.printed` |
| `POST /marks/:id/correct` | `marks.enter` (scope) + key | `{ obtained \| absent, reason }` | `201 AssessmentMarkDto (pending)` | locked assessment of a published sheet only: `MARK_CORRECTION_SHEET_NOT_PUBLISHED` otherwise |
| `GET /mark-corrections`, `GET /mark-corrections/:id` | `result.approve` / `marks.view_all` | `status?, sectionId?, termId?`; sort `-createdAt` | page / `AssessmentMarkDto` | |
| `POST /mark-corrections/:id/approve` | `result.approve` | `{}` | `MarkCorrectionDecisionDto { mark, revisedResult }` | `SELF_ACTION_FORBIDDEN { author \| own_child }`; re-composes the term sheet and the published final sheet as new versions |
| `POST /mark-corrections/:id/reject` | `result.approve` | `{ reason }` | `AssessmentMarkDto` | |

**Behaviour:** `approve` supersedes the old mark, inserts sheet version n+1 as `published` with
the full row set (`revised` on changed rows), does the same for a published final sheet, and
enqueues `result-notify { resultId }` for the corrected student alone. Withholding is a read-time
rule on the family routes (slice 33) through `FinanceReportsService.clearance`; a later payment
unlocks the card with no write. **Screens:** web Results → Print (section, single, withheld
list), Corrections (pending, approve, reject); mobile `ReportCardView` (native, share as image).
**Tests:** R279–R284; Playwright print and withheld; mobile snapshot.

### Slice 33 — Family and student views, result reports (≈ 3 days)

| Method and path | Access | Request | Response | Errors / notes |
|---|---|---|---|---|
| `GET /me/children/:id/results` | guardian | `academicYearId?` | `MyChildResultsDto { terms: MyResultSummaryDto[], final, withheld, outstanding }` | published, live rows only |
| `GET /me/children/:id/results/:resultId` | guardian | — | `MyResultDto { withheld, outstanding, result: ResultDto \| null }` | `200` either way; `404` unless the result belongs to that child |
| `GET /me/children/:id/assessments` | guardian | `termId?`; sort `-heldOn` | page of `MyAssessmentMarkDto` | tests only, live marks, non-voided |
| `GET /me/student/results`, `…/results/:resultId`, `…/assessments` | student | the same | the same, `outstanding` always null | the student from the session |
| `GET /students/:id/results` | `marks.view_all` or `student.view` (scoped) | sort `-publishedAt` | page of `ResultDto` | every published result across years |
| `GET /result-reports/section-summary` | `marks.view_all` | `sheetId` | `SectionSummaryReportDto` | pass/fail counts, averages per subject, grade distribution |
| `GET /result-reports/subject` | `marks.view_all` | `termId, classSubjectId` | `SubjectReportDto` | per section averages, top and bottom |

**Screens:** web My children → Results, My results (student), Reports → Results; mobile Results
for parent and student (native card, share). **Tests:** R285–R288; R78; isolation; Maestro
`parent-report-card`.

### Slice 34 — Certificates (≈ 4 days)

| Method and path | Access | Request | Response | Errors / notes |
|---|---|---|---|---|
| `GET /certificates` | `certificate.issue` | `type?, studentId?, issuedFrom?, issuedTo?, voided?`; sort `-issuedOn` | page of `CertificateDto` | the register, with bodies |
| `POST /students/:id/certificates` | `certificate.issue` + key | `{ type, academicYearId?, title?, conduct?, remarks? }` | `201 CertificateDto` | leaving: `CERTIFICATE_STUDENT_NOT_LEFT`, `CERTIFICATE_DUES_BLOCK { outstanding }` unless cleared or overridden (`dues_status` records which); academic/completion: `CERTIFICATE_NO_RESULT` |
| `GET /certificates/:id` | `certificate.issue` | — | `CertificateDto` | the body never holds an identity number |
| `GET /certificates/:id/print` | `certificate.issue` | — | HTML | the only place the B-Form prints (§7.1); audited `certificate.printed { identityPrinted }`; `printed_count` +1 |
| `POST /certificates/:id/reissue` | `certificate.issue` + key (`certificates` endpoint, path id the original) | `{ reason }` | `201 CertificateDto` (same number, `issueNo + 1`, prints DUPLICATE) | `CERTIFICATE_VOIDED` |
| `POST /certificates/:id/void` | `certificate.issue` + `requirePrincipal` | `{ reason }` | `CertificateDto` | the number is never reused |
| `GET /students/:id/certificates` | `certificate.issue` or `student.view` (scoped) | sort `-issuedOn` | page of `CertificateSummaryDto` (no body) | |

**Behaviour:** the body is built by one typed builder (names, father's name, admission number,
class and section of the named year or the last enrolment, dates of attendance from the
enrolments, the conduct line, the marks table of the published result); every string passes
`containsIdentityNumber`; a reissue copies the original's body. The counter is `school_counters`
under the issuing transaction, gapless in commit order (two concurrent issues tested).
**Screens:** web Certificates (register, issue dialog per type, print, reissue, void), the
student page's Certificates panel beside the dues panel. **Tests:** R289–R293; isolation.

### Slice 35 — Promotion and year end (≈ 5 days)

| Method and path | Access | Request | Response | Errors / notes |
|---|---|---|---|---|
| `POST /sections/:id/promotion-sheets` | `assessment.define` + key | `{ targetYearId }` | `201 PromotionSheetDto` | `PROMOTION_FINAL_NOT_APPROVED`, `PROMOTION_SHEET_OPEN`; the target year `planned \| active`; proposals per §1.1; arrears from the dues endpoint |
| `GET /promotion-sheets`, `GET /promotion-sheets/:id` | `assessment.define` | `academicYearId?, status?`; sort `-openedAt` | page / `PromotionSheetDetailDto` | |
| `PATCH /promotion-sheets/:id` | `assessment.define` | `{ decisions: [{ enrolmentId, decision, reason?, targetClassId?, targetSectionId? }] }` (given rows) | detail | `reason` required when `decision ≠ proposed` or `proposed` is null; `not_continuing` needs `student.status.change` and refuses a suspended student (`STUDENT_NOT_ACTIVE`) |
| `POST /promotion-sheets/:id/apply` | `assessment.define` + key | `{}` | detail (`applied`) | row lock first; `PROMOTION_SHEET_NOT_OPEN`, `PROMOTION_INCOMPLETE { enrolmentIds }` (undecided rows), `PROMOTION_RESULT_SUPERSEDED`, `PROMOTION_TARGET_INVALID`; `student.status.change` re-checked for `not_continuing` |
| `POST /academic-years/:id/close` | existing | existing | existing | `+ PROMOTION_INCOMPLETE { sections }` before R44; a section with no enrolment in force on the year's last day needs no sheet |

**Behaviour:** `apply`, one transaction per sheet: for each row — `not_continuing` first runs the
existing withdrawal with `effectiveOn = min(today, year end)` (enrolment `left`); `promote` and
`detain` update the enrolment to `completed` on the year's end, then insert the new enrolment
(`started_on` = the target year's start, `roll_no` null); `complete` closes as `completed` and
calls `StudentStatusService.promote` (alumni); an enrolment no longer active is skipped with a
reason. **Screens:** web Promotion (sections, sheet with proposals, overrides with reasons,
arrears flags, apply; a hint when the target year has no classes), Academic years (close shows
the sections still open). **Tests:** R294–R299; isolation; the year-end script (R300).

### Slice 36 — Phase close (≈ 1.5 days)

- `security-reviewer` on the whole phase (§7.1); `performance-engineer` on approval, the section
  print, the reports and promotion at 3,000 students × 12 subjects × 2 terms; `business-rules` on
  the scripted section and year (R296, R300); `code-quality` on the marks grid, the native card
  and the lanes; `docs-maintainer` sweep; CLAUDE.md gains anything built differently from rules
  26–31 (the sole-principal exception of §1.1 is recorded under rule 27); R16 scans over remarks,
  certificate bodies and the three message types; R57 and R68 tables extended with the audit
  actions of §7.1.
- `phase-gate`; `WORKLOG.md` says what Phase 5 inherits and what was deferred (the real-driver
  proof stays owner-blocked).

---

## 6. Open items Phase 4 must not pre-empt

| Item | Phase 4 stance |
|---|---|
| Period timetable (rule 31) | Not built; `class_subjects` is where it attaches; R120/R129 unchanged |
| Events and PTM (rule 31) | Not built |
| Past results import | Not built |
| 26 remark visibility | Phase 2 default stands; the term remark is on the card by rule 28 |
| 31 rule 24's reach | Untouched (note: `certificate.issue` under a default password can print a B-Form — part of that question) |
| 34 repeat-year fees, 35 grace marks, 36 class-wide position | Not built; shapes named in §1.2 |
| Merit lists across sections, GPA | Not built; the subject report gives top and bottom per section |
| Audit-log screen | Still a decision; still needs a 52nd capability |
| Guardian merge | Unchanged |

---

## 7. Security-sensitive points and performance budgets

### 7.1 Security (the whole-phase review checks each)

- **Scope carries the subject** (§0.27): `MarksScope` is minted only in `scope.mint.ts` from
  `teacher_assignments` at the assessment's date; every assessment and mark repository method
  takes it; the repository predicate, not the service, applies it; `GET …/marks` and
  `submit-marks` intersect the section's enrolments with the scope and never write outside it.
  R263's test includes "same section, other subject → 404".
- **Families:** `/me/children/:id/…` resolves the child through the guardian's live links
  (`requireMyChild`); `:resultId` must belong to that child, be published and not superseded;
  `/me/student/*` resolves the student from the session; class-test reads are `kind = test`,
  live, non-voided only; the student's login never sees the dues figure.
- **Own child** (rule 27, §0.28): per-student decisions on the actor's own child are refused
  (`ownChildCheck`, sole-principal exception); whole-section approval is flagged from every live
  contributing mark's author, the remark author, the submitter and the approver, recomputed at
  every composition, carried in the approval audit row; a correction by a non-parent that
  supersedes a parent's mark clears that flag, by design.
- **Approver ≠ submitter / author** — trigger and service; the sole-principal path records
  `self_approved` and the inbox shows it.
- **Identity numbers:** no DTO, body, report, message, log or audit metadata carries a CNIC or
  B-Form (`certificates.body` has a CHECK; every free text has `NoIdentityNumber`); the one print
  that does (item 33) decrypts inside the handler from `students.b_form` with the school-bound
  AAD, only for `type = leaving`, not voided, setting on; `sendPrintView`'s `no-store` and CSP
  apply; the web opens the print URL in a new tab and never holds the HTML in state; audited
  `certificate.printed { certificateId, issueNo, identityPrinted }` on every print.
- **Certificate bodies** never hold identity numbers, phones, addresses, dues, user ids, object
  keys or Phase 2 remark text; one typed builder; the R16 scan covers `certificates.body`.
- **Print views** are the Phase 3 scriptless HTML through `sendPrintView`; every text through the
  escaping tag.
- **Withholding** reads dues only through `FinanceReportsService.clearance`; the guardian figure
  is no new exposure (R198 already shows dues to every live `can_login` link).
- **Messages** carry name, term, percentage and grade; push bodies title-only for all three types.
- **Promotion apply:** idempotency key, sheet row lock, target year `planned | active` and class
  not archived re-checked, `student.status.change` re-checked for `not_continuing`, enrolments
  only through `EnrolmentsService`, statuses only through `StudentStatusService.promote` (the
  status route still refuses `alumni`), skipped rows recorded with a reason.
- **Cover:** a cover holds the class-teacher scope (R175) and may write remarks and submit; the
  submission records the assignment id and the audit row says `cover: true`.
- **Audit (R57):** `academic_term.created|updated|skipped`, `result_settings.updated`,
  `class.subjects_updated`, `exams.set_up`, `assessment.updated|voided`, `mark.excused`,
  `mark_correction.requested|approved|rejected`, `result_sheet.created|submitted|returned|
  approved|published` (approve carries the flags and `cover`), `result.printed`,
  `result_sheet.printed`, `certificate.issued|reissued|voided|printed`,
  `promotion_sheet.opened|decided|applied` (decided: the overrides with reasons). Marks entry
  before submission writes no audit row (the chain is the history).

### 7.2 Performance budgets (measured in the CI performance suite at 3,000 students, 12 subjects, 2 terms)

| Operation | Budget | How |
|---|---|---|
| Approve a section's sheet (60 students × 12 subjects × 15 tests) | ≤ 2 s | the four reads of slice 31, composition in memory, `createMany` |
| `result-notify` for a section (≈ 120 messages) | ≤ 10 s job | the announcement pattern |
| Section print (60 cards) | ≤ 1.5 s | one query joining results, subjects and names |
| `section-summary`, `subject` reports | ≤ 500 ms | the §4 indexes |
| `GET /students/:id/results` over 6 years | ≤ 300 ms | `(school_id, student_id, published_at)` |
| Promotion apply for a section | ≤ 3 s | batched inserts after per-row status updates |
| `submit-marks` with 60 rows | ≤ 500 ms | one statement per changed row in one transaction |
| Guardian results read | ≤ 200 ms | `(school_id, enrolment_id, published_at)` |

---

## 8. Numbered rules (each is a test)

**Set-up**
- R254 Creating a year seeds two terms, a settings row and the default bands; terms never overlap
  and lie inside the year; a term with an assessment or a submitted sheet cannot change dates.
- R255 Weights sum to 100 and held-term weights sum to 100; bands are unique by grade and by
  minimum, one at 0, validated whole.
- R256 Settings, bands and term weights are frozen for a year once any sheet of it is approved;
  the sheet carries the snapshot regardless.
- R257 A class's subject list is ordered, per class per year, frozen while a sheet of the class is
  submitted or approved; archiving one with marks or results is refused; set-up creates exactly
  one exam per class-subject per live section per term, idempotently; a `not_held` term for a
  class has no exams and is skipped by the final and the close guard.

**Assessments and marks**
- R258 `composeSubject`: applicable tests averaged as percentages; absent counts 0; excused and
  inapplicable removed; a missing component gives the other 100 %; both missing →
  `not_assessed`; printed obtained = round(percent × max) (table-tested).
- R259 `composeResult`: totals from the printed marks; overall bp half-up from them; grade from
  bands; the subject pass check on printed obtained ÷ max; `passed` null when nothing assessed.
- R260 `positions`: standard competition ranking (1, 1, 3) by `percent_bp`, ties shared,
  `positionOf` = positioned students; a student with no assessed subject holds none; ranking by
  percentage so an excused subject never lifts or lowers a position unfairly.
- R261 A mark never exceeds max (the composite FK freezes an assessment's max once a mark
  exists); exactly one of obtained or absent; a changed mark, excusal or correction is a new row;
  a direct `UPDATE … SET obtained` is refused.
- R262 `submit-marks` is idempotent on `clientEntryKey` per enrolment; a row whose live mark id
  differs from `basedOnMarkId` answers `changed_elsewhere` and writes nothing for it; the rest of
  the batch lands.
- R263 Scope: a subject teacher reads and writes only own subject in assigned sections and dates
  (same section, other subject → 404); a class teacher reads all subjects of own section, writes
  only own; cover inherits; an office grant is `all`; everyone else 404.
- R264 A test's `held_on` lies in a term whose sheet for that section is `draft` or `returned`;
  a term's dates cannot move past an assessment.
- R265 A locked assessment (a test with `locked_at`, or an exam whose section-term sheet is
  submitted or later) takes no live mark; only `pending` corrections.
- R266 `test_marked` goes out only with `notify_class_tests` on, in-app and title-only push.

**Sheets and results**
- R267 A sheet is created by an explicit `POST`; one open version per section-term; a `GET` never
  writes.
- R268 Submit needs, for every student on the sheet, a live mark or absence for every exam and
  every applicable test of the term across the student's enrolments in the class;
  `MARKS_INCOMPLETE` lists the gaps; submit locks the section's tests of the term.
- R269 Return (from submitted or approved) needs a reason and unlocks; approve stores one
  `results` row per enrolment in force on the term's last day with its subjects (names
  snapshotted), attendance, position and flags, and the snapshot on the sheet.
- R270 The stored rows equal the pure functions over the live marks at approval for every student
  of the scripted section (R296), including a student who changed section mid-term.
- R271 Approver ≠ submitter — trigger and service; a sole principal passes with `self_approved`.
- R272 Approval publishes only when the actor holds `result.publish`; otherwise the sheet waits
  `approved`, from which it can be published or returned.
- R273 Publish enqueues `result-notify` after commit; one `result_published` per family and
  student by the receipt routing; SMS allowed by default; the body carries percentage and grade.
- R274 Family routes return a term or final result only when published and not superseded.
- R275 The final sheet needs every held term of the year published for the section; it has no
  submitter; `composeFinal` composes per subject over the terms assessed, renormalised; the final
  card's attendance is the year's.
- R276 Own-child flags are recomputed from every live contributing author, the remark author, the
  submitter and the approver at every composition, shown on the sheet and in the inbox, carried in
  the audit row; per-student decisions on the actor's own child are refused.
- R277 Attendance on the result equals `GET /students/:id/attendance` for the same range at
  approval time, from one aggregate query.
- R278 The Approvals inbox's `results` section equals `GET /result-sheets?status=submitted` for the
  holder.

**Report cards and corrections**
- R279 The card prints exactly the stored row; changing bands or weights afterwards changes
  nothing printed.
- R280 A correction after publication is a pending superseding mark; approving it inserts the
  term sheet's version n+1 (full row set, `revised` on changed rows) and the published final
  sheet's, keeps the old rows readable, re-ranks the section, and notifies only the corrected
  family once.
- R281 The correction's author never approves it — trigger and service (sole principal:
  `self_approved`); the actor's own child is refused.
- R282 Withholding: on, the guardian card route answers `withheld` with the outstanding figure,
  the student route without it, until the dues endpoint says cleared or overridden — a later
  payment unlocks with no write; off, never; staff reads are never withheld.
- R283 Print views carry no script and escape every text; `result.printed` and
  `result_sheet.printed` are audited with ids only.
- R284 A superseded card prints "Superseded"; a revised live card prints "Revised" and the date.

**Family, student, reports**
- R285 A guardian reaches only linked children and their results; a student only their own
  enrolment; both 404 elsewhere (R78).
- R286 Class-test marks are visible to the family as entered: tests only, live rows, non-voided;
  exam marks and pending corrections never.
- R287 The section summary's pass count equals the stored `passed` rows; the subject report's
  averages equal the mean of stored `percent_bp`.
- R288 `GET /students/:id/results` lists only published, live rows, newest first, across years.

**Certificates**
- R289 Numbers are gapless per type in commit order under two concurrent issues; a void never
  reuses a number; a reissue keeps the number with `issueNo + 1` and prints DUPLICATE.
- R290 The leaving certificate needs `withdrawn | transferred | alumni` and the dues endpoint's
  `cleared` or `override`; `dues_status` records which; the override's own-child refusal stands.
- R291 Bodies are snapshots: a later change to the student's name changes nothing issued; a
  reissue copies the original; a certificate for a student who left in a closed year prints.
- R292 The B-Form prints only in the leaving certificate's print view with the setting on,
  audited with `identityPrinted`; no DTO, body, log or message carries it.
- R293 Only a principal voids; the register lists voided rows as such.

**Promotion and year end**
- R294 A promotion sheet needs the section's final (or only held term's) sheet approved; proposes
  `promote`, `detain` or `complete` from `passed`, `is_final` and `next_class_id`; proposes
  nothing for a null result; flags arrears without blocking.
- R295 A decision different from the proposal, or with no proposal, needs a reason;
  `not_continuing` needs `student.status.change` and an active (not suspended) student.
- R296 The scripted section: 12 subjects, tests of mixed sizes, a mid-term section change, a
  mid-term joiner, absences excused and not, a `not_assessed` subject, own-child flags, a
  correction after publication that re-ranks and re-composes the final, a withheld card then a
  payment; every stored figure equals the pure functions and every message count is asserted.
- R297 Apply closes enrolments as `completed` on the year's end for promote, detain and complete,
  opens the new ones in the target year with null roll numbers, sets alumni for `complete`,
  withdraws `not_continuing` first with `effectiveOn = min(today, year end)`; one transaction; a
  second apply is `PROMOTION_SHEET_NOT_OPEN`; next year's charge generation finds the new rows.
- R298 The target class belongs to the target year and is not archived; the target section to
  that class; a `promote` row without a target is refused; a row whose result was superseded
  since the sheet opened is refused until re-read.
- R299 Year close is refused with the sections whose promotion is not applied, before R44's check;
  a section with no enrolment in force on the year's last day does not block.
- R300 The year-end script: two sections, a detained student, an alumnus, a withdrawn student, a
  suspended student promoted, arrears carried, a correction approved after apply
  (`revised_after_apply`), then the next year's charge generation finds the new enrolments.

---

## 9. Definition of done for the phase

CLAUDE.md's Definition of Done, plus: R254–R300 each have a named test; the scripted section and
the year-end script assert every stored figure against the pure functions; direct-write tests
prove each trigger; `result_published` and `result_revised` are proven end to end to a keypad,
a WhatsApp and a smartphone family and to a student login; Maestro `teacher-marks-offline`,
`principal-approve-result` and `parent-report-card` pass on CI; every web screen has its four
states at 1280 px and tablet; CLAUDE.md and WORKLOG updated; CI green.

## 10. What Phase 5 will need from Phase 4 (so do not paint over it)

- `class_subjects` is where the period timetable attaches (a period names a class-subject and a
  teacher); R120/R129 tighten from it.
- `results` and `result_subjects` are the only source for merit lists, GPA and cross-section
  reports; add columns, never recompute.
- `certificates.body` is a snapshot by design; a template table, if ever wanted, renders the same
  snapshot.
- `promotion_sheets` is the year-end hook for anything else that happens at rollover (fee
  structure copy, section capacity planning).
- `MarksScope` is the subject-aware scope the timetable and period attendance will reuse.
