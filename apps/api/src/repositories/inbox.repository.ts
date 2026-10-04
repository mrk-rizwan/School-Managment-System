import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  MESSAGE_SUBJECT_TYPES,
  type AnnouncementCategory,
  type InboxItemKind,
  type MessagePriority,
  type MessageSubjectType,
  type MessageType,
} from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import { oneOf, sqlDate } from './attendance-sql';
import { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// The inbox (contracts/slice-14.md §7, plan §4.2): one query over messages, resolved by person at
// read time, joined to announcements by subject. Every statement filters school_id on every table
// it reads (test/announcements/isolation.e2e-spec.ts).

/** The caller's persons; null ids match nothing. */
export interface InboxPersons {
  guardianId: bigint | null;
  staffId: bigint | null;
  studentId: bigint | null;
}

export interface InboxRow {
  id: bigint;
  type: MessageType;
  priority: MessagePriority;
  subjectType: MessageSubjectType;
  subjectId: bigint;
  guardianId: bigint | null;
  body: string;
  mediaObjectKey: string | null;
  createdAt: Date;
  /** Set when the message is about an announcement. */
  announcementId: bigint | null;
  announcementTitle: string | null;
  announcementBody: string | null;
  category: AnnouncementCategory | null;
  expiresOn: Date | null;
  attachmentMime: string | null;
  attachmentSizeBytes: number | null;
}

export interface InboxFilter {
  kind?: InboxItemKind;
  category?: AnnouncementCategory;
}

interface RawRow {
  id: bigint;
  type: MessageType;
  priority: MessagePriority;
  subject_type: string;
  subject_id: bigint;
  guardian_id: bigint | null;
  body: string;
  media_object_key: string | null;
  created_at: Date;
  announcement_id: bigint | null;
  announcement_title: string | null;
  announcement_body: string | null;
  category: AnnouncementCategory | null;
  expires_on: Date | null;
  attachment_mime: string | null;
  attachment_size_bytes: number | null;
}

const toRow = (r: RawRow): InboxRow => ({
  id: r.id,
  type: r.type,
  priority: r.priority,
  subjectType: oneOf(MESSAGE_SUBJECT_TYPES, r.subject_type),
  subjectId: r.subject_id,
  guardianId: r.guardian_id,
  body: r.body,
  mediaObjectKey: r.media_object_key,
  createdAt: r.created_at,
  announcementId: r.announcement_id,
  announcementTitle: r.announcement_title,
  announcementBody: r.announcement_body,
  category: r.category,
  expiresOn: r.expires_on,
  attachmentMime: r.attachment_mime,
  attachmentSizeBytes: r.attachment_size_bytes,
});

@Injectable()
export class InboxRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /**
   * §7.1's predicate: addressed to one of the persons; no messaging test; not withdrawn before
   * anyone was told; not an announcement that expired before `today` (R147). The channel plan is
   * not a predicate (decision 16).
   */
  private where(schoolId: SchoolId, persons: InboxPersons, today: Date, filter: InboxFilter): Prisma.Sql | null {
    const own: Prisma.Sql[] = [];
    if (persons.guardianId !== null) own.push(Prisma.sql`m.guardian_id = ${persons.guardianId}`);
    if (persons.staffId !== null) own.push(Prisma.sql`m.staff_id = ${persons.staffId}`);
    if (persons.studentId !== null) own.push(Prisma.sql`m.student_id = ${persons.studentId}`);
    if (own.length === 0) return null;
    const parts = [
      Prisma.sql`m.school_id = ${schoolId}`,
      Prisma.sql`(${Prisma.join(own, ' OR ')})`,
      Prisma.sql`m.type <> 'messaging_test'`,
      Prisma.sql`NOT (m.status = 'suppressed' AND m.suppressed_reason IS NOT DISTINCT FROM 'subject_cancelled')`,
      Prisma.sql`(a.expires_on IS NULL OR a.expires_on >= ${sqlDate(today)})`,
    ];
    if (filter.kind === 'announcement') parts.push(Prisma.sql`m.subject_type = 'announcement'`);
    if (filter.kind === 'notice') parts.push(Prisma.sql`m.subject_type <> 'announcement'`);
    if (filter.category !== undefined) parts.push(Prisma.sql`a.category::text = ${filter.category}`);
    return Prisma.join(parts, ' AND ');
  }

  private readonly from = Prisma.sql`
    FROM messages m
    LEFT JOIN announcements a
      ON m.subject_type = 'announcement' AND a.school_id = m.school_id AND a.id = m.subject_id`;

  private readonly columns = Prisma.sql`
    m.id, m.type::text AS type, m.priority::text AS priority, m.subject_type, m.subject_id,
    m.guardian_id, m.body, m.media_object_key, m.created_at,
    a.id AS announcement_id, a.title AS announcement_title, a.body AS announcement_body,
    a.category::text AS category, a.expires_on, a.attachment_mime, a.attachment_size_bytes`;

  /** A page, newest first (`created_at` desc, id desc). */
  async list(
    schoolId: SchoolId,
    persons: InboxPersons,
    today: Date,
    filter: InboxFilter,
    page: { skip: number; take: number },
  ): Promise<{ rows: InboxRow[]; total: number }> {
    const where = this.where(schoolId, persons, today, filter);
    if (where === null) return { rows: [], total: 0 };
    const rows = await this.txHost.tx.$queryRaw<RawRow[]>(Prisma.sql`
      SELECT ${this.columns} ${this.from} WHERE ${where}
       ORDER BY m.created_at DESC, m.id DESC LIMIT ${page.take} OFFSET ${page.skip}`);
    const [count] = await this.txHost.tx.$queryRaw<{ total: bigint }[]>(Prisma.sql`
      SELECT count(*) AS total ${this.from} WHERE ${where}`);
    return { rows: rows.map(toRow), total: Number(count?.total ?? 0n) };
  }

  /** One item by its message id under the same predicate (§7.4), else null. */
  async find(schoolId: SchoolId, persons: InboxPersons, today: Date, id: bigint): Promise<InboxRow | null> {
    const where = this.where(schoolId, persons, today, {});
    if (where === null) return null;
    const [row] = await this.txHost.tx.$queryRaw<RawRow[]>(Prisma.sql`
      SELECT ${this.columns} ${this.from} WHERE ${where} AND m.id = ${id}`);
    return row === undefined ? null : toRow(row);
  }

  // ------------------------------------------------------------------ viaStudents (§7.2)

  /** attendance_alert and remark subjects: subject id -> the row's student, among `studentIds`. */
  async studentOfSubjects(
    schoolId: SchoolId,
    subjectType: 'attendance_alert' | 'remark',
    subjectIds: readonly bigint[],
    studentIds: readonly bigint[],
  ): Promise<Map<bigint, bigint>> {
    const where = { schoolId, id: { in: [...subjectIds] }, studentId: { in: [...studentIds] } };
    const select = { id: true, studentId: true } as const;
    const rows =
      subjectType === 'remark'
        ? await this.txHost.tx.remark.findMany({ where, select })
        : await this.txHost.tx.attendanceAlert.findMany({ where, select });
    return new Map(rows.map((r) => [r.id, r.studentId]));
  }

  /**
   * diary_entry subjects: entry id -> the students among `studentIds` with an enrolment in the
   * entry's section in force on the entry's date (slice 13 §6.1's predicate). Two reads.
   */
  async studentsOfDiaryEntries(
    schoolId: SchoolId,
    entryIds: readonly bigint[],
    studentIds: readonly bigint[],
  ): Promise<Map<bigint, bigint[]>> {
    const result = new Map<bigint, bigint[]>();
    if (entryIds.length === 0 || studentIds.length === 0) return result;
    const entries = await this.txHost.tx.diaryEntry.findMany({
      where: { schoolId, id: { in: [...entryIds] } },
      select: { id: true, sectionId: true, date: true },
    });
    const enrolments = await this.txHost.tx.enrolment.findMany({
      where: {
        schoolId,
        studentId: { in: [...studentIds] },
        sectionId: { in: [...new Set(entries.map((e) => e.sectionId))] },
      },
      select: { studentId: true, sectionId: true, startedOn: true, endedOn: true },
    });
    for (const entry of entries) {
      const ids = enrolments
        .filter(
          (e) =>
            e.sectionId === entry.sectionId &&
            e.startedOn <= entry.date &&
            (e.endedOn === null || e.endedOn >= entry.date),
        )
        .map((e) => e.studentId);
      if (ids.length > 0) result.set(entry.id, [...new Set(ids)]);
    }
    return result;
  }
}
