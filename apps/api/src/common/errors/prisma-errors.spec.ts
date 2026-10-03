import { ArgumentsHost, Logger } from '@nestjs/common';
import { ErrorCode } from '@asms/shared';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { mapDatabaseError, summariseDatabaseError } from './prisma-errors';

// Shapes recorded from Prisma 7.10.0 + @prisma/adapter-pg against the migrated database
// (slice 1). The row in a CHECK failure's DETAIL is replaced with a planted secret.
const SECRET = '$argon2id$v=19$m=19456,t=2,p=1$planted-secret';

class PrismaClientKnownRequestError extends Error {
  constructor(
    readonly code: string,
    readonly meta: Record<string, unknown>,
  ) {
    super(`Invalid invocation: ${SECRET}`);
  }
}

const adapterError = (code: string, modelName: string, cause: Record<string, unknown>) =>
  new PrismaClientKnownRequestError(code, {
    modelName,
    driverAdapterError: { name: 'DriverAdapterError', cause },
  });

const UNIQUE_SHORT_CODE = adapterError('P2002', 'School', {
  originalCode: '23505',
  originalMessage: 'duplicate key value violates unique constraint "schools_short_code_key"',
  kind: 'UniqueConstraintViolation',
  constraint: { index: 'schools_short_code_key' },
  table: 'schools',
});

const SHORT_CODE_IMMUTABLE = adapterError('P2039', 'School', {
  originalCode: '23514',
  originalMessage: 'short_code is immutable on schools',
  kind: 'postgres',
  code: '23514',
  severity: 'ERROR',
  message: 'short_code is immutable on schools',
  detail: 'constraint: schools_short_code_immutable',
  column: 'short_code',
});

const FEE_DUE_DAY_CHECK = adapterError('P2039', 'SchoolSettings', {
  originalCode: '23514',
  originalMessage:
    'new row for relation "school_settings" violates check constraint "school_settings_fee_due_day_check"',
  kind: 'postgres',
  code: '23514',
  severity: 'ERROR',
  message:
    'new row for relation "school_settings" violates check constraint "school_settings_fee_due_day_check"',
  detail: `Failing row contains (11, 338, 29, f, ${SECRET}).`,
});

const FOREIGN_KEY = adapterError('P2003', 'SchoolSettings', {
  originalCode: '23503',
  originalMessage:
    'insert or update on table "school_settings" violates foreign key constraint "school_settings_school_id_fkey"',
  kind: 'ForeignKeyConstraintViolation',
  constraint: { index: 'school_settings_school_id_fkey' },
});

const UNNAMED_CHECK = adapterError('P2039', 'PlatformUser', {
  originalCode: '23514',
  originalMessage: 'something else went wrong',
  detail: `Failing row contains (${SECRET}).`,
});

