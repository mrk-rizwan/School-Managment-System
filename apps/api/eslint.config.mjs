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
  // Nothing reaches a parent except through NotificationService (plan rule 0.11).
  messagingDrivers: {
    regex: '(^|/)messaging/drivers(/|$)',
    message: 'Drivers are imported only inside src/messaging/**. Call NotificationService.',
  },
};

// Exempt in the repository layer, which owns the client and the ambient transaction.
const REPOSITORY_IMPORTS = [
  'prisma',
  'repositoryInternals',
  'platformRepositories',
  'transactionHost',
  'transactionalAdapter',
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

/** The full no-restricted-imports rule minus the named exemptions (or with narrowed entries). */
function restrictImports({ exempt = [], narrowed = [] } = {}) {
  const patterns = Object.entries(IMPORTS)
    .filter(([key]) => !exempt.includes(key) && !narrowed.some((n) => n.key === key))
    .map(([, pattern]) => pattern);
  for (const { key, ...narrowing } of narrowed) {
    patterns.push({ ...IMPORTS[key], ...narrowing });
  }
  return { 'no-restricted-imports': ['error', { patterns }] };
}

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
    exempt: ['bullmq', 'queueMint'],
  },
  // Named exception 6 (contracts/slice-9.md §7.11): the only writer of platform_delivery_health
  // outside the platform module, run per school by the rollup job.
  'src/jobs/delivery-health-rollup.ts': {
    repository: 'delivery-health.repository',
    exempt: ['bullmq', 'queueMint'],
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
const BRAND = '/^(SchoolId|Scope|CreatedSchoolRow|PrincipalIssueSchoolRow)$/';
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
        'Never assert a SchoolId. It comes from the session, the school lookup or the scheduler fan-out.',
    },
  ],
  scopeCast: [
    {
      selector: `${ASSERTION} ${brandRef('"Scope"')}`,
      message: 'Never assert a Scope. PermissionsService.can() returns it.',
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
    rules: restrictImports({ exempt: REPOSITORY_IMPORTS }),
  },
  {
    files: ['src/repositories/**/*.ts'],
    ignores: SPEC_FILES,
    rules: restrictSyntaxWith(REPOSITORY_LAYER),
  },
  {
    // Repository tests drive the ambient transaction directly.
    files: ['src/repositories/**/*.spec.ts'],
    rules: restrictImports({ exempt: [...REPOSITORY_IMPORTS, 'cls'] }),
  },
  {
    // The one place a PrismaClient is built: createGuardedClient wraps it in the query guard.
    files: ['src/repositories/prisma.ts'],
    rules: restrictSyntaxWith(REPOSITORY_LAYER, 'prismaClient'),
  },
  {
    // Named exceptions 2-4 are the platform, school-lookup and session repositories, the only
    // ones that mint a SchoolId.
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
    rules: restrictImports({ exempt: ['bullmq', 'queueMint'] }),
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
