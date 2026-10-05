// R61: proves each tenant-isolation lint boundary fires. Fixtures in test/fixtures/lint are
// linted as if they lived at the virtual path given, which is what the boundaries key on.
//
// The config is type-aware, and the project service only knows files that exist on disk. So each
// fixture is linted against a TypeScript program built here, in which the virtual path holds the
// fixture's text and every other import resolves to the real project. The rules therefore see the
// real SchoolId, Scope and Prisma types, exactly as they would in src/.
import { ESLint, type Linter } from 'eslint';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as ts from 'typescript';

const apiRoot = resolve(__dirname, '../..');
const posix = (path: string) => path.replace(/\\/g, '/');

const config = ts.getParsedCommandLineOfConfigFile(
  join(apiRoot, 'tsconfig.json'),
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    },
  },
);
if (!config) throw new Error('tsconfig.json did not parse');

let previous: ts.Program | undefined;

/** A program over the real project in which `virtualPath` holds `code`. */
function programWith(virtualPath: string, code: string): ts.Program {
  const base = ts.createCompilerHost(config!.options, true);
  const isVirtual = (file: string) => posix(resolve(file)) === virtualPath;
  const host: ts.CompilerHost = {
    ...base,
    getSourceFile: (file, language, ...rest) =>
      isVirtual(file)
        ? ts.createSourceFile(file, code, language, true)
        : base.getSourceFile(file, language, ...rest),
    fileExists: (file) => isVirtual(file) || base.fileExists(file),
    readFile: (file) => (isVirtual(file) ? code : base.readFile(file)),
  };
  previous = ts.createProgram([virtualPath], config!.options, host, previous);
  return previous;
}

/** Every message, including ESLint's own warnings about ignored inline configuration. */
async function lintAllAs(fixture: string, virtualPath: string): Promise<Linter.LintMessage[]> {
  const code = readFileSync(join(apiRoot, 'test/fixtures/lint', fixture), 'utf8');
  const filePath = posix(join(apiRoot, virtualPath));
  const eslint = new ESLint({
    cwd: apiRoot,
    overrideConfig: {
      languageOptions: {
        parserOptions: { projectService: false, programs: [programWith(filePath, code)] },
      },
    },
  });
  const [result] = await eslint.lintText(code, { filePath });
  if (!result) throw new Error(`no lint result for ${fixture}`);
  return result.messages;
}

async function lintAs(fixture: string, virtualPath: string): Promise<Linter.LintMessage[]> {
  // An import fixture is linted at several virtual paths, so its relative specifier resolves at
  // some and not at others. An unresolved import types its bindings as an error type, which the
  // no-unsafe-* rules report; that is an artefact of linting at a virtual path, not a finding.
  return (await lintAllAs(fixture, virtualPath)).filter((m) => !m.message.includes('error typed'));
}

/** Lines of the fixture that follow a `// !` marker, 1-based. */
const markedLines = (fixture: string) =>
  readFileSync(join(apiRoot, 'test/fixtures/lint', fixture), 'utf8')
    .split('\n')
    .flatMap((line, i) => (line.trim() === '// !' ? [i + 2] : []));

/** The lines on which tsc reports a compile error for the fixture placed at `virtualPath`. */
function typeErrorLinesAs(fixture: string, virtualPath: string): number[] {
  const code = readFileSync(join(apiRoot, 'test/fixtures/lint', fixture), 'utf8');
  const filePath = posix(join(apiRoot, virtualPath));
  const program = programWith(filePath, code);
  const source = program.getSourceFile(filePath);
  if (!source) throw new Error(`${virtualPath} is not in the program`);
  const lines = ts
    .getPreEmitDiagnostics(program, source)
    .map((d) => source.getLineAndCharacterOfPosition(d.start ?? 0).line + 1);
  return [...new Set(lines)].sort((a, b) => a - b);
}

const rules = (messages: Linter.LintMessage[]) => messages.map((m) => m.ruleId);

