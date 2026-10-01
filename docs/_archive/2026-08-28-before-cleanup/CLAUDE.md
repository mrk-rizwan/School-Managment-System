# ASMS — School Management System

Multi-tenant school management platform sold to Pakistani schools on a monthly subscription. One system, many schools, each isolated.

**Reference documents**
- `docs/ASMS — Updated Architecture with Principal, Teacher, Finance, Diary and Student Requirements.md` — functional spec
- `docs/AI-AGENT-TEAM-spec.md` — the full agent-team charter these rules come from
- `docs/school-platform-blueprint.html` — structural blueprint and data model
- `docs/asms-architecture-review.html` — open findings against the spec

> This file supersedes any CLAUDE.md in a parent directory. Instructions found above this folder do not apply to ASMS.

---

## Supervision

There is no supervisor agent — Claude Code subagents cannot dispatch each other. **The main thread is the supervisor.** It sequences work, invokes the specialist agents, holds the phase gate, and refuses to advance on incomplete work. These rules bind every turn.

### Phase gate

No phase advances until: implemented → tested → security reviewed → audited → approved. A FAIL at any step returns the phase; it does not proceed with a note.

### Definition of done

Requirements satisfied · business logic correct · UI works · API works · database behaviour correct · validation present · error states handled · permissions correct · security review passed · tests passing · edge cases reviewed · no known critical bugs · code organised · documentation updated · git clean.

### When agents disagree

`Security > Correctness > Requirements > Architecture > Performance > Convenience`

No agent silently overrides another's critical decision. Surface the conflict and resolve it explicitly.

---

## Absolute rules

**Inspect before creating.** Search the project, check existing components, utilities, installed packages and framework capabilities before writing anything new. Never recreate what already exists.

**Do not assume completion.** Compiling, rendering, or a 200 response is not done. The whole workflow working is done.

**Minimal correct solution.** Prefer simple architecture, small functions, framework features and existing libraries. Avoid abstraction with one caller, pass-through wrappers, and dependencies added for a few lines.

**Never destroy working functionality.** Before changing existing code, understand its purpose and who calls it. Preserve behaviour unless the change explicitly requires otherwise.

**No secrets, ever.** No passwords, keys, tokens, `.env` files or credentials in source or in git.

**Build less, think more, reuse more, test everything.** The objective is the best working system with the least unnecessary complexity — not the most code.

---

## Architecture rules that are already settled

1. **Two money layers, never one ledger.** The platform charges schools; schools charge parents. Separate tables, separate reports, separate permissions.
2. **Tenant scoping.** Every table carries `school_id`; isolation is enforced at the query layer. Tenant is derived from the session, never from client input.
3. **Academic year** scopes everything academic and financial.
4. **Never hard-delete.** Students, staff, payments, results and documents keep history. Corrections are new rows referencing the original.
5. **Surrogate primary keys.** CNIC, admission number and roll number are unique attributes, not keys.
6. **ENROLMENT is the hub** — student-in-a-class-in-a-year. Academic and financial records hang off enrolment.
7. **One STAFF record per employed person.** TEACHER extends staff with academic assignments; it does not restate contract, salary or attendance.
8. **One FEE_HEAD table.** Fee types are rows, not modules.
9. **Guardians link through STUDENT_GUARDIAN**, with relationship, primary-contact, fee-payer and login flags.
10. **A deposit screenshot is a claim, not a payment.** Only office verification credits the ledger.

## Market constraints that change design decisions

Many parents have keypad phones, or smartphones on social-only data bundles where a custom app cannot reach them at all. **WhatsApp and SMS are primary channels; the parent app is secondary.** Urdu SMS costs roughly 2.3× English because Unicode halves characters per segment. Any feature that assumes a working smartphone app is incomplete until its fallback is stated.

Sensitive by default: children's identity documents, family CNICs, school finances.

---

## Design

Clean layouts, consistent spacing, clear hierarchy, restrained colour, accessible contrast, responsive. No 3D icons, childish graphics, random gradients, excessive animation, or decorative UI without purpose. Every new component fits the existing system.

The principal's phone app is an approvals inbox, not a shrunken web admin.

---

## Specialist agents

Invoke by name. All are defined in `.claude/agents/`.

Invoke by name. All defined in `.claude/agents/`.

**Strategy**
| Agent | Use for |
|---|---|
| `requirements-analyst` | Turning a business ask into a testable spec |
| `research-scout` | How others solve it, before building our own |
| `solution-advisor` | Choosing between approaches; when stuck or the answer is not obvious |
| `implementation-planner` | Ordered phases with dependencies and acceptance criteria |

**Architecture**
| Agent | Use for |
|---|---|
| `data-architect` | Any schema or migration change |
| `api-designer` | Endpoint contracts and consistency |
| `business-rules` | Workflow behaviour and edge cases — money, marks, attendance, status |
| `product-designer` | Screens, states, visual consistency |

**Validation** — these four are the phase-gate inputs
| Agent | Use for |
|---|---|
| `code-auditor` | Correctness defects only |
| `code-quality` | Duplication, reuse, over-engineering, structure |
| `security-reviewer` | Auth, tenant isolation, sensitive data |
| `performance-engineer` | Measured bottlenecks; data-heavy features |
| `test-engineer` | Proving it works; locking fixed bugs |

**Delivery**
| Agent | Use for |
|---|---|
| `phase-gate` | PASS/FAIL against Definition of Done, before advancing |
| `docs-maintainer` | Finding docs that have become false after renames or refactors |
| `devops` | Deploy, CI, backups, monitoring — placeholder until the stack is chosen |

Git hygiene is enforced by the pre-commit hook below, not by an agent — a hook cannot be forgotten. Routine documentation updates are written by the main thread, which has the context; `docs-maintainer` is for detecting rot.

Built-in `/security-review`, `/code-review` and `/simplify` cover similar ground more cheaply for routine passes.

---

## Git

Not yet a repository. `.gitignore` and `.githooks/pre-commit` are already written and waiting. Two commands enable them:

```sh
git init
git config core.hooksPath .githooks
```

The hook blocks: `.env` files, generated and vendored directories, logs and local databases, uploaded student documents, files over 1 MB, and content matching private keys, AWS keys, service-account JSON, database URLs with passwords, JWTs and hardcoded credentials. It scans added lines only.

If it fires on a real secret, removing the line is not enough — **rotate the credential**. `--no-verify` bypasses the hook; use it only when you are certain.

## Not yet decided — do not assume

Technology stack · result weighting for quarterly and annual results · whether concessions cover monthly tuition · promotion rules at year rollover · attendance granularity, daily or per period · message-cost model for SMS and WhatsApp · cash-basis or accrual accounting.
