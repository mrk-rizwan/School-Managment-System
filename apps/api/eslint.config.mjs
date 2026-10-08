// API lint config. Beyond the standard rule sets it holds the tenant-isolation boundaries
// (CLAUDE.md "How tenant isolation is implemented", plan §3.1-§3.2, rule R61). Each boundary
// is proven to fire by test/guardrails/lint-boundaries.spec.ts.
//
// Linting is type-aware so that an `any` (a request body, JSON.parse, an untyped import) cannot
// flow into a SchoolId or Scope parameter: the no-unsafe-* rules report it. The syntax bans below
// close the forms of forging a brand that are type-correct and therefore invisible to tsc.
//
// ESLint does not merge the options of one rule across config blocks: the last matching block
// wins. So every block that relaxes a boundary restates the whole rule through restrictImports()
// or restrictSyntax(), naming only what it exempts.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import noBrandInRequest from './eslint-rules/no-brand-in-request.mjs';

// ---------------------------------------------------------------------------- import boundaries
// Regexes match the import specifier as written, so relative, baseUrl and package forms all hit.
// A trailing source extension (.js, .ts, .mjs, ...) is accepted so it cannot be used to slip past.
const EXT = '(\\.[cm]?[jt]s)?';

const IMPORTS = {
  // The Prisma client, generated or published, and its driver adapter.
  prisma: {
    regex: '^@prisma/|(^|/)generated/prisma(/|$)|^\\.prisma/',
    message: 'Prisma may be imported only under src/repositories/**. Call a repository.',
  },
  // The guarded client, its module and the guard: the way to Prisma from outside the layer.
  repositoryInternals: {
    regex: `(^|/)repositories/(prisma|database\\.module|query-guard)${EXT}$`,
    message:
      'The Prisma client, DatabaseModule and the query guard are internal to src/repositories/**. Call a repository.',
  },
  // Repositories over the non-tenant tables (named exception 1).
  platformRepositories: {
    regex: '(^|/)repositories/platform(/|$)',
    message:
      'Platform repositories may be imported only from src/modules/platform/** and the named exception sites.',
  },
  // SchoolId constructors; see src/tenancy/school-id.mint.ts.
  schoolIdMint: {
    regex: `(^|/)school-id\\.mint${EXT}$`,
    message:
      'SchoolId is minted only by the named-exception repositories and, via fromPlatformSchool, the platform module.',
  },
  // Scope constructors; only the permission service builds a Scope.
  scopeMint: {
    regex: `(^|/)scope\\.mint${EXT}$`,
    message: 'Scope is constructed only by the permission service in src/modules/access/**.',
  },
  // The raw request-context store. A plain ClsService lets any value be set as the tenant and
  // lets get<T>() claim any type; ClsServiceManager and @UseCls hand one out too. Read the
  // context through RequestContextService (src/tenancy/request-context.ts).
  cls: {
    regex: '^nestjs-cls$',
    message: 'nestjs-cls is used only inside src/tenancy/**. Inject RequestContextService.',
  },
  // The ambient-transaction client. Services keep the @Transactional() decorator; only the
  // repositories (and the tenancy module that registers the plugin) reach the client.
  transactionHost: {
    regex: '^@nestjs-cls/transactional$',
    allowImportNames: ['Transactional', 'Propagation'],
    message:
      'Outside src/repositories/** use only @Transactional() and Propagation; TransactionHost reaches the Prisma client.',
  },
  transactionalAdapter: {
    regex: '^@nestjs-cls/transactional-adapter-prisma$',
    message:
      'The Prisma transaction adapter is internal to src/repositories/** and src/tenancy/**.',
  },
  // The only writer of the request's tenant. Session resolution lives in src/tenancy/** (named
  // exception 4), so nothing outside that folder may import it.
  sessionEstablisher: {
    regex: `(^|/)session-establisher${EXT}$`,
    message: 'Only session resolution (src/tenancy/**) sets the request tenant.',
  },
  // Phase 2 plan rule 0.11, §4.1. The queue library: jobs are enqueued after commit by the outbox
  // dispatcher and consumed by src/jobs/**; a service never touches a queue.
  bullmq: {
    regex: '^bullmq(/|$)',
    message:
      'bullmq is used only in src/jobs/** and src/messaging/outbox-dispatcher.ts. Enqueue through OutboxDispatcher.',
  },
  // The fifth SchoolId constructor and runAsSchool (src/tenancy/queue.mint.ts): job bodies only.
  queueMint: {
    regex: `(^|/)queue\\.mint${EXT}$`,
    message: 'queue.mint is imported only by src/jobs/**: a job payload becomes a SchoolId nowhere else.',
  },
  // Job-payload resolution's one read of schools (named exception 3, widened).
  schoolByIdRepository: {
    regex: `(^|/)repositories/platform/school-by-id\\.repository${EXT}$`,
    message: 'SchoolByIdRepository is imported only by src/tenancy/queue.mint.ts.',
  },
  // contracts/slice-14.md §1.1 (R114): the platform never reads announcements or messages, so
  // this slice's repositories are importable only from the modules that own them.
  announcementRepositories: {
    regex: `(^|/)repositories/(announcement|announcement-audience|announcement-recipient|inbox)\\.repository${EXT}$`,
    message:
      'Announcement and inbox repositories are imported only from src/modules/announcements/**, src/modules/me/**, src/modules/calendar/** and src/jobs/**.',
  },
  // Phase 3 (phase-3-financial.md §5.1, R222): the five platform-billing repositories, importable
  // only from src/modules/platform/billing/** and the two billing jobs below.
  billingRepositories: {
    regex: `(^|/)repositories/platform/(plan|subscription|invoice|platform-payment|school-metrics)\\.repository${EXT}$`,
    message:
      'Billing repositories are imported only from src/modules/platform/billing/**, src/jobs/platform-billing.ts and src/jobs/school-metrics-rollup.ts.',
  },
  // A18: a school reads its own platform invoices only through these two sites.
  ownInvoicesRepository: {
    regex: `(^|/)repositories/own-invoices\\.repository${EXT}$`,
    message:
      'OwnInvoicesRepository is imported only from src/jobs/billing-notices.ts and the GET /school/billing-status controller.',
  },
  // Phase 4 (phase-4-academic.md §5.1): the set-up repositories of slice 29 are the academics
  // module's. A later wave that reads them (exams, sheets, promotion) is added to their block
  // below as a recorded change.
  academicSetupRepositories: {
    regex: `(^|/)repositories/(academic-term|result-settings|class-subject)\\.repository${EXT}$`,
    message:
      'The term, result-settings and class-subject repositories are imported only from src/modules/academics/**.',
  },
  // Phase 4 slice 34 (§5.1): the certificate repository is the certificates module's.
  certificateRepository: {
    regex: `(^|/)repositories/certificate\\.repository${EXT}$`,
    message: 'CertificateRepository is imported only from src/modules/certificates/**.',
  },
  // Phase 4 slice 30 (§5.1): the assessment and mark repositories are the assessments module's
  // (wave O's results module reads marks through its own read-only MarkReadsRepository).
  assessmentRepositories: {
    regex: `(^|/)repositories/(assessment|mark)\\.repository${EXT}$`,
    message: 'The assessment and mark repositories are imported only from src/modules/assessments/**.',
  },
  // Phase 4 slice 31 (§5.1): the result-sheet, result and read-only mark-reads repositories are
  // the results module's (it reads marks only through MarkReadsRepository).
  resultRepositories: {
    regex: `(^|/)repositories/(result-sheet|result|mark-reads)\.repository${EXT}$`,
    message: 'The result-sheet, result and mark-reads repositories are imported only from src/modules/results/**.',
  },
  // Nothing reaches a parent except through NotificationService (plan rule 0.11).
  messagingDrivers: {
    regex: '(^|/)messaging/drivers(/|$)',
    message: 'Drivers are imported only inside src/messaging/**. Call NotificationService.',
  },
};