describe('lint boundaries (R61)', () => {
  it.each([
    ['prisma-generated-import.ts', 'src/modules/students/students.service.ts'],
    ['prisma-package-import.ts', 'src/common/anything.ts'],
    ['prisma-package-import.ts', 'test/e2e/students.e2e-spec.ts'],
    ['platform-repository-import.ts', 'src/modules/auth/login.service.ts'],
    ['school-id-mint-import.ts', 'src/modules/auth/login.service.ts'],
    ['school-id-mint-import.ts', 'src/repositories/students.repository.ts'],
    ['school-id-mint-import.ts', 'src/modules/platform/schools.service.ts'],
    ['from-platform-school-import.ts', 'src/repositories/students.repository.ts'],
    ['from-platform-school-import.ts', 'src/modules/students/students.service.ts'],
    ['from-platform-school-import.ts', 'src/repositories/platform/school-lookup.repository.ts'],
    ['scope-mint-import.ts', 'src/modules/students/students.service.ts'],
    ['created-school-row-import.ts', 'src/modules/platform/schools.service.ts'],
    ['created-school-row-import.ts', 'src/modules/students/students.service.ts'],
    ['created-school-row-import.ts', 'src/repositories/students.repository.ts'],
    // A named exception site may import its one platform repository, no other.
    ['platform-repository-import.ts', 'src/modules/documents/staged-upload.sweep.ts'],
    ['fan-out-import.ts', 'src/modules/auth/login-spike.recorder.ts'],
  ])('refuses %s at %s', async (fixture, virtualPath) => {
    expect(rules(await lintAs(fixture, virtualPath))).toEqual(['no-restricted-imports']);
  });

  it.each([
    ['platform-repository-import.ts', 'src/modules/platform/schools.service.ts'],
    ['from-platform-school-import.ts', 'src/modules/platform/issue-login.service.ts'],
    ['school-id-mint-import.ts', 'src/repositories/platform/school-lookup.repository.ts'],
    ['school-id-mint-import.ts', 'src/repositories/session.repository.ts'],
    ['scope-mint-import.ts', 'src/modules/access/permissions.service.ts'],
    ['created-school-row-import.ts', 'src/repositories/platform/school.repository.ts'],
    ['legitimate-repository.ts', 'src/repositories/students.repository.ts'],
    ['app-module-import.ts', 'src/app.module.ts'],
    ['fan-out-import.ts', 'src/modules/documents/staged-upload.sweep.ts'],
  ])('allows %s at %s', async (fixture, virtualPath) => {
    expect(await lintAs(fixture, virtualPath)).toEqual([]);
  });

  // Phase 3 (phase-3-financial.md §5.1, R222): the billing repositories, the school's own-invoice
  // read and the billing module's ban on tenant repositories. The targets arrive with slice 26;
  // the boundaries match the import specifier, so they hold before the files exist.
  it.each([
    ['billing-repository-import.ts', 'src/modules/platform/schools/schools.service.ts'],
    ['billing-repository-import.ts', 'src/modules/fees/fee-heads.service.ts'],
    ['billing-repository-import.ts', 'src/jobs/charge-generate.ts'],
    ['billing-repository-import.ts', 'src/jobs/school-metrics-rollup.ts'],
    ['metrics-repository-import.ts', 'src/jobs/billing-notices.ts'],
    ['tenant-repository-import.ts', 'src/modules/platform/billing/plans.service.ts'],
    ['own-invoices-import.ts', 'src/modules/fees/fee-heads.service.ts'],
    ['own-invoices-import.ts', 'src/modules/platform/billing/plans.service.ts'],
    ['own-invoices-import.ts', 'src/jobs/platform-billing.ts'],
  ])('refuses %s at %s (Phase 3 billing)', async (fixture, virtualPath) => {
    // A billing path also matches the platform-repositories pattern: one report per pattern.
    expect([...new Set(rules(await lintAs(fixture, virtualPath)))]).toEqual(['no-restricted-imports']);
  });

  it.each([
    ['billing-repository-import.ts', 'src/modules/platform/billing/plans.service.ts'],
    ['billing-repository-import.ts', 'src/jobs/platform-billing.ts'],
    ['metrics-repository-import.ts', 'src/jobs/school-metrics-rollup.ts'],
    ['metrics-repository-import.ts', 'src/modules/platform/billing/plans.service.ts'],
    ['own-invoices-import.ts', 'src/jobs/billing-notices.ts'],
    ['own-invoices-import.ts', 'src/modules/school-settings/billing-status.controller.ts'],
    ['tenant-repository-import.ts', 'src/modules/fees/fee-heads.service.ts'],
  ])('allows %s at %s (Phase 3 billing)', async (fixture, virtualPath) => {
    expect(await lintAs(fixture, virtualPath)).toEqual([]);
  });

  it('refuses a mint import written with a file extension', async () => {
    const messages = await lintAs(
      'mint-extension-imports.ts',
      'src/modules/students/students.service.ts',
    );
    expect(rules(messages)).toEqual(['no-restricted-imports', 'no-restricted-imports']);
  });

  it.each([
    ['src/modules/students/students.service.ts'],
    ['src/common/anything.ts'],
    ['src/config/anything.ts'],
    ['test/core/students.e2e-spec.ts'],
  ])(
    'refuses the guarded client, DatabaseModule and the guard outside the layer at %s',
    async (virtualPath) => {
      const messages = await lintAs('repository-internals-import.ts', virtualPath);
      expect(rules(messages)).toEqual(Array(4).fill('no-restricted-imports'));
    },
  );

  it('refuses dynamic import() in src, not in tests', async () => {
    expect(
      rules(await lintAs('dynamic-import.ts', 'src/modules/students/students.service.ts')),
    ).toEqual(['no-restricted-syntax']);
    expect(await lintAs('dynamic-import.ts', 'test/support/anything.ts')).toEqual([]);
  });

  it('refuses connect, connectOrCreate, set and disconnect as object keys in src', async () => {
    const messages = await lintAs('relation-writes.ts', 'src/repositories/students.repository.ts');
    expect(rules(messages)).toEqual(Array(4).fill('no-restricted-syntax'));
  });

  it('refuses $queryRawUnsafe and $executeRawUnsafe in dot, bracket, template and destructured form', async () => {
    const messages = await lintAs('raw-unsafe.ts', 'src/modules/students/students.service.ts');
    expect(new Set(rules(messages))).toEqual(new Set(['no-restricted-syntax']));
    // Dot, bracket, template, destructured, destructured by key, and the bare name.
    expect([...new Set(messages.map((m) => m.line))]).toEqual([7, 8, 9, 10, 11, 12]);
  });

  it('refuses tagged $queryRaw outside the listed files', async () => {
    const messages = await lintAs('raw-tagged.ts', 'src/repositories/students.repository.ts');
    expect(rules(messages)).toEqual(['no-restricted-syntax']);
  });

  it('refuses every form of SchoolId assertion', async () => {
    const messages = await lintAs(
      'school-id-cast.ts',
      'src/modules/students/students.controller.ts',
    );
    // Four casts, one of them also a double assertion; each also narrows (type-aware rule).
    expect(rules(messages).filter((r) => r === 'no-restricted-syntax')).toHaveLength(5);
    expect(
      rules(messages).filter((r) => r === '@typescript-eslint/no-unsafe-type-assertion'),
    ).toHaveLength(4);
  });

  it('refuses a Scope assertion', async () => {
    expect(
      rules(await lintAs('scope-cast.ts', 'src/modules/students/students.service.ts')),
    ).toEqual([
      '@typescript-eslint/no-unsafe-type-assertion',
      'no-restricted-syntax',
      'no-restricted-syntax',
    ]);
  });

  it('refuses every type-correct way to forge a brand, and nothing else in the fixture', async () => {
    const fixture = 'brand-forgery.ts';
    const messages = await lintAs(fixture, 'src/modules/students/students.controller.ts');
    // The decorated parameter typed { schoolId: SchoolId } is also caught by the type-aware rule.
    expect(new Set(rules(messages))).toEqual(
      new Set([
        'no-restricted-syntax',
        '@typescript-eslint/no-unsafe-type-assertion',
        'asms/no-brand-in-request',
      ]),
    );
    expect([...new Set(messages.map((m) => m.line))]).toEqual(markedLines(fixture));
  });

  it('refuses a narrowing assertion to a brand under any name, and a generic cast helper', async () => {
    const messages = await lintAs(
      'alias-assertion.ts',
      'src/modules/students/students.controller.ts',
    );
    expect(messages.map((m) => [m.line, m.ruleId])).toEqual([
      [3, 'no-restricted-syntax'],
      [6, 'no-restricted-syntax'],
      [12, '@typescript-eslint/no-unsafe-type-assertion'],
      [13, '@typescript-eslint/no-unsafe-type-assertion'],
      [14, '@typescript-eslint/no-unsafe-type-assertion'],
      [15, '@typescript-eslint/no-unsafe-type-assertion'],
      [20, '@typescript-eslint/no-unsafe-type-assertion'],
    ]);
  });

  it('allows the brand casts only in the two mint files', async () => {
    expect(await lintAs('mint-cast.ts', 'src/tenancy/school-id.mint.ts')).toEqual([]);
    expect(rules(await lintAs('mint-cast.ts', 'src/tenancy/request-context.ts'))).toEqual([
      '@typescript-eslint/no-unsafe-type-assertion',
      'no-restricted-syntax',
    ]);
  });

  it('refuses an import() type', async () => {
    for (const at of ['src/modules/students/students.service.ts', 'src/tenancy/anything.ts']) {
      expect(rules(await lintAs('type-import.ts', at))).toEqual(
        Array(2).fill('no-restricted-syntax'),
      );
    }
  });

  it('ignores eslint-disable and eslint config comments: the boundary still fires', async () => {
    const messages = await lintAllAs(
      'inline-disable.ts',
      'src/modules/students/students.service.ts',
    );
    expect(messages.filter((m) => m.severity === 2).map((m) => [m.line, m.ruleId])).toEqual([
      [2, 'no-restricted-imports'],
      [4, 'no-restricted-imports'],
    ]);
    expect(messages.filter((m) => m.severity === 1).map((m) => m.message)).toEqual(
      Array(3).fill(expect.stringContaining('noInlineConfig')),
    );
  });

  it('refuses re-exports in src/tenancy and src/repositories', async () => {
    expect(rules(await lintAs('tenancy-re-exports.ts', 'src/tenancy/index.ts'))).toEqual(
      Array(4).fill('no-restricted-syntax'),
    );
    expect(rules(await lintAs('repository-re-exports.ts', 'src/repositories/index.ts'))).toEqual(
      Array(2).fill('no-restricted-syntax'),
    );
  });

  it('refuses nestjs-cls outside src/tenancy', async () => {
    for (const at of [
      'src/modules/students/students.service.ts',
      'src/repositories/students.repository.ts',
    ]) {
      expect(rules(await lintAs('cls-import.ts', at))).toEqual(['no-restricted-imports']);
    }
    expect(await lintAs('cls-import.ts', 'src/tenancy/session-context.ts')).toEqual([]);
  });

  it('refuses the session establisher outside src/tenancy, whatever the call form', async () => {
    const messages = await lintAs(
      'establish-session-call.ts',
      'src/modules/auth/session.service.ts',
    );
    expect(messages.map((m) => [m.line, m.ruleId])).toEqual([
      [1, 'no-restricted-imports'],
      [5, 'no-restricted-syntax'],
      [6, 'no-restricted-syntax'],
    ]);
    // Session resolution lives in src/tenancy: the import is allowed there.
    const inTenancy = await lintAs(
      'establish-session-call.ts',
      'src/tenancy/session-resolution.ts',
    );
    expect(rules(inTenancy)).not.toContain('no-restricted-imports');
  });

  it('rejects a tenant that is not a SchoolId at compile time, and types the context read', () => {
    const fixture = 'request-context-poisoning.ts';
    expect(typeErrorLinesAs(fixture, 'src/tenancy/session-resolution.ts')).toEqual(
      markedLines(fixture),
    );
  });

  it('fromPlatformSchool takes only the row SchoolRepository.create returns, at compile time', () => {
    const fixture = 'from-platform-school-row.ts';
    expect(typeErrorLinesAs(fixture, 'src/modules/platform/issue-login.service.ts')).toEqual(
      markedLines(fixture),
    );
  });

  it('allows only @Transactional() and Propagation outside the repository layer', async () => {
    const messages = await lintAs(
      'transaction-imports.ts',
      'src/modules/students/students.service.ts',
    );
    expect(messages.map((m) => [m.line, m.ruleId])).toEqual([
      [2, 'no-restricted-imports'],
      [3, 'no-restricted-imports'],
    ]);
    for (const at of ['src/repositories/students.repository.ts', 'src/tenancy/tenancy.module.ts']) {
      expect(await lintAs('transaction-imports.ts', at)).toEqual([]);
    }
  });

  it('refuses constructing or importing the PrismaClient class outside src/repositories/prisma.ts', async () => {
    const messages = await lintAs(
      'new-prisma-client.ts',
      'src/repositories/students.repository.ts',
    );
    expect(messages.map((m) => [m.line, m.ruleId])).toEqual([
      [1, 'no-restricted-syntax'],
      [3, 'no-restricted-syntax'],
      [8, 'no-restricted-syntax'],
      [9, 'no-restricted-syntax'],
      [9, 'no-restricted-syntax'],
    ]);
    expect(await lintAs('new-prisma-client.ts', 'src/repositories/prisma.ts')).toEqual([]);
  });

  it('refuses computed member access, $-prefixed keys and Reflect in src/repositories', async () => {
    const messages = await lintAs('computed-member.ts', 'src/repositories/students.repository.ts');
    expect(messages.map((m) => [m.line, m.ruleId])).toEqual([
      [4, 'no-restricted-syntax'],
      [5, 'no-restricted-syntax'],
      [6, 'no-restricted-syntax'],
      [7, 'no-restricted-syntax'],
    ]);
  });

  it('refuses an `any` from the request flowing into a SchoolId (type-aware rules)', async () => {
    const messages = await lintAs(
      'unsafe-request-body.ts',
      'src/modules/students/students.controller.ts',
    );
    expect(messages.map((m) => [m.line, m.ruleId])).toEqual([
      [10, '@typescript-eslint/no-unsafe-argument'],
      [10, '@typescript-eslint/no-unsafe-member-access'],
      [14, '@typescript-eslint/no-unsafe-assignment'],
      [19, '@typescript-eslint/no-unsafe-return'],
      [19, '@typescript-eslint/no-unsafe-member-access'],
      [23, '@typescript-eslint/no-unsafe-argument'],
      [23, '@typescript-eslint/no-unsafe-call'],
      [23, '@typescript-eslint/no-unsafe-member-access'],
    ]);
  });

  it('refuses request-bound types that are not classes or that resolve to a brand, however spelled', async () => {
    const fixture = 'request-brand.ts';
    const messages = await lintAs(fixture, 'src/modules/students/students.controller.ts');
    expect(new Set(rules(messages))).toEqual(new Set(['asms/no-brand-in-request']));
    expect([...new Set(messages.map((m) => m.line))]).toEqual(markedLines(fixture));
    const byLine = (line: number) => messages.filter((m) => m.line === line).map((m) => m.message);
    const has = (...parts: string[]): unknown[] =>
      parts.map((part): unknown => expect.stringContaining(part));
    const [inner, nested, scopes, union, body, query, nestedParam, , , params, session] =
      markedLines(fixture);
    expect(byLine(inner!)).toEqual(has('A DTO field contains the SchoolId brand (at id)'));
    expect(byLine(nested!)).toEqual(has('A DTO field contains the SchoolId brand (at inner.id)'));
    expect(byLine(scopes!)).toEqual(has('A DTO field contains the Scope brand (at scopes[])'));
    expect(byLine(union!)).toEqual(has('A DTO field contains the Scope brand (at value)'));
    expect(byLine(body!)).toEqual(has('not an interface'));
    expect(byLine(query!)).toEqual(has('not a type alias'));
    expect(byLine(nestedParam!)).toEqual(has('parameter contains the SchoolId brand'));
    expect(byLine(params!)).toEqual(has('not an intersection', 'contains the SchoolId brand'));
    expect(byLine(session!)).toEqual(has('not an object type', 'contains the SchoolId brand'));
  });

  it('allows class DTOs, the session decorators, IdParam, a keyed @Param and @Req/@Res', async () => {
    expect(
      await lintAs('request-legitimate.ts', 'src/modules/students/students.controller.ts'),
    ).toEqual([]);
  });

  describe('Phase 2 boundaries (plan rule 0.11, §4.1)', () => {
    /** The rules fired, and that one of them is the boundary named by `text`. */
    const refusedFor = async (fixture: string, at: string, text: string) => {
      const messages = await lintAs(fixture, at);
      expect(new Set(rules(messages))).toEqual(new Set(['no-restricted-imports']));
      expect(messages.map((m) => m.message)).toEqual(
        expect.arrayContaining([expect.stringContaining(text)]),
      );
    };

    it.each([
      'src/modules/students/students.service.ts',
      'src/messaging/notification.service.ts',
      'src/webhooks/waha.controller.ts',
      'src/tenancy/queue.mint.ts',
    ])('refuses bullmq at %s', async (at) => {
      await refusedFor('bullmq-import.ts', at, 'bullmq is used only in src/jobs/**');
    });

    it.each(['src/jobs/messaging.processor.ts', 'src/messaging/outbox-dispatcher.ts'])(
      'allows bullmq at %s',
      async (at) => {
        expect(await lintAs('bullmq-import.ts', at)).toEqual([]);
      },
    );

    it.each([
      'src/modules/students/students.service.ts',
      'src/messaging/notification.service.ts',
      'src/webhooks/waha.controller.ts',
      'src/tenancy/tenancy.module.ts',
    ])('refuses queue.mint at %s', async (at) => {
      await refusedFor('queue-mint-import.ts', at, 'queue.mint is imported only by src/jobs/**');
    });

    it('allows queue.mint in src/jobs', async () => {
      expect(await lintAs('queue-mint-import.ts', 'src/jobs/messaging.processor.ts')).toEqual([]);
    });

    it.each([
      'src/tenancy/tenancy.module.ts',
      'src/tenancy/school-id.mint.ts',
      'src/jobs/messaging.processor.ts',
      'src/modules/platform/schools.service.ts',
      'src/repositories/school-lookup.repository.ts',
    ])('refuses school-by-id.repository at %s', async (at) => {
      await refusedFor(
        'school-by-id-import.ts',
        at,
        'SchoolByIdRepository is imported only by src/tenancy/queue.mint.ts',
      );
    });

    it('allows school-by-id.repository in queue.mint.ts, with the tenancy exemptions kept', async () => {
      expect(await lintAs('school-by-id-import.ts', 'src/tenancy/queue.mint.ts')).toEqual([]);
      expect(await lintAs('cls-import.ts', 'src/tenancy/queue.mint.ts')).toEqual([]);
      expect(await lintAs('school-id-mint-import.ts', 'src/tenancy/queue.mint.ts')).toEqual([]);
      // Any other platform repository stays refused there.
      expect(rules(await lintAs('fan-out-import.ts', 'src/tenancy/queue.mint.ts'))).toEqual([
        'no-restricted-imports',
      ]);
    });

    it.each([
      'src/modules/attendance/attendance.service.ts',
      'src/jobs/messaging.processor.ts',
      'src/webhooks/waha.controller.ts',
    ])('refuses a messaging driver at %s', async (at) => {
      await refusedFor('messaging-driver-import.ts', at, 'Drivers are imported only inside src/messaging/**');
    });

    it.each(['src/messaging/notification.service.ts', 'src/messaging/outbox-dispatcher.ts'])(
      'allows a messaging driver at %s',
      async (at) => {
        expect(await lintAs('messaging-driver-import.ts', at)).toEqual([]);
      },
    );

    // contracts/slice-14.md §1.1 (R114): the platform never reads announcements or messages.
    it.each([
      'src/modules/platform/messaging/delivery-health.service.ts',
      'src/modules/platform/schools/schools.service.ts',
      'src/modules/students/students.service.ts',
      'src/messaging/notification.service.ts',
    ])('refuses an announcement or inbox repository at %s', async (at) => {
      await refusedFor(
        'announcement-repository-import.ts',
        at,
        'Announcement and inbox repositories are imported only from',
      );
    });

    it.each([
      'src/modules/announcements/announcements.service.ts',
      'src/modules/me/inbox.service.ts',
      'src/modules/calendar/holidays.service.ts',
      'src/jobs/job-runner.ts',
      'src/repositories/announcement.repository.ts',
    ])('allows an announcement or inbox repository at %s', async (at) => {
      expect(await lintAs('announcement-repository-import.ts', at)).toEqual([]);
    });
  });

  it('refuses explicit any', async () => {
    expect(
      rules(await lintAs('explicit-any.ts', 'src/modules/students/students.service.ts')),
    ).toEqual(['@typescript-eslint/no-explicit-any']);
  });
});
