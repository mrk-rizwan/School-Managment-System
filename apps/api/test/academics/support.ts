// The academics services and repositories over the real database, with the request context
// replaced by a settable stub: what session resolution would establish, set per test.
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ApiException } from '../../src/common/errors/api-exception';
import { mapDatabaseError } from '../../src/common/errors/prisma-errors';
import { EnvModule } from '../../src/config/env';
import { AccessModule } from '../../src/modules/access/access.module';
import { AcademicYearsService } from '../../src/modules/academics/academic-years.service';
import { SchoolContext } from '../../src/common/school-context';
import { ClassesService } from '../../src/modules/academics/classes.service';
import { SectionsService } from '../../src/modules/academics/sections.service';
import { SubjectsService } from '../../src/modules/academics/subjects.service';
import { AcademicTermRepository } from '../../src/repositories/academic-term.repository';
import { AcademicYearRepository } from '../../src/repositories/academic-year.repository';
import { AuditLogRepository } from '../../src/repositories/audit-log.repository';
import { ClassSubjectRepository } from '../../src/repositories/class-subject.repository';
import { ClassRepository } from '../../src/repositories/class.repository';
import { EnrolmentRepository } from '../../src/repositories/enrolment.repository';
import { ResultSettingsRepository } from '../../src/repositories/result-settings.repository';
import { SchoolCounterRepository } from '../../src/repositories/school-counter.repository';
import { SectionRepository } from '../../src/repositories/section.repository';
import { SubjectRepository } from '../../src/repositories/subject.repository';
import { RequestContextService } from '../../src/tenancy/request-context';
import type { SchoolId } from '../../src/tenancy/school-id';
import { TenancyModule } from '../../src/tenancy/tenancy.module';
import { createSchoolUser } from '../support/school-session';
import { createSchool, testDb, type TestSchool } from '../support/schools';

/** What session resolution would put in the request context. */
export interface ContextStub {
  schoolId: SchoolId | undefined;
  userId: bigint | undefined;
}

export interface Academics {
  ctx: ContextStub;
  years: AcademicYearsService;
  classes: ClassesService;
  sections: SectionsService;
  subjects: SubjectsService;
  yearRepo: AcademicYearRepository;
  classRepo: ClassRepository;
  sectionRepo: SectionRepository;
  subjectRepo: SubjectRepository;
  // Phase 4 slice 29.
  termRepo: AcademicTermRepository;
  settingsRepo: ResultSettingsRepository;
  classSubjectRepo: ClassSubjectRepository;
  close: () => Promise<void>;
}

export async function createAcademics(): Promise<Academics> {
  const ctx: ContextStub = { schoolId: undefined, userId: undefined };
  const moduleRef = await Test.createTestingModule({
    // TenancyModule's session resolver needs PermissionsService (global, from AccessModule).
    imports: [EnvModule, TenancyModule, AccessModule],
    providers: [
      SchoolContext,
      AcademicYearsService,
      ClassesService,
      SectionsService,
      SubjectsService,
      AcademicYearRepository,
      ClassRepository,
      SectionRepository,
      SubjectRepository,
      AuditLogRepository,
      EnrolmentRepository,
      SchoolCounterRepository,
      AcademicTermRepository,
      ResultSettingsRepository,
      ClassSubjectRepository,
    ],
  })
    .overrideProvider(RequestContextService)
    .useValue(ctx)
    .compile();
  await moduleRef.init();
  return {
    ctx,
    years: moduleRef.get(AcademicYearsService),
    classes: moduleRef.get(ClassesService),
    sections: moduleRef.get(SectionsService),
    subjects: moduleRef.get(SubjectsService),
    yearRepo: moduleRef.get(AcademicYearRepository),
    classRepo: moduleRef.get(ClassRepository),
    sectionRepo: moduleRef.get(SectionRepository),
    subjectRepo: moduleRef.get(SubjectRepository),
    termRepo: moduleRef.get(AcademicTermRepository),
    settingsRepo: moduleRef.get(ResultSettingsRepository),
    classSubjectRepo: moduleRef.get(ClassSubjectRepository),
    close: () => moduleRef.close(),
  };
}

/** A fresh school with a principal, set as the acting session. */
export async function actAsNewSchool(
  academics: Academics,
): Promise<TestSchool & { userId: bigint }> {
  const school = await createSchool();
  const user = await createSchoolUser(testDb(), school, { systemRole: 'principal' });
  academics.ctx.schoolId = school.id;
  academics.ctx.userId = user.userId;
  return { ...school, userId: user.userId };
}

/**
 * The refusal a call ends in, as the client would see it: an ApiException, or a database error
 * mapped by the constraint mapper. Anything else is rethrown.
 */
export async function refusal(promise: Promise<unknown>): Promise<ApiException> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof ApiException) return error;
    const mapped = mapDatabaseError(error);
    if (mapped) return mapped;
    throw error;
  }
  throw new Error('expected a refusal');
}

/** A word unique to one test. */
export const tag = (): string => randomBytes(4).toString('hex');

/** The audit rows written for one subject, oldest first. */
export const auditFor = (schoolId: bigint, subjectType: string, subjectId: bigint | string) =>
  testDb().auditLog.findMany({
    where: { schoolId, subjectType, subjectId: BigInt(subjectId) },
    orderBy: { id: 'asc' },
  });