// Exempt in a tenant repository (src/repositories/** outside platform/), which owns the client and
// the ambient transaction but reads no platform or billing table (phase close, security low).
const TENANT_REPOSITORY_IMPORTS = [
  'prisma',
  'repositoryInternals',
  'announcementRepositories',
  'transactionHost',
  'transactionalAdapter',
];

// Exempt in the platform repositories (src/repositories/platform/**, the named-exception block below).
const REPOSITORY_IMPORTS = [
  'prisma',
  'repositoryInternals',
  'platformRepositories',
  'announcementRepositories',
  'billingRepositories',
  'ownInvoicesRepository',
  'transactionHost',
  'transactionalAdapter',
];

// The modules that own the announcement and inbox repositories (contracts/slice-14.md §1.1).
const ANNOUNCEMENT_SITES = [
  'src/modules/announcements/**/*.ts',
  'src/modules/me/**/*.ts',
  'src/modules/calendar/**/*.ts',
];

// Exempt in the tenancy module, which defines the brands and the request context and registers
// the transaction plugin over the guarded client.
const TENANCY_IMPORTS = [
  'schoolIdMint',
  'scopeMint',
  'repositoryInternals',
  'cls',
  'transactionHost',
  'transactionalAdapter',
  'sessionEstablisher',
];

/**
 * The full no-restricted-imports rule minus the named exemptions (or with narrowed entries), plus
 * any `extra` patterns only that block refuses.
 */
function restrictImports({ exempt = [], narrowed = [], extra = [] } = {}) {
  const patterns = Object.entries(IMPORTS)
    .filter(([key]) => !exempt.includes(key) && !narrowed.some((n) => n.key === key))
    .map(([, pattern]) => pattern);
  for (const { key, ...narrowing } of narrowed) {
    patterns.push({ ...IMPORTS[key], ...narrowing });
  }
  patterns.push(...extra);
  return { 'no-restricted-imports': ['error', { patterns }] };
}

// Phase 3 billing (§5.1, R222): the platform's billing module reads no tenant table, so it may
// import no tenant repository (every src/repositories file outside platform/).
const TENANT_REPOSITORY_IMPORT = {
  // Any depth below src/repositories except platform/, so a tenant repository in a future
  // subfolder is caught too (fixture tenant-repository-nested-import.ts).
  regex: `(^|/)repositories/(?!platform/).+\\.repository${EXT}$`,
  message: 'src/modules/platform/billing/** reads no tenant table: it imports only the billing repositories (R222).',
};