describe('database error mapper', () => {
  it('reads the constraint name from each recorded shape', () => {
    expect(summariseDatabaseError(UNIQUE_SHORT_CODE)).toEqual({
      prismaCode: 'P2002',
      constraint: 'schools_short_code_key',
    });
    expect(summariseDatabaseError(SHORT_CODE_IMMUTABLE)?.constraint).toBe(
      'schools_short_code_immutable',
    );
    expect(summariseDatabaseError(FEE_DUE_DAY_CHECK)?.constraint).toBe(
      'school_settings_fee_due_day_check',
    );
    expect(summariseDatabaseError(FOREIGN_KEY)?.constraint).toBe('school_settings_school_id_fkey');
    expect(summariseDatabaseError(UNNAMED_CHECK)).toEqual({ prismaCode: 'P2039', constraint: null });
  });

  it('ignores anything that is not a Prisma error', () => {
    for (const value of [new Error('x'), { code: 'ENOENT' }, null, 'P2002', { code: 2002 }]) {
      expect(summariseDatabaseError(value)).toBeUndefined();
      expect(mapDatabaseError(value)).toBeUndefined();
    }
  });

  it('maps the named constraints to their codes', () => {
    expect(mapDatabaseError(UNIQUE_SHORT_CODE)).toMatchObject({
      status: 409,
      code: ErrorCode.SCHOOL_SHORT_CODE_TAKEN,
      details: { field: 'shortCode' },
    });
    expect(mapDatabaseError(SHORT_CODE_IMMUTABLE)).toMatchObject({
      status: 409,
      code: ErrorCode.SCHOOL_SHORT_CODE_IMMUTABLE,
    });
    expect(mapDatabaseError(FEE_DUE_DAY_CHECK)).toMatchObject({
      status: 422,
      code: ErrorCode.VALIDATION_FAILED,
      details: { fields: [{ path: 'feeDueDay', code: ErrorCode.INVALID_VALUE }] },
    });
  });

  it('maps the slice 3 constraints to their codes (contracts/slice-3.md §6)', () => {
    const unique = (index: string) =>
      adapterError('P2002', 'X', { originalCode: '23505', constraint: { index } });
    const cases: [string, ErrorCode, string][] = [
      ['academic_years_school_id_name_key', ErrorCode.ACADEMIC_YEAR_NAME_TAKEN, 'name'],
      ['classes_school_id_academic_year_id_name_key', ErrorCode.CLASS_NAME_TAKEN, 'name'],
      ['sections_school_id_class_id_name_key', ErrorCode.SECTION_NAME_TAKEN, 'name'],
      ['subjects_school_id_name_key', ErrorCode.SUBJECT_NAME_TAKEN, 'name'],
      ['subjects_school_id_code_key', ErrorCode.SUBJECT_CODE_TAKEN, 'code'],
    ];
    for (const [index, code, field] of cases) {
      expect(mapDatabaseError(unique(index))).toMatchObject({ status: 409, code, details: { field } });
    }
    // The trigger forwards its name in DETAIL (as asms_forbid_class_year_change raises it).
    const yearImmutable = adapterError('P2039', 'Class', {
      originalCode: '23514',
      originalMessage: 'academic_year_id cannot change on a class that has sections',
      detail: 'constraint: classes_academic_year_immutable',
    });
    expect(mapDatabaseError(yearImmutable)).toMatchObject({
      status: 409,
      code: ErrorCode.CLASS_YEAR_IMMUTABLE,
      details: { field: 'academicYearId' },
    });
    const dates = adapterError('P2039', 'AcademicYear', {
      originalCode: '23514',
      originalMessage:
        'new row for relation "academic_years" violates check constraint "academic_years_dates_check"',
      detail: `Failing row contains (${SECRET}).`,
    });
    expect(mapDatabaseError(dates)).toMatchObject({
      status: 422,
      details: { fields: [{ path: 'endsOn', code: ErrorCode.INVALID_VALUE }] },
    });
  });

  it('leaves unmapped constraints and unnamed errors to the 500 path', () => {
    expect(mapDatabaseError(FOREIGN_KEY)).toBeUndefined();
    expect(mapDatabaseError(UNNAMED_CHECK)).toBeUndefined();
    // An inherited key is not a mapping.
    expect(
      mapDatabaseError(adapterError('P2002', 'X', { constraint: { index: 'toString' } })),
    ).toBeUndefined();
  });

  it('never carries the database detail or message into the mapped error', () => {
    expect(JSON.stringify(mapDatabaseError(FEE_DUE_DAY_CHECK))).not.toContain('Failing row');
  });
});

describe('AllExceptionsFilter with database errors', () => {
  const run = (exception: unknown) => {
    const sent: { status?: number; body?: unknown } = {};
    const res = {
      headersSent: false,
      status(code: number) {
        sent.status = code;
        return this;
      },
      json(body: unknown) {
        sent.body = body;
      },
    };
    const host = {
      switchToHttp: () => ({ getRequest: () => ({ id: 'req-1' }), getResponse: () => res }),
    } as ArgumentsHost;
    const logged: unknown[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((...args: unknown[]) => void logged.push(args));
    try {
      new AllExceptionsFilter().catch(exception, host);
    } finally {
      spy.mockRestore();
    }
    return { sent, logged: JSON.stringify(logged) };
  };

  it('answers a mapped constraint with its code and logs nothing', () => {
    const { sent, logged } = run(UNIQUE_SHORT_CODE);
    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({ error: { code: 'SCHOOL_SHORT_CODE_TAKEN' } });
    expect(logged).toBe('[]');
  });

  it('answers an unmapped one with 500 and logs only the code and constraint name', () => {
    const { sent, logged } = run(UNNAMED_CHECK);
    expect(sent.status).toBe(500);
    expect(JSON.stringify(sent.body)).not.toContain(SECRET);
    expect(logged).toContain('P2039');
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain('Failing row');

    const fk = run(FOREIGN_KEY);
    expect(fk.sent.status).toBe(500);
    expect(fk.logged).toContain('school_settings_school_id_fkey');
    expect(fk.logged).not.toContain('violates');
  });
});
