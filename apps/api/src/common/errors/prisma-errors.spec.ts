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

  it('maps the slice 4 and slice 6 constraints to their codes', () => {
    const unique = (index: string) =>
      adapterError('P2002', 'X', { originalCode: '23505', constraint: { index } });
    const cases: [string, ErrorCode, string][] = [
      ['staff_school_id_cnic_hash_key', ErrorCode.STAFF_CNIC_EXISTS, 'cnic'],
      ['user_roles_school_id_user_id_system_role_key', ErrorCode.ROLE_ALREADY_ASSIGNED, 'systemRole'],
      ['students_school_id_b_form_hash_key', ErrorCode.STUDENT_BFORM_EXISTS, 'bForm'],
      ['student_guardians_live_pair_key', ErrorCode.GUARDIAN_LINK_EXISTS, 'guardianId'],
      ['enrolments_section_roll_no_key', ErrorCode.ROLL_NO_TAKEN, 'rollNo'],
      ['users_school_id_student_id_key', ErrorCode.LOGIN_ALREADY_EXISTS, 'studentId'],
    ];
    for (const [index, code, field] of cases) {
      expect(mapDatabaseError(unique(index))).toMatchObject({ status: 409, code, details: { field } });
    }
    // ON UPDATE RESTRICT from classes to teacher_assignments: the class's year is frozen.
    const yearFrozen = adapterError('P2003', 'Class', {
      originalCode: '23503',
      kind: 'ForeignKeyConstraintViolation',
      constraint: { index: 'teacher_assignments_class_id_fkey' },
    });
    expect(mapDatabaseError(yearFrozen)).toMatchObject({
      status: 409,
      code: ErrorCode.CLASS_YEAR_IMMUTABLE,
    });
  });

  it('reads an exclusion constraint (23P01) from the message and maps the class-teacher one', () => {
    const exclusion = (name: string, originalCode = '23P01') =>
      adapterError('P2039', 'TeacherAssignment', {
        originalCode,
        originalMessage: `conflicting key value violates exclusion constraint "${name}"`,
        kind: 'postgres',
        detail: `Key (school_id, section_id, daterange(starts_on, ends_on, '[]'::text))=(${SECRET}) conflicts with existing key.`,
      });
    const classTeacher = exclusion('teacher_assignments_class_teacher_excl');
    expect(summariseDatabaseError(classTeacher)).toEqual({
      prismaCode: 'P2039',
      constraint: 'teacher_assignments_class_teacher_excl',
    });
    expect(mapDatabaseError(classTeacher)).toMatchObject({
      status: 409,
      code: ErrorCode.CLASS_TEACHER_EXISTS,
      details: { field: 'sectionId' },
    });
    expect(JSON.stringify(mapDatabaseError(classTeacher))).not.toContain(SECRET);
    // Another exclusion constraint is named but unmapped; the message pattern alone, without
    // SQLSTATE 23P01, is not trusted.
    expect(mapDatabaseError(exclusion('some_other_excl'))).toBeUndefined();
    expect(
      summariseDatabaseError(exclusion('teacher_assignments_class_teacher_excl', '23514'))
        ?.constraint,
    ).toBeNull();
  });

  it('leaves unmapped constraints and unnamed errors to the 500 path', () => {
    expect(mapDatabaseError(FOREIGN_KEY)).toBeUndefined();
    expect(mapDatabaseError(UNNAMED_CHECK)).toBeUndefined();
    // An inherited key is not a mapping.
    expect(
      mapDatabaseError(adapterError('P2002', 'X', { constraint: { index: 'toString' } })),
    ).toBeUndefined();
  });

  it('maps a deadlock (40P01) to 409 CONCURRENT_UPDATE, from a model call or a raw query', () => {
    // Recorded by test/core/deadlock.e2e-spec.ts: P2034 from tx.school.update, P2010 from $executeRaw.
    const cause = {
      originalCode: '40P01',
      originalMessage: 'deadlock detected',
      kind: 'TransactionWriteConflict',
    };
    for (const deadlock of [adapterError('P2034', 'School', cause), adapterError('P2010', '', cause)]) {
      expect(mapDatabaseError(deadlock)).toMatchObject({
        status: 409,
        code: ErrorCode.CONCURRENT_UPDATE,
        details: null,
      });
    }
    // Another raw-query failure is not a conflict.
    expect(
      mapDatabaseError(adapterError('P2010', '', { originalCode: '42P01', kind: 'postgres' })),
    ).toBeUndefined();
    // Not a Prisma error: a bare SQLSTATE is not trusted.
    expect(mapDatabaseError({ code: '40P01' })).toBeUndefined();
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
