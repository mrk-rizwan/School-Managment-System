import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { ConcessionKind, ConcessionStatus } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// Concessions and their heads (tenant tables concessions, concession_heads; phase-3-financial.md
// §4, R182, R183, R232, R253). Never deleted; `requested -> approved | rejected`, `approved ->
// ended`; the terms are frozen at insert and a decision once made. "One live concession per
// student per year per head" is decided under the student's row lock (lockStudent). Finance keys
// are school-wide (plan rule 0.24): no method takes a Scope. Raw SQL only for that row lock;
// listed in RAW_SQL_FILES (test/charges/isolation.e2e-spec.ts).

export interface ConcessionRecord {
  id: bigint;
  studentId: bigint;
  academicYearId: bigint;
  enrolmentId: bigint;
  kind: ConcessionKind;
  value: number;
  effectiveFrom: string;
  reason: string;
  status: ConcessionStatus;
  requestedBy: bigint;
  requestedAt: Date;
  decidedBy: bigint | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  selfApproved: boolean;
  endedAt: Date | null;
  endedBy: bigint | null;
  endReason: string | null;
  heads: { feeHeadId: bigint; feeHead: { name: string; concessionEligible: boolean } }[];
  enrolment: { class: { name: string }; student: { fullName: string } };
  requestedByUser: { staff: { fullName: string } | null };
}

const SELECT = {
  id: true,
  studentId: true,
  academicYearId: true,
  enrolmentId: true,
  kind: true,
  value: true,
  effectiveFrom: true,
  reason: true,
  status: true,
  requestedBy: true,
  requestedAt: true,
  decidedBy: true,
  decidedAt: true,
  decisionReason: true,
  selfApproved: true,
  endedAt: true,
  endedBy: true,
  endReason: true,
} satisfies Prisma.ConcessionSelect;

type ConcessionRow = Omit<ConcessionRecord, 'heads' | 'enrolment' | 'requestedByUser'>;

export type ConcessionSort = '-requestedAt' | 'requestedAt';

/** The live (requested or approved) statuses: at most one per student, year and head. */
const LIVE: ConcessionStatus[] = ['requested', 'approved'];