// Phase 4 (§5.1): the certificates module reads dues only through
// FinanceReportsService.clearance, never the money tables' repositories.
const MONEY_REPOSITORY_IMPORT = {
  regex: `(^|/)repositories/(finance-report|charge|charge-[a-z-]+|payment|payment-[a-z-]+|receipt|concession)\\.repository${EXT}$`,
  message: 'src/modules/certificates/** reads dues only through FinanceReportsService.clearance (§5.1).',
};

/** The platform-repositories pattern with several repository files let through. */
const platformRepositoriesExceptAll = (files) => ({
  ...IMPORTS.platformRepositories,
  regex: `(^|/)repositories/platform(/(?!(${files.map((f) => f.replaceAll('.', '\\.')).join('|')})${EXT}$)|$)`,
});

const BILLING_REPOSITORY_FILES = [
  'plan.repository',
  'subscription.repository',
  'invoice.repository',
  'platform-payment.repository',
  'school-metrics.repository',
];

// Files that legitimately call the pre-auth school lookup, session resolution or the scheduler
// fan-out (CLAUDE.md named exceptions 2-4), each with the one platform repository it may import;
// every other platform repository stays refused there. Each is added here by the slice that
// writes it; adding one is a recorded decision, not a convenience.
// `exempt` keeps the import exemptions the site's folder already has.
const NAMED_EXCEPTION_SITES = {
  // Exception 2's spray detection: one platform_audit_log row per school per window (contract
  // slice-2 §3.1 step 6).
  'src/modules/auth/login-spike.recorder.ts': { repository: 'platform-audit.repository' },
  // Exception 3, the scheduler fan-out: the daily staged-upload sweep lists every school's id
  // (any status) and then works per school with ordinary scoped repositories.
  'src/modules/documents/staged-upload.sweep.ts': { repository: 'school-fan-out.repository' },
  // Exception 3 widened to job-payload resolution (Phase 2 plan §4.1): the fifth SchoolId
  // constructor reads the school a queue payload names. The only importer of
  // school-by-id.repository; it lives in src/tenancy and keeps that folder's exemptions.
  'src/tenancy/queue.mint.ts': {
    repository: 'school-by-id.repository',
    exempt: [...TENANCY_IMPORTS, 'schoolByIdRepository'],
  },
  // Exception 3 in the worker (contracts/slice-9.md §7.9-§7.11): the messaging housekeeping jobs
  // fan out over the live schools, then work per school in runAsSchool with scoped repositories.
  'src/jobs/job-runner.ts': {
    repository: 'school-fan-out.repository',
    exempt: ['bullmq', 'queueMint', 'announcementRepositories'],
  },
  // Named exception 6 (contracts/slice-9.md §7.11): the only writer of platform_delivery_health
  // outside the platform module, run per school by the rollup job.
  'src/jobs/delivery-health-rollup.ts': {
    repository: 'delivery-health.repository',
    exempt: ['bullmq', 'queueMint', 'announcementRepositories'],
  },
  // Named exception 5 (contracts/slice-9.md §8.5): provider webhooks correlate a report with its
  // row by a global key before any tenant is known. The only importer of that repository.
  'src/webhooks/webhooks.service.ts': { repository: 'delivery-webhook.repository' },
};

/** The platform-repositories pattern with one repository file let through. */
const platformRepositoriesExcept = (file) => ({
  ...IMPORTS.platformRepositories,
  regex: `(^|/)repositories/platform(/(?!${file.replaceAll('.', '\\.')}${EXT}$)|$)`,
});

