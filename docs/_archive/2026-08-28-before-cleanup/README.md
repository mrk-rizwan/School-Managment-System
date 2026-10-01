# Archive — 28 August 2026, before the first cleanup

A frozen copy of every ASMS document as it stood **before** the corrections that
followed the three-agent review. Kept so the earlier thinking stays visible.

Nothing in this folder is current. Do not build from it, and do not let an agent
read it as a source of truth — the live documents are one level up in `docs/`.

## What was here at the time

| File | What it was |
|---|---|
| `ASMS — Updated Architecture…md` | The functional spec, written on paper first then typed up. 35 sections. |
| `school-platform-blueprint.html` | First structural pass — tenancy, module map, role matrix, the original data model. |
| `asms-architecture-review.html` | Review of the functional spec: 5 modelling bugs, 4 undecided, 6 gaps, 6 corrections. |
| `announcements-concept.html` | Client concept deck for announcements. Written **before** the connectivity discussion. |
| `asms-system-architecture.html` | Technical baseline — stack, modules, notification drivers, charge lifecycle. |
| `asms-system-design.html` | Client-facing system design. |
| `CLAUDE.md` | Project rules as they stood. |
| `agents/` | The 16 specialist agent definitions. |

## Why this snapshot exists

Three agents audited this set and found roughly 45 issues between them. Four mattered
most, and they are the reason for the freeze:

1. **The client design contradicted itself** — Figure 04 said parents see marks
   immediately, Section 08 said only after the principal approves.
2. **A promise that cannot be kept** — "the school sees who has read it". SMS has no
   read receipt at all.
3. **Features that were only words** — staff leave, certificates and events appeared in
   the design with no workflow, no actor and no acceptance criteria.
4. **The functional spec was never corrected** — it remained the document of record
   while still containing every error the review had found.

Two documents in here were also *superseded by later decisions* rather than simply
being wrong:

- `announcements-concept.html` recommends an app-first channel policy. The later
  connectivity work reversed that: WhatsApp and SMS are primary, the app is secondary.
- `school-platform-blueprint.html` contains a separate `EVENT_FEE` table, which
  contradicts the settled rule that fee types are rows in one table, not modules.

## What happened next

The live documents were corrected, the functional spec gained an overrides header, and
the four separate open-decision lists were collapsed into one register in `CLAUDE.md`.