@Injectable()
export class ConcessionRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async list(
    schoolId: SchoolId,
    query: {
      status?: ConcessionStatus;
      studentId?: bigint;
      academicYearId?: bigint;
      sort: ConcessionSort;
      skip: number;
      take: number;
    },
  ): Promise<{ rows: ConcessionRecord[]; total: number }> {
    const where: Prisma.ConcessionWhereInput = {
      schoolId,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.studentId === undefined ? {} : { studentId: query.studentId }),
      ...(query.academicYearId === undefined ? {} : { academicYearId: query.academicYearId }),
    };
    const direction = query.sort === 'requestedAt' ? 'asc' : 'desc';
    const rows = await this.txHost.tx.concession.findMany({
      where,
      select: SELECT,
      orderBy: [{ requestedAt: direction }, { id: direction }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.concession.count({ where });
    return { rows: await this.named(schoolId, rows), total };
  }

  async findById(schoolId: SchoolId, id: bigint): Promise<ConcessionRecord | null> {
    const row = await this.txHost.tx.concession.findFirst({ where: { schoolId, id }, select: SELECT });
    return row ? ((await this.named(schoolId, [row]))[0] ?? null) : null;
  }

  /** Every concession of a student's year, newest first (the statement; bounded by heads). */
  async forStudentYear(schoolId: SchoolId, studentId: bigint, academicYearId: bigint): Promise<ConcessionRecord[]> {
    return this.named(schoolId, await this.txHost.tx.concession.findMany({
      where: { schoolId, studentId, academicYearId },
      select: SELECT,
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    }));
  }

  /**
   * Heads, class, student and requester names, read in sequential statements (Prisma loads sibling
   * relations of one select concurrently; statements must not overlap inside a transaction).
   */
  private async named(schoolId: SchoolId, rows: readonly ConcessionRow[]): Promise<ConcessionRecord[]> {
    if (rows.length === 0) return [];
    const uniq = (ids: bigint[]) => [...new Set(ids)];
    const links = await this.txHost.tx.concessionHead.findMany({
      where: { schoolId, concessionId: { in: rows.map((r) => r.id) } },
      select: { concessionId: true, feeHeadId: true },
      orderBy: { feeHeadId: 'asc' },
    });
    const heads = await this.txHost.tx.feeHead.findMany({
      where: { schoolId, id: { in: uniq(links.map((l) => l.feeHeadId)) } },
      select: { id: true, name: true, concessionEligible: true },
    });
    const enrolments = await this.txHost.tx.enrolment.findMany({
      where: { schoolId, id: { in: uniq(rows.map((r) => r.enrolmentId)) } },
      select: { id: true, classId: true },
    });
    const classes = await this.txHost.tx.class.findMany({
      where: { schoolId, id: { in: uniq(enrolments.map((e) => e.classId)) } },
      select: { id: true, name: true },
    });
    const students = await this.txHost.tx.student.findMany({
      where: { schoolId, id: { in: uniq(rows.map((r) => r.studentId)) } },
      select: { id: true, fullName: true },
    });
    const users = await this.txHost.tx.user.findMany({
      where: { schoolId, id: { in: uniq(rows.map((r) => r.requestedBy)) } },
      select: { id: true, staffId: true },
    });
    const staff = await this.txHost.tx.staff.findMany({
      where: { schoolId, id: { in: uniq(users.flatMap((u) => (u.staffId === null ? [] : [u.staffId]))) } },
      select: { id: true, fullName: true },
    });
    const head = new Map(heads.map((h) => [h.id, h]));
    const classOf = new Map(enrolments.map((e) => [e.id, e.classId]));
    const className = new Map(classes.map((c) => [c.id, c.name]));
    const studentName = new Map(students.map((x) => [x.id, x.fullName]));
    const staffOf = new Map(users.map((u) => [u.id, u.staffId]));
    const staffName = new Map(staff.map((x) => [x.id, x.fullName]));
    return rows.map((row) => {
      const classId = classOf.get(row.enrolmentId);
      const staffId = staffOf.get(row.requestedBy) ?? null;
      const requester = staffId === null ? undefined : staffName.get(staffId);
      return {
        ...row,
        heads: links
          .filter((l) => l.concessionId === row.id)
          .map((l) => ({
            feeHeadId: l.feeHeadId,
            feeHead: { name: head.get(l.feeHeadId)?.name ?? '', concessionEligible: head.get(l.feeHeadId)?.concessionEligible ?? false },
          })),
        enrolment: {
          class: { name: (classId === undefined ? undefined : className.get(classId)) ?? '' },
          student: { fullName: studentName.get(row.studentId) ?? '' },
        },
        requestedByUser: { staff: requester === undefined ? null : { fullName: requester } },
      };
    });
  }

  /**
   * The student's row lock (§4: one live concession per student per year per head is a service
   * check under `SELECT … FOR UPDATE` on the student row). False when there is no such student.
   */
  async lockStudent(schoolId: SchoolId, studentId: bigint): Promise<boolean> {
    const rows = await this.txHost.tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM students WHERE school_id = ${schoolId} AND id = ${studentId} FOR UPDATE`;
    return rows.length === 1;
  }

  /** The live concession naming one of `feeHeadIds` for this student's year, if any. */
  findLiveOnHeads(
    schoolId: SchoolId,
    studentId: bigint,
    academicYearId: bigint,
    feeHeadIds: readonly bigint[],
  ): Promise<{ concessionId: bigint; feeHeadId: bigint } | null> {
    return this.txHost.tx.concessionHead
      .findFirst({
        where: {
          schoolId,
          feeHeadId: { in: [...feeHeadIds] },
          concession: { schoolId, studentId, academicYearId, status: { in: LIVE } },
        },
        select: { concessionId: true, feeHeadId: true },
        orderBy: { id: 'asc' },
      })
      .then((row) => row ?? null);
  }

  /** The approved concession on `feeHeadId` in force for `period` (R182), if any. */
  approvedFor(
    schoolId: SchoolId,
    studentId: bigint,
    academicYearId: bigint,
    feeHeadId: bigint,
    period: string,
  ): Promise<{ id: bigint; kind: ConcessionKind; value: number } | null> {
    return this.txHost.tx.concession.findFirst({
      where: {
        schoolId,
        studentId,
        academicYearId,
        status: 'approved',
        effectiveFrom: { lte: period },
        heads: { some: { schoolId, feeHeadId } },
      },
      select: { id: true, kind: true, value: true },
      orderBy: { id: 'asc' },
    });
  }

  /** Every approved concession of these students in the year (a campaign's preview). */
  approvedForStudents(
    schoolId: SchoolId,
    academicYearId: bigint,
    feeHeadId: bigint,
    studentIds: readonly bigint[],
    period: string,
  ): Promise<{ studentId: bigint; kind: ConcessionKind; value: number }[]> {
    if (studentIds.length === 0) return Promise.resolve([]);
    return this.txHost.tx.concession.findMany({
      where: {
        schoolId,
        academicYearId,
        studentId: { in: [...studentIds] },
        status: 'approved',
        effectiveFrom: { lte: period },
        heads: { some: { schoolId, feeHeadId } },
      },
      select: { studentId: true, kind: true, value: true },
      orderBy: { id: 'asc' },
    });
  }

  async create(
    schoolId: SchoolId,
    data: {
      studentId: bigint;
      academicYearId: bigint;
      enrolmentId: bigint;
      kind: ConcessionKind;
      value: number;
      effectiveFrom: string;
      reason: string;
      requestedBy: bigint;
      feeHeadIds: readonly bigint[];
      /** Created approved (directApproval, R183; admission by a principal, R239). */
      approved: { by: bigint; at: Date; selfApproved: boolean } | null;
    },
  ): Promise<bigint> {
    const { id } = await this.txHost.tx.concession.create({
      data: {
        schoolId,
        studentId: data.studentId,
        academicYearId: data.academicYearId,
        enrolmentId: data.enrolmentId,
        kind: data.kind,
        value: data.value,
        effectiveFrom: data.effectiveFrom,
        reason: data.reason,
        requestedBy: data.requestedBy,
        ...(data.approved === null
          ? {}
          : {
              status: 'approved',
              decidedBy: data.approved.by,
              decidedAt: data.approved.at,
              selfApproved: data.approved.selfApproved,
            }),
      },
      select: { id: true },
    });
    await this.txHost.tx.concessionHead.createMany({
      data: data.feeHeadIds.map((feeHeadId) => ({ schoolId, concessionId: id, feeHeadId })),
    });
    return id;
  }

  /** requested → approved | rejected; 0 when it was decided meanwhile. */
  async decide(
    schoolId: SchoolId,
    id: bigint,
    data: { status: 'approved' | 'rejected'; by: bigint; at: Date; reason: string | null; selfApproved: boolean },
  ): Promise<number> {
    const { count } = await this.txHost.tx.concession.updateMany({
      where: { schoolId, id, status: 'requested' },
      data: {
        status: data.status,
        decidedBy: data.by,
        decidedAt: data.at,
        decisionReason: data.reason,
        selfApproved: data.selfApproved,
      },
    });
    return count;
  }

  /** approved → ended; 0 when it was not approved. */
  async end(schoolId: SchoolId, id: bigint, by: bigint, reason: string, at: Date): Promise<number> {
    const { count } = await this.txHost.tx.concession.updateMany({
      where: { schoolId, id, status: 'approved' },
      data: { status: 'ended', endedAt: at, endedBy: by, endReason: reason },
    });
    return count;
  }

  /**
   * The student's enrolment in the year a concession originates from: the live one, else the
   * latest started (a concession follows the student within the year, R182).
   */
  enrolmentInYear(
    schoolId: SchoolId,
    studentId: bigint,
    academicYearId: bigint,
  ): Promise<{ id: bigint; endedOn: Date | null } | null> {
    return this.txHost.tx.enrolment.findFirst({
      where: { schoolId, studentId, academicYearId },
      select: { id: true, endedOn: true },
      orderBy: [{ startedOn: 'desc' }, { id: 'desc' }],
    });
  }

  /** The staff record behind a user (a concession's requester is told the decision). */
  async staffIdOfUser(schoolId: SchoolId, userId: bigint): Promise<bigint | null> {
    const row = await this.txHost.tx.user.findFirst({
      where: { schoolId, id: userId },
      select: { staffId: true },
    });
    return row?.staffId ?? null;
  }
}