// Files allowed tagged $queryRaw / $executeRaw. Each must have its own isolation test.
// Tests may use raw SQL freely; they are not application code.
const RAW_SQL_FILES = [
  // Exception 4: SessionRepository.findActiveByTokenHash, the one unscoped tenant read
  // (test/school-auth/repositories.e2e-spec.ts).
  'src/repositories/session.repository.ts',
  // UserRepository.list: the users page sorted by COALESCE(staff, guardian) name; tenant
  // predicate on the WHERE and every join (test/school-auth/repositories.e2e-spec.ts).
  'src/repositories/user.repository.ts',
  // Named exception 5: DeliveryWebhookRepository's two statement shapes (contracts/slice-9.md
  // §8.5), each returning the school it touched (test/webhooks/webhooks.e2e-spec.ts).
  'src/repositories/platform/delivery-webhook.repository.ts',
  // ChangeContextRepository.setChangeContext: two transaction-local set_config calls for the §4.6
  // history triggers; reads and writes no table, so it has no isolation test of its own
  // (change-context.repository.spec.ts proves the settings die with the transaction).
  'src/repositories/change-context.repository.ts',
  // Slice 11 (contracts/slice-11.md): the register and mark upserts on their natural keys, the
  // FOR SHARE / FOR UPDATE locks of §1.6, time columns as HH:MM, the stale-summary scans and the
  // reports over the materialised tables. Each statement filters school_id on every table it
  // reads (test/attendance/repositories.e2e-spec.ts).
  // Slice 14 (contracts/slice-14.md): the delivery summary's latest attempt per message and
  // channel (DISTINCT ON) and the inbox's join of messages to announcements. Each filters
  // school_id on every table it reads (test/announcements/isolation.e2e-spec.ts).
  'src/repositories/announcement.repository.ts',
  'src/repositories/inbox.repository.ts',
  'src/repositories/attendance-register.repository.ts',
  'src/repositories/attendance-mark.repository.ts',
  'src/repositories/attendance-alert.repository.ts',
  'src/repositories/attendance-summary.repository.ts',
  'src/repositories/attendance-report.repository.ts',
  // Slice 12: the two staff_attendance row locks (SELECT ... FOR UPDATE in staff_id order), each
  // filtering school_id (test/staff-attendance/isolation.e2e-spec.ts).
  'src/repositories/staff-attendance.repository.ts',
  // Phase 3 slice 18: FeeHeadRepository.seedForSchool calls asms_seed_school_finance(school_id),
  // the one definition of a school's finance seeds; it writes only that school's rows
  // (test/fees/seeds.e2e-spec.ts).
  'src/repositories/fee-head.repository.ts',
  // Phase 4 (R254): AcademicYearRepository.seedResults calls asms_seed_year_results(school_id,
  // year_id), the one definition of a year's result settings and seeded terms; it writes only that
  // school's rows (test/academics/terms.e2e-spec.ts).
  'src/repositories/academic-year.repository.ts',
  // R232: StudentGuardianRepository.userIsLiveGuardianOf reads asms_guardian_merge_family; every
  // table filtered on school_id (test/fees/isolation.e2e-spec.ts).
  'src/repositories/student-guardian.repository.ts',
  // Phase 3 slice 19: the charge and student row locks (FOR UPDATE in id order, §3.2), and
  // generation's INSERT … SELECT per class, campaign insert and late-fee writes with their
  // column-and-predicate ON CONFLICT keys. Every statement filters school_id on every table it
  // reads (test/charges/isolation.e2e-spec.ts).
  'src/repositories/charge.repository.ts',
  'src/repositories/charge-generation.repository.ts',
  'src/repositories/concession.repository.ts',
  // Phase 3 slice 20: the payment row locks (FOR UPDATE in id order, R236: the payments, the
  // advances, a collector's custody) and the receipt counter's upsert. Every statement filters
  // school_id (test/payments/isolation.e2e-spec.ts).
  'src/repositories/payment.repository.ts',
  'src/repositories/receipt.repository.ts',
  // Phase 3 slice 22: the finance reports' aggregates, the fee-reminder families and the dues
  // clearance's reads; read-only. Every statement filters school_id on every table it reads
  // (test/finance-reports/isolation.e2e-spec.ts).
  'src/repositories/finance-report.repository.ts',
  // Phase 4 slice 34: the cert_<type> counter's upsert (R289), filtered on school_id like the
  // receipt counter's (test/certificates/certificates.e2e-spec.ts).
  'src/repositories/certificate.repository.ts',
  // Phase 4 slice 31 review: ResultSheetRepository.lockTestRows, the assessments a submission or
  // a return locks or unlocks taken FOR UPDATE in id order (contracts/slice-31.md §2.4), filtered
  // on school_id (test/results/isolation.spec.ts, test/results/result-sheets.e2e-spec.ts).
  'src/repositories/result-sheet.repository.ts',
];

// ------------------------------------------------------------------------------ syntax bans

/** Member access in dot, string-bracket and template-bracket form, and destructuring, of `names`. */
const memberNamed = (names) =>
  [
    `MemberExpression[property.name=${names}]`,
    `MemberExpression[property.value=${names}]`,
    `MemberExpression > TemplateLiteral.property > TemplateElement[value.raw=${names}]`,
    `ObjectPattern > Property[key.name=${names}]`,
    `ObjectPattern > Property[key.value=${names}]`,
  ].join(', ');
const RAW_UNSAFE = '/^\\$(queryRawUnsafe|executeRawUnsafe)$/';
const RAW = '/^\\$(queryRaw|executeRaw)$/';

// CreatedSchoolRow and PrincipalIssueSchoolRow are the brands fromPlatformSchool accepts (src/tenancy/school-id.ts).
const BRAND = '/^(SchoolId|Scope|MarksScope|CreatedSchoolRow|PrincipalIssueSchoolRow)$/';
/** A reference to a brand by plain or qualified name (`SchoolId`, `ns.SchoolId`). */
const brandRef = (name) =>
  `TSTypeReference:matches([typeName.name=${name}], [typeName.right.name=${name}])`;
const ASSERTION = ':matches(TSAsExpression, TSTypeAssertion)';

