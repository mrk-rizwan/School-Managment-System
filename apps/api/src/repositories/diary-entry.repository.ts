import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { Scope } from '../tenancy/scope';
import type { Prisma } from './generated/prisma/client';
import { liveGuardiansOf, namesById, staffNames, subjectNames } from './name-reads';
import type { PrismaTxAdapter } from './prisma';
import { studentInScope } from './student.repository';

// contracts/slice-13.md §4, §6.1. The tenant table diary_entries: one row per (section, date,
// subject) (diary_entries_natural_key, R137), edited in place; the diary_entries_history trigger
// writes diary_entry_changes for every change of the five editable fields under the
// transaction-local actor (ChangeContextRepository). Section-linked: staff reads take the
// caller's Scope and see a section's entries only while the section is in it; guardian and
// student reads take the capacity scope and see an entry only through an enrolment of the child
// in force on the entry's date in its section (§6.1).

/** The natural-key unique index (R137): a second entry for the same section, date and subject. */
export const DIARY_ENTRY_NATURAL_KEY = 'diary_entries_natural_key';

export interface DiaryEntryRecord {
  id: bigint;
  sectionId: bigint;
  classId: bigint;
  academicYearId: bigint;
  /** UTC midnight of the calendar date (a `date` column). */
  date: Date;
  subjectId: bigint;
  authorStaffId: bigint;
  topic: string;
  assignment: string | null;
  learningOutcome: string | null;
  dueOn: Date | null;
  attachmentObjectKey: string | null;
  attachmentMime: string | null;
  attachmentSizeBytes: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** An entry with the names its DTOs carry. */
export interface DiaryEntryView extends DiaryEntryRecord {
  subjectName: string;
  authorName: string;
  className: string;
  sectionName: string;
}

export interface DiaryEntryCreate {
  sectionId: bigint;
  classId: bigint;
  academicYearId: bigint;
  date: Date;
  subjectId: bigint;
  authorStaffId: bigint;
  topic: string;
  assignment: string | null;
  learningOutcome: string | null;
  dueOn: Date | null;
  attachment: DiaryAttachment | null;
}

export interface DiaryAttachment {
  objectKey: string;
  mime: string;
  sizeBytes: number;
}

/** The five editable fields (§4); absent = unchanged; `attachment: null` removes it. */
export interface DiaryEntryChanges {
  topic?: string;
  assignment?: string | null;
  learningOutcome?: string | null;
  dueOn?: Date | null;
  attachment?: DiaryAttachment | null;
}

export interface DiaryEntryListQuery {
  dateFrom?: Date;
  dateTo?: Date;
  subjectId?: bigint;
  /** `-date` (default) or `date`; id breaks ties. */
  descending: boolean;
  skip: number;
  take: number;
}

const SELECT = {
  id: true,
  sectionId: true,
  classId: true,
  academicYearId: true,
  date: true,
  subjectId: true,
  authorStaffId: true,
  topic: true,
  assignment: true,
  learningOutcome: true,
  dueOn: true,
  attachmentObjectKey: true,
  attachmentMime: true,
  attachmentSizeBytes: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DiaryEntrySelect;

/** No row: an id no entry has (ids start at 1). */
const NONE: Prisma.DiaryEntryWhereInput = { id: { in: [] } };

/**
 * A staff Scope over entries: school-wide adds nothing, a teacher sees the sections held today.
 * A capacity scope never reaches a staff read; it matches nothing rather than everything.
 */
function sectionInScope(scope: Scope): Prisma.DiaryEntryWhereInput {
  switch (scope.kind) {
    case 'all':
      return {};
    case 'sections':
      return { sectionId: { in: [...scope.ids] } };
    case 'students':
      return NONE;
  }
}

const dateRange = (query: Pick<DiaryEntryListQuery, 'dateFrom' | 'dateTo'>) =>
  query.dateFrom === undefined && query.dateTo === undefined
    ? {}
    : {
        date: {
          ...(query.dateFrom === undefined ? {} : { gte: query.dateFrom }),
          ...(query.dateTo === undefined ? {} : { lte: query.dateTo }),
        },
      };

const order = (descending: boolean): Prisma.DiaryEntryOrderByWithRelationInput[] => [
  { date: descending ? 'desc' : 'asc' },
  { id: descending ? 'desc' : 'asc' },
];

const attachmentData = (attachment: DiaryAttachment | null) => ({
  attachmentObjectKey: attachment?.objectKey ?? null,
  attachmentMime: attachment?.mime ?? null,
  attachmentSizeBytes: attachment?.sizeBytes ?? null,
});

@Injectable()
export class DiaryEntryRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** A second entry for the section, date and subject fails DIARY_ENTRY_NATURAL_KEY. */
  create(schoolId: SchoolId, data: DiaryEntryCreate): Promise<DiaryEntryRecord> {
    const { attachment, ...rest } = data;
    return this.txHost.tx.diaryEntry.create({
      data: { schoolId, ...rest, ...attachmentData(attachment) },
      select: SELECT,
    });
  }

  /** The entry holding the natural key, unscoped: the answer to a create's conflict (§4.3 step 5). */
  findByNaturalKey(
    schoolId: SchoolId,
    key: { sectionId: bigint; date: Date; subjectId: bigint },
  ): Promise<DiaryEntryRecord | null> {
    return this.txHost.tx.diaryEntry.findFirst({
      where: { schoolId, ...key },
      select: SELECT,
    });
  }

  /** Scoped: an entry whose section is outside the caller's scope reads as absent. */
  findById(schoolId: SchoolId, scope: Scope, id: bigint): Promise<DiaryEntryRecord | null> {
    return this.txHost.tx.diaryEntry.findFirst({
      where: { schoolId, id, AND: [sectionInScope(scope)] },
      select: SELECT,
    });
  }

  /** A section's entries; none when the section is outside the caller's scope. */
  async listForSection(
    schoolId: SchoolId,
    scope: Scope,
    sectionId: bigint,
    query: DiaryEntryListQuery,
  ): Promise<{ rows: DiaryEntryRecord[]; total: number }> {
    const where: Prisma.DiaryEntryWhereInput = {
      schoolId,
      sectionId,
      ...dateRange(query),
      ...(query.subjectId === undefined ? {} : { subjectId: query.subjectId }),
      AND: [sectionInScope(scope)],
    };
    const total = await this.txHost.tx.diaryEntry.count({ where });
    const rows = await this.txHost.tx.diaryEntry.findMany({
      where,
      select: SELECT,
      orderBy: order(query.descending),
      skip: query.skip,
      take: query.take,
    });
    return { rows, total };
  }

  /**
   * The entries a child sees (§6.1): one window per enrolment of the child, the entry's section
   * that enrolment's and its date inside it. The child must be in the capacity scope; a child who
   * moved sections sees each section for its own dates, one who left keeps their history (R164).
   */
  async listVisibleToStudent(
    schoolId: SchoolId,
    scope: Scope,
    studentId: bigint,
    query: Omit<DiaryEntryListQuery, 'subjectId'>,
  ): Promise<{ rows: DiaryEntryRecord[]; total: number }> {
    const visible = await this.visibleTo(schoolId, scope, studentId);
    const where: Prisma.DiaryEntryWhereInput = {
      schoolId,
      ...dateRange(query),
      AND: [visible],
    };
    const total = await this.txHost.tx.diaryEntry.count({ where });
    const rows = await this.txHost.tx.diaryEntry.findMany({
      where,
      select: SELECT,
      orderBy: order(query.descending),
      skip: query.skip,
      take: query.take,
    });
    return { rows, total };
  }

  /** One entry by the §6.1 predicate; null for a non-recipient (another child, an ended link). */
  async findVisibleToStudent(
    schoolId: SchoolId,
    scope: Scope,
    studentId: bigint,
    id: bigint,
  ): Promise<DiaryEntryRecord | null> {
    const visible = await this.visibleTo(schoolId, scope, studentId);
    return this.txHost.tx.diaryEntry.findFirst({
      where: { schoolId, id, AND: [visible] },
      select: SELECT,
    });
  }

  /**
   * Locks the row for the rest of the transaction if it is unchanged since read (a no-op write:
   * the history trigger records nothing). False when it changed; the caller reads again.
   */
  async lockIfUnchanged(
    schoolId: SchoolId,
    row: Pick<DiaryEntryRecord, 'id' | 'updatedAt'>,
  ): Promise<boolean> {
    const { count } = await this.txHost.tx.diaryEntry.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  /**
   * The edit (§4.4). Call under the row lock with the change context set: the history trigger
   * writes one diary_entry_changes row with the old and new values.
   */
  update(
    schoolId: SchoolId,
    id: bigint,
    changes: DiaryEntryChanges,
    now: Date,
  ): Promise<DiaryEntryRecord> {
    const { attachment, ...fields } = changes;
    return this.txHost.tx.diaryEntry.update({
      where: { schoolId_id: { schoolId, id } },
      data: {
        ...fields,
        ...(attachment === undefined ? {} : attachmentData(attachment)),
        updatedAt: now,
      },
      select: SELECT,
    });
  }

  /**
   * The diary_posted audience (§4.6, R138): the students of the enrolments in force on `date` in the
   * section who are `active` (R164: no new notices for a child who has left); every not-merged
   * guardian with a live link to one of them, whatever its login flag (a guardian without a login
   * gets a visible suppression, not silence); and, when student logins are on, those students
   * holding an active login. Ascending ids; a guardian of two children appears once.
   */
  async postedRecipients(
    schoolId: SchoolId,
    key: { sectionId: bigint; date: Date },
    studentLoginEnabled: boolean,
  ): Promise<{ guardianIds: bigint[]; studentIds: bigint[] }> {
    const enrolled = await this.txHost.tx.enrolment.findMany({
      where: {
        schoolId,
        sectionId: key.sectionId,
        startedOn: { lte: key.date },
        OR: [{ endedOn: null }, { endedOn: { gte: key.date } }],
        student: { is: { status: 'active' } },
      },
      select: { studentId: true },
    });
    const studentIds = [...new Set(enrolled.map((e) => e.studentId))];
    if (studentIds.length === 0) return { guardianIds: [], studentIds: [] };
    const guardianIds = await liveGuardiansOf(this.txHost.tx, schoolId, studentIds);
    const students = studentLoginEnabled
      ? await this.txHost.tx.student.findMany({
          where: { schoolId, id: { in: studentIds }, user: { is: { status: 'active' } } },
          select: { id: true },
          orderBy: { id: 'asc' },
        })
      : [];
    return { guardianIds, studentIds: students.map((st) => st.id) };
  }

  /**
   * Subject, author, class and section names for a page of entries: four sequential statements
   * whatever the page size (no concurrent relation loads inside a transaction).
   */
  async withNames(schoolId: SchoolId, rows: DiaryEntryRecord[]): Promise<DiaryEntryView[]> {
    if (rows.length === 0) return [];
    const unique = (pick: (row: DiaryEntryRecord) => bigint) => [...new Set(rows.map(pick))];
    const subject = await subjectNames(this.txHost.tx, schoolId, rows.map((r) => r.subjectId));
    const author = await staffNames(this.txHost.tx, schoolId, rows.map((r) => r.authorStaffId));
    const klass = namesById(
      await this.txHost.tx.class.findMany({
        where: { schoolId, id: { in: unique((r) => r.classId) } },
        select: { id: true, name: true },
      }),
    );
    const section = namesById(
      await this.txHost.tx.section.findMany({
        where: { schoolId, id: { in: unique((r) => r.sectionId) } },
        select: { id: true, name: true },
      }),
    );
    return rows.map((row) => ({
      ...row,
      subjectName: subject(row.subjectId) ?? '',
      authorName: author(row.authorStaffId) ?? '',
      className: klass(row.classId) ?? '',
      sectionName: section(row.sectionId) ?? '',
    }));
  }

  /**
   * The §6.1 predicate for one child: an OR of (section, date window) over the child's
   * enrolments, read through the capacity scope. A child outside the scope has no windows, which
   * matches no row.
   */
  private async visibleTo(
    schoolId: SchoolId,
    scope: Scope,
    studentId: bigint,
  ): Promise<Prisma.DiaryEntryWhereInput> {
    const enrolments = await this.txHost.tx.enrolment.findMany({
      where: { schoolId, studentId, student: { is: studentInScope(scope) } },
      select: { sectionId: true, startedOn: true, endedOn: true },
    });
    if (enrolments.length === 0) return NONE;
    return {
      OR: enrolments.map((e) => ({
        sectionId: e.sectionId,
        date: { gte: e.startedOn, ...(e.endedOn === null ? {} : { lte: e.endedOn }) },
      })),
    };
  }
}
