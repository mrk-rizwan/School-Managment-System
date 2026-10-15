import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { notFound } from '../../../common/errors/api-exception';
import { toPage, type Page } from '../../../common/pagination';
import {
  SupportReadsRepository,
  type SupportRead,
} from '../../../repositories/platform/support-reads.repository';
import { SupportSessionRepository } from '../../../repositories/platform/support-session.repository';
import type { SchoolId } from '../../../tenancy/school-id';
import { schoolIdFromSupportSession } from '../../../tenancy/school-id.mint';
import { SupportReadContext } from '../../../tenancy/support-read-context';
import { toDateString } from '../../academics/academics.shared';
import type { ListAuditLogQueryDto } from '../../audit/audit.dto';
import { auditFilterOf, toAuditEntryDto } from '../../audit/audit.service';
import type { AuditEntryDto } from '../../audit/audit.dto';
import { SupportSessionsService } from './support-sessions.service';
import type {
  SupportChargeDto,
  SupportPaymentDto,
  SupportSchoolSettingsDto,
  SupportStudentDto,
  SupportStudentsQueryDto,
  SupportStudentSummaryDto,
} from './support.dto';
import type { PageQueryDto } from '../../../common/pagination';
import type { SupportEnrolmentRow, SupportStudentSummaryRow } from '../../../repositories/platform/support-reads.repository';

// Phase 5 slice 45, the six support views (contracts/slice-45.md §2.2; rule 35, R350, R351). Each
// read runs in SupportReadContext (READ ONLY + the guard's `support` flag), re-reads the session
// there (open, unexpired, the caller's own) and mints the SchoolId from it; after that transaction,
// `support.read` is written to both audit logs with the subject ids. A failed audit write serves
// nothing.

/** The session a view reads through, and who asks. */
export interface SupportCaller {
  platformUserId: bigint;
  sessionId: bigint;
}

const summaryDto = (row: SupportStudentSummaryRow): SupportStudentSummaryDto => ({
  id: row.id.toString(),
  admissionNo: row.admissionNo,
  fullName: row.fullName,
  status: row.status,
  current: row.current === null ? null : enrolmentDto(row.current),
});

const enrolmentDto = (row: SupportEnrolmentRow) => ({ ...row });

/** Subject ids as audit metadata: comma-separated strings (the logs' metadata holds no arrays). */
const subjectsMetadata = (subjects: Record<string, readonly bigint[]>): Record<string, string> =>
  Object.fromEntries(Object.entries(subjects).map(([key, ids]) => [key, ids.map(String).join(',')]));

@Injectable()
export class SupportViewsService {
  constructor(
    private readonly context: SupportReadContext,
    private readonly sessions: SupportSessionRepository,
    private readonly reads: SupportReadsRepository,
    private readonly support: SupportSessionsService,
  ) {}

  async settings(caller: SupportCaller): Promise<SupportSchoolSettingsDto> {
    const row = await this.read(caller, 'settings', (schoolId) => this.reads.settings(schoolId));
    if (row === null) throw notFound();
    return { ...row, schoolId: row.schoolId.toString() };
  }

  async students(caller: SupportCaller, query: SupportStudentsQueryDto): Promise<Page<SupportStudentSummaryDto>> {
    const { rows, total } = await this.read(caller, 'students', (schoolId) =>
      this.reads.studentsByAdmissionNo(schoolId, query.admissionNo, skipOf(query), query.limit),
    );
    return toPage(rows.map(summaryDto), query, total);
  }

  async student(caller: SupportCaller, studentId: bigint): Promise<SupportStudentDto> {
    const row = await this.read(caller, 'student', (schoolId) => this.reads.student(schoolId, studentId));
    if (row === null) throw notFound();
    return {
      ...summaryDto(row),
      admittedOn: toDateString(row.admittedOn),
      guardians: row.guardians.map((g) => ({ ...g, id: g.id.toString() })),
    };
  }

  async charges(caller: SupportCaller, studentId: bigint, query: PageQueryDto): Promise<Page<SupportChargeDto>> {
    const page = await this.read(caller, 'charges', async (schoolId) =>
      (await this.reads.studentExists(schoolId, studentId))
        ? this.reads.charges(schoolId, studentId, skipOf(query), query.limit)
        : { value: null, subjects: {} },
    );
    if (page === null) throw notFound();
    return toPage(
      page.rows.map((c) => ({
        id: c.id.toString(),
        description: c.description,
        feeHeadName: c.feeHeadName,
        period: c.period,
        dueOn: toDateString(c.dueOn),
        amount: c.amount,
        paid: c.allocatedAmount,
        credited: c.creditedAmount,
        outstanding: Math.max(0, c.amount - c.allocatedAmount - c.creditedAmount),
        status: c.status,
      })),
      query,
      page.total,
    );
  }

  async payments(caller: SupportCaller, studentId: bigint, query: PageQueryDto): Promise<Page<SupportPaymentDto>> {
    const page = await this.read(caller, 'payments', async (schoolId) =>
      (await this.reads.studentExists(schoolId, studentId))
        ? this.reads.payments(schoolId, studentId, skipOf(query), query.limit)
        : { value: null, subjects: {} },
    );
    if (page === null) throw notFound();
    return toPage(
      page.rows.map((p) => ({ ...p, id: p.id.toString(), receivedOn: toDateString(p.receivedOn) })),
      query,
      page.total,
    );
  }

  /** The school's audit log, with slice 46's filters, exclusions and masking. */
  async auditLog(caller: SupportCaller, query: ListAuditLogQueryDto): Promise<Page<AuditEntryDto>> {
    const { rows, total } = await this.read(caller, 'audit_log', async (schoolId) => {
      const filter = auditFilterOf(query, await this.reads.timezone(schoolId));
      return this.reads.auditLog(schoolId, filter, skipOf(query), query.limit);
    });
    return toPage(rows.map(toAuditEntryDto), query, total);
  }

  /**
   * One support read: READ ONLY with the `support` flag, the session re-read and the SchoolId minted
   * inside it; then both audit rows. R352: a session that ended since the guard ran answers 403.
   */
  private async read<T>(
    caller: SupportCaller,
    view: string,
    fn: (schoolId: SchoolId) => Promise<SupportRead<T>>,
  ): Promise<T> {
    const { schoolId, result } = await this.context.run(async () => {
      const row = await this.sessions.findOpenOwned(caller.sessionId, caller.platformUserId, new Date());
      if (row === null) {
        await this.support.assertOpenOwned(caller.platformUserId, caller.sessionId);
        throw notFound();
      }
      const minted = schoolIdFromSupportSession(row);
      return { schoolId: minted, result: await fn(minted) };
    });
    await this.recordRead(schoolId, caller, view, result.subjects);
    return result.value;
  }

  @Transactional()
  private async recordRead(
    schoolId: SchoolId,
    caller: SupportCaller,
    view: string,
    subjects: Record<string, readonly bigint[]>,
  ): Promise<void> {
    await this.sessions.recordBoth(schoolId, {
      platformUserId: caller.platformUserId,
      action: 'support.read',
      sessionId: caller.sessionId,
      metadata: { view, ...subjectsMetadata(subjects) },
    });
  }
}

const skipOf = (query: PageQueryDto): number => (query.page - 1) * query.limit;