const SYNTAX = {
  relationWrites: [
    {
      selector:
        'Property:matches([key.name=/^(connect|connectOrCreate|set|disconnect)$/], [key.value=/^(connect|connectOrCreate|set|disconnect)$/])',
      message:
        'Write scalar foreign keys (schoolId + xId), never connect/connectOrCreate/set/disconnect: the composite FK then rejects a foreign id.',
    },
  ],
  rawUnsafe: [
    {
      selector: `:matches(${memberNamed(RAW_UNSAFE)})`,
      message:
        '$queryRawUnsafe / $executeRawUnsafe are banned. Use a tagged $queryRaw in a file listed in eslint.config.mjs.',
    },
    {
      // The name held in a variable and then used as a computed key: `const k = '$queryRawUnsafe'`.
      selector: `:matches(Literal[value=${RAW_UNSAFE}], TemplateElement[value.raw=${RAW_UNSAFE}])`,
      message: '$queryRawUnsafe / $executeRawUnsafe are banned by name as well as by access.',
    },
  ],
  raw: [
    {
      selector: `:matches(${memberNamed(RAW)})`,
      message:
        'Raw SQL is allowed only in files listed in RAW_SQL_FILES in eslint.config.mjs, each with an isolation test.',
    },
  ],
  schoolIdCast: [
    {
      selector: `${ASSERTION} ${brandRef('"SchoolId"')}`,
      message:
        'Never assert a SchoolId. It is minted only in src/tenancy/school-id.mint.ts: the session, the school lookup, the scheduler fan-out, a queue payload or a delivery report (named exceptions 2-5), or the platform module.',
    },
  ],
  scopeCast: [
    {
      selector: `${ASSERTION} ${brandRef('"Scope"')}`,
      message: 'Never assert a Scope. PermissionsService.can() returns it.',
    },
    {
      // phase-4-academic.md §0.27: the subject-aware scope is minted only in src/tenancy/scope.mint.ts.
      selector: `${ASSERTION} ${brandRef('"MarksScope"')}`,
      message: 'Never assert a MarksScope. PermissionsService.marksScopeOf() returns it.',
    },
  ],
  // Type-correct ways to produce a brand without a cast. None is needed outside src/tenancy.
  brandForgery: [
    {
      selector: `TSTypePredicate ${brandRef(BRAND)}`,
      message: 'A type predicate or assertion function cannot vouch for a SchoolId or Scope.',
    },
    {
      // An overload signature may claim a return type its implementation (returning unknown) never checks.
      selector: `:matches(TSDeclareFunction, TSEmptyBodyFunctionExpression) > TSTypeAnnotation.returnType ${brandRef(BRAND)}`,
      message: 'An overload or bodiless declaration cannot return a SchoolId or Scope.',
    },
    {
      selector: `VariableDeclaration[declare=true] ${brandRef(BRAND)}`,
      message: 'A declared (ambient) variable cannot hold a SchoolId or Scope.',
    },
    {
      // e.g. parse<SchoolId>(body), where parse<T>(x: unknown): T is a cast in disguise.
      selector: `:matches(CallExpression, NewExpression, TaggedTemplateExpression, TSInstantiationExpression) > TSTypeParameterInstantiation.typeArguments ${brandRef(BRAND)}`,
      message:
        'Do not instantiate a generic call or constructor with SchoolId or Scope; the value must be minted.',
    },
    {
      // @Body() / @Query() / @Param() typed with a brand: Nest fills it from the request unchecked.
      selector: `:matches(Identifier, ObjectPattern, AssignmentPattern, TSParameterProperty)[decorators.length>0] ${brandRef(BRAND)}`,
      message: 'A decorated (request-bound) parameter cannot carry a SchoolId or Scope.',
    },
    {
      // A DTO field typed SchoolId would be filled from the request body by class-transformer.
      selector: `PropertyDefinition > TSTypeAnnotation ${brandRef(BRAND)}`,
      message:
        'A class field cannot be typed SchoolId or Scope (a DTO would fill it from the request). Pass it as an argument.',
    },
  ],
  // A brand under another name slips past every selector above, which match it by name. The
  // type-aware no-unsafe-type-assertion rule closes the alias for casts; these close the rest.
  brandAlias: [
    {
      selector: `ImportSpecifier[imported.name=${BRAND}]:not([local.name=${BRAND}])`,
      message: 'Import SchoolId and Scope under their own names.',
    },
    {
      selector: `TSTypeAliasDeclaration > ${brandRef(BRAND)}.typeAnnotation`,
      message: 'Do not alias SchoolId or Scope; refer to them by name.',
    },
  ],
  // `declare const x: T` and `declare function f(): T` are claims tsc never checks.
  ambient: [
    {
      selector:
        ':matches(VariableDeclaration, TSDeclareFunction, ClassDeclaration, TSModuleDeclaration, TSEnumDeclaration)[declare=true]',
      message: 'Ambient declarations are unchecked claims. Only src/tenancy declares the brands.',
    },
  ],
  // `import('../tenancy/school-id.mint').X` in a type position is not an import declaration, so
  // no-restricted-imports never sees it. A static `import type` does the same job and is checked.
  typeImport: [
    {
      selector: 'TSImportType',
      message: 'Use a static `import type`; an import() type escapes the import boundaries.',
    },
  ],
  // Only src/repositories/prisma.ts builds a client: any other would skip the query guard.
  prismaClient: [
    {
      selector: `:matches(NewExpression[callee.name=/^PrismaClient$/], NewExpression[callee.property.name=/^PrismaClient$/], ${memberNamed('/^PrismaClient$/')})`,
      message:
        'Only src/repositories/prisma.ts constructs a PrismaClient. Use createGuardedClient.',
    },
    {
      // A value import could be renamed (`as P`) and constructed under another name.
      selector:
        'ImportDeclaration[importKind=value] > ImportSpecifier[importKind=value][imported.name=/^PrismaClient$/]',
      message:
        'Only src/repositories/prisma.ts imports the PrismaClient class as a value. Use `import type`.',
    },
  ],
  // Sets the request's tenant. Only session resolution calls it.
  establishSession: [
    {
      selector: `:matches(${memberNamed('/^establishSession$/')})`,
      message:
        'Only session resolution (src/tenancy/**, through SessionEstablisher) sets the request tenant.',
    },
  ],
  assertionEscapes: [
    {
      selector: `${ASSERTION} > TSNeverKeyword`,
      message: '`as never` defeats the type checker. Fix the type instead.',
    },
    {
      // `x as unknown as T`, `<T>(x as unknown)` and every other chained assertion.
      selector: `${ASSERTION} > ${ASSERTION}.expression`,
      message: 'Double assertions defeat the type checker. Fix the type instead.',
    },
  ],
  dynamicImport: [
    {
      selector: 'ImportExpression',
      message: 'Dynamic import() escapes the import boundaries. Use a static import.',
    },
  ],
};

// Bans that apply only inside the trusted layers, on top of SYNTAX.
const LAYER_SYNTAX = {
  // A barrel in a trusted folder would re-export internals under a path no import rule names.
  reExports: [
    {
      selector: 'ExportAllDeclaration, ExportNamedDeclaration[source]',
      message:
        'src/tenancy/** and src/repositories/** do not re-export. Import from the defining file.',
    },
  ],
  // `db[k](...)` reaches any client method, $queryRawUnsafe included, under a name lint cannot see.
  computedMember: [
    {
      selector:
        'MemberExpression[computed=true]:not([property.type="Literal"]), MemberExpression[computed=true][property.value=/^\\$/], MemberExpression[object.name="Reflect"]',
      message:
        'In src/repositories/** members are reached by name: no computed key, no $-prefixed literal key, no Reflect.',
    },
  ],
};

/** The full no-restricted-syntax rule minus the named exemptions. */
function restrictSyntax(...exempt) {
  return restrictSyntaxWith([], ...exempt);
}

/** As restrictSyntax, plus the named LAYER_SYNTAX bans. */
function restrictSyntaxWith(layer, ...exempt) {
  const selectors = Object.entries(SYNTAX)
    .filter(([key]) => !exempt.includes(key))
    .flatMap(([, entries]) => entries);
  return {
    'no-restricted-syntax': ['error', ...selectors, ...layer.flatMap((key) => LAYER_SYNTAX[key])],
  };
}

const REPOSITORY_LAYER = ['reExports', 'computedMember'];
const TENANCY_LAYER = ['reExports'];
// Declares the brands' unique symbols and sets the tenant on the request context.
const TENANCY_EXEMPT = ['ambient', 'establishSession'];

// Test code may use dynamic import and raw SQL; it is not application code.
const TEST_SYNTAX_EXEMPT = ['raw', 'dynamicImport'];
const SPEC_FILES = ['**/*.spec.ts', '**/*.e2e-spec.ts'];

// The only two files allowed a type assertion that narrows: each holds its brand's one cast.
// Every other narrowing assertion in src/ is a lint error (no-unsafe-type-assertion), which is
// what stops `v as S` where S is a renamed import, a local alias or Parameters<typeof repo>[0].
const MINT_FILES = ['src/tenancy/school-id.mint.ts', 'src/tenancy/scope.mint.ts'];

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'src/repositories/generated/**', 'test/fixtures/**'],
  },
  {
    // An eslint-disable comment would switch every boundary off for a line or a file. Nothing in
    // src/ or test/ needs one, so inline configuration is ignored everywhere.
    files: ['**/*.ts'],
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
      // A suppression comment would switch the brand check off for a line.
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': true, 'ts-ignore': true, 'ts-nocheck': true, 'ts-check': false },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      ...restrictImports(),
      ...restrictSyntax(),
    },
  },
  {
    files: ['test/**/*.ts', ...SPEC_FILES],
    languageOptions: { globals: { ...globals.jest } },
    rules: {
      ...restrictSyntax(...TEST_SYNTAX_EXEMPT),
      // @types/jest types asymmetric matchers (expect.any, objectContaining) as `any`, so every
      // matcher object trips this rule. Tests are not a request path; response bodies are still
      // typed explicitly, which keeps no-unsafe-member-access meaningful here.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // Tests assert the shape of response bodies and caught errors.
      '@typescript-eslint/no-unsafe-type-assertion': 'off',
    },
  },
  {
    // Type-aware: request-bound parameters are classes, and nothing the request fills (a decorated
    // parameter, a DTO field) contains a tenant brand at any depth, however the type is spelled.
    // Closes the slice-0 residual risk; see eslint-rules/no-brand-in-request.mjs.
    files: ['src/**/*.ts'],
    ignores: SPEC_FILES,
    plugins: { asms: { rules: { 'no-brand-in-request': noBrandInRequest } } },
    rules: { 'asms/no-brand-in-request': 'error' },
  },
  {
    // The relation-write ban covers apps/api/src; fixtures built in test/ may need the keys.
    files: ['test/**/*.ts'],
    rules: restrictSyntax(...TEST_SYNTAX_EXEMPT, 'relationWrites'),
  },
  {
    // The repository layer: Prisma lives here. Tenant repositories receive a SchoolId; they never mint one.
    files: ['src/repositories/**/*.ts'],
    rules: restrictImports({ exempt: TENANT_REPOSITORY_IMPORTS }),
  },
  {
    files: ['src/repositories/**/*.ts'],
    ignores: SPEC_FILES,
    rules: restrictSyntaxWith(REPOSITORY_LAYER),
  },
  {
    // Repository tests drive the ambient transaction directly.
    files: ['src/repositories/**/*.spec.ts'],
    rules: restrictImports({ exempt: [...TENANT_REPOSITORY_IMPORTS, 'cls'] }),
  },
  {
    // The one place a PrismaClient is built: createGuardedClient wraps it in the query guard.
    files: ['src/repositories/prisma.ts'],
    rules: restrictSyntaxWith(REPOSITORY_LAYER, 'prismaClient'),
  },
  {
    // The repositories that mint a SchoolId: the school lookup (named exception 2), the fan-out
    // (3), the session (4) and the delivery-report correlation (5), plus the platform repositories
    // (1). The queue-payload mint (3) and the session mint (4) are called from src/tenancy
    // (queue.mint.ts, school-session-resolver.ts).
    files: [
      'src/repositories/platform/**/*.ts',
      'src/repositories/session*.ts',
      'src/repositories/school-lookup.repository.ts',
    ],
    rules: restrictImports({
      exempt: REPOSITORY_IMPORTS,
      narrowed: [{ key: 'schoolIdMint', importNames: ['fromPlatformSchool'] }],
    }),
  },
  {
    files: ['src/modules/platform/**/*.ts'],
    rules: restrictImports({
      exempt: ['platformRepositories'],
      narrowed: [{ key: 'schoolIdMint', allowImportNames: ['fromPlatformSchool'] }],
    }),
  },
  {
    // Phase 3 billing (§5.1, R222): billing repositories yes, tenant repositories no.
    files: ['src/modules/platform/billing/**/*.ts'],
    rules: restrictImports({
      exempt: ['platformRepositories', 'billingRepositories'],
      narrowed: [{ key: 'schoolIdMint', allowImportNames: ['fromPlatformSchool'] }],
      extra: [TENANT_REPOSITORY_IMPORT],
    }),
  },
  {
    files: ['src/modules/access/**/*.ts'],
    rules: restrictImports({ exempt: ['scopeMint'] }),
  },
  {
    // The root module wires DatabaseModule in.
    files: ['src/app.module.ts'],
    rules: restrictImports({ exempt: ['repositoryInternals'] }),
  },
  {
    files: ['src/tenancy/**/*.ts'],
    rules: restrictImports({ exempt: TENANCY_IMPORTS }),
  },
  {
    // Phase 2 plan §4.1: the worker's processors and scheduled jobs. The only users of the queue
    // library and of queue.mint (fromQueuePayload, runAsSchool).
    files: ['src/jobs/**/*.ts'],
    rules: restrictImports({ exempt: ['bullmq', 'queueMint', 'announcementRepositories'] }),
  },
  {
    files: ANNOUNCEMENT_SITES,
    rules: restrictImports({ exempt: ['announcementRepositories'] }),
  },
  {
    // Phase 4 (§5.1): the academics module owns the set-up repositories.
    files: ['src/modules/academics/**/*.ts'],
    rules: restrictImports({ exempt: ['academicSetupRepositories'] }),
  },
  {
    // The academics suites probe the set-up repositories and (isolation, wave N) the assessment,
    // mark and certificate repositories.
    files: ['test/academics/**/*.ts'],
    rules: restrictImports({
      exempt: ['academicSetupRepositories', 'assessmentRepositories', 'certificateRepository'],
    }),
  },
  {
    // Slice 30 (§5.1): the assessments module owns the assessment and mark repositories and reads
    // the slice-29 set-up repositories (terms, class subjects, result settings) — a recorded
    // widening of their block. Its suites probe the same.
    files: ['src/modules/assessments/**/*.ts', 'test/assessments/**/*.ts'],
    rules: restrictImports({ exempt: ['academicSetupRepositories', 'assessmentRepositories'] }),
  },
  {
    // Slice 31 (§5.1): the results module owns the sheet, result and mark-reads repositories,
    // reads the slice-29 set-up repositories (terms, class subjects, result settings) — a recorded
    // widening of their block — and reads dues only through FinanceReportsService.clearance. Its
    // suites probe the same.
    files: ['src/modules/results/**/*.ts', 'test/results/**/*.ts'],
    rules: restrictImports({
      exempt: ['academicSetupRepositories', 'resultRepositories'],
      extra: [{ ...MONEY_REPOSITORY_IMPORT, message: 'src/modules/results/** reads dues only through FinanceReportsService.clearance (§5.1).' }],
    }),
  },
  {
    // The results suites also probe AssessmentRepository.sheetLockedStudents, the assessments
    // module's read of result_sheet_locks (the slice-31 review, its isolation test).
    files: ['test/results/**/*.ts'],
    rules: restrictImports({
      exempt: ['academicSetupRepositories', 'resultRepositories', 'assessmentRepositories'],
      extra: [{ ...MONEY_REPOSITORY_IMPORT, message: 'src/modules/results/** reads dues only through FinanceReportsService.clearance (§5.1).' }],
    }),
  },
  {
    // Slice 34 (§5.1): the certificates module owns its repository and reads dues only through
    // FinanceReportsService.clearance.
    files: ['src/modules/certificates/**/*.ts'],
    rules: restrictImports({ exempt: ['certificateRepository'], extra: [MONEY_REPOSITORY_IMPORT] }),
  },
  {
    // The slice-34 suites drive the repository directly.
    files: ['test/certificates/**/*.ts'],
    rules: restrictImports({ exempt: ['certificateRepository'] }),
  },
  {
    // §5.1: the monthly platform billing run (non-tenant), the only job reading the billing tables.
    files: ['src/jobs/platform-billing.ts'],
    rules: restrictImports({
      exempt: ['bullmq', 'queueMint', 'announcementRepositories', 'billingRepositories'],
      narrowed: [{ key: 'platformRepositories', ...platformRepositoriesExceptAll(BILLING_REPOSITORY_FILES) }],
    }),
  },
  {
    // §3.7: the per-school rollup writes platform_school_metrics, and nothing else of billing.
    files: ['src/jobs/school-metrics-rollup.ts'],
    rules: restrictImports({
      exempt: ['bullmq', 'queueMint', 'announcementRepositories'],
      narrowed: [
        { key: 'platformRepositories', ...platformRepositoriesExceptAll(['school-metrics.repository']) },
        {
          key: 'billingRepositories',
          ...IMPORTS.billingRepositories,
          regex: `(^|/)repositories/platform/(plan|subscription|invoice|platform-payment)\\.repository${EXT}$`,
        },
      ],
    }),
  },
  {
    // A18: the school's read of its own invoices, from the notices job.
    files: ['src/jobs/billing-notices.ts'],
    rules: restrictImports({ exempt: ['bullmq', 'queueMint', 'announcementRepositories', 'ownInvoicesRepository'] }),
  },
  {
    // A18: and from the GET /school/billing-status controller (slice 26).
    files: ['src/modules/school-settings/billing-status.controller.ts'],
    rules: restrictImports({ exempt: ['ownInvoicesRepository'] }),
  },
  {
    // The slice-14 suites seed and probe the announcement tables through their repositories.
    files: ['test/announcements/**/*.ts'],
    rules: restrictImports({ exempt: ['announcementRepositories', 'messagingDrivers', 'queueMint'] }),
  },
  {
    // The slice-26 suites seed and probe the billing tables and read a school's own invoices
    // through the repository, as the billing-status controller and the notices job do.
    files: ['test/platform-billing/**/*.ts'],
    // repositoryInternals: the isolation suite checks the five tables against the query guard's
    // NON_TENANT_MODELS, as test/guardrails does.
    rules: restrictImports({
      exempt: ['billingRepositories', 'ownInvoicesRepository', 'platformRepositories', 'repositoryInternals'],
    }),
  },
  {
    // Plan rule 0.11: the drivers are internal to messaging.
    files: ['src/messaging/**/*.ts'],
    rules: restrictImports({ exempt: ['messagingDrivers'] }),
  },
  {
    // Enqueues the jobs a transaction collected, after commit.
    files: ['src/messaging/outbox-dispatcher.ts'],
    rules: restrictImports({ exempt: ['messagingDrivers', 'bullmq'] }),
  },
  {
    files: ['src/tenancy/**/*.ts'],
    ignores: SPEC_FILES,
    rules: restrictSyntaxWith(TENANCY_LAYER, ...TENANCY_EXEMPT),
  },
  {
    // The one cast for each brand.
    files: MINT_FILES,
    rules: {
      ...restrictSyntaxWith(TENANCY_LAYER, ...TENANCY_EXEMPT, 'schoolIdCast', 'scopeCast'),
      '@typescript-eslint/no-unsafe-type-assertion': 'off',
    },
  },
  {
    // The schema guard derives its table allowlist from the query guard's model list.
    files: ['test/guardrails/**/*.ts'],
    rules: restrictImports({ exempt: ['repositoryInternals'] }),
  },
  {
    // The queue-payload resolution and runAsSchool are tested directly, as a job would call them.
    // The messaging suites replace the drivers with fakes (a real driver is never called in a
    // test), so they import the driver interfaces, and type their seeds with the client type.
    files: ['test/jobs/**/*.ts', 'test/messaging/**/*.ts', 'test/webhooks/**/*.ts'],
    rules: restrictImports({
      exempt: ['queueMint', 'messagingDrivers', 'repositoryInternals', 'platformRepositories'],
    }),
  },
  {
    // The test app's queue guard (slice 17): every test app enqueues under a test-only prefix,
    // and an add to a production-named queue is refused, so it wraps BullMQ's Queue.
    files: ['test/core/app.ts'],
    rules: restrictImports({ exempt: ['bullmq'] }),
  },
  {
    // The two tests that read jobs back from the real BullMQ library: every job-id shape (ids
    // with ':' were refused at enqueue and those jobs never ran, 2026-10-04), and every
    // OutboxDispatcher method's id and delay. Same exemptions as their folder, plus bullmq.
    files: ['test/jobs/job-ids.e2e-spec.ts', 'test/jobs/outbox-dispatcher.e2e-spec.ts'],
    rules: restrictImports({
      exempt: ['queueMint', 'messagingDrivers', 'repositoryInternals', 'platformRepositories', 'bullmq'],
    }),
  },
  {
    // Test support builds schools and tenant ids directly.
    files: ['test/support/**/*.ts'],
    rules: restrictImports({
      exempt: ['prisma', 'repositoryInternals', 'schoolIdMint', 'scopeMint'],
    }),
  },
  ...Object.entries(NAMED_EXCEPTION_SITES).map(([site, { repository, exempt = [] }]) => ({
    files: [site],
    rules: restrictImports({
      exempt,
      narrowed: [{ key: 'platformRepositories', ...platformRepositoriesExcept(repository) }],
    }),
  })),
  ...(RAW_SQL_FILES.length > 0
    ? [{ files: RAW_SQL_FILES, rules: restrictSyntaxWith(REPOSITORY_LAYER, 'raw') }]
    : []),
  prettier,
);
