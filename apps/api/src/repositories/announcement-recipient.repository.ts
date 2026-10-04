import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { MessagePerson } from './message.repository';
import type { PrismaTxAdapter } from './prisma';

// The append-only tenant tables announcement_recipients and announcement_recipient_students
// (contracts/slice-14.md §4.3, §11 items 4-5): who an announcement resolved to at send, and why a
// guardian is among them. They serve audience counts, viaStudents and the delivery summary, never
// the inbox (plan §4.2). Rows are written after the send's messages, with the person's message id,
// so nothing is ever updated (a per-row back-fill through the freeze triggers cost seconds at
// 3,000 recipients, contracts/slice-14.md §5.5's budget).

/** One person to record, with the students that put a guardian there (none for staff and students). */
export interface NewRecipient {
  person: MessagePerson;
  studentIds: readonly bigint[];
  /** The person's message for this announcement. */
  messageId: bigint | null;
}

export interface RecipientCounts {
  total: number;
  guardians: number;
  staff: number;
  students: number;
}

@Injectable()
export class AnnouncementRecipientRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /**
   * The recipients and their students, set-based (ON CONFLICT DO NOTHING on the per-person partial
   * uniques, R145). Returns how many recipient rows were new.
   */
  async insert(schoolId: SchoolId, announcementId: bigint, recipients: readonly NewRecipient[]): Promise<number> {
    if (recipients.length === 0) return 0;
    const data = (people: readonly NewRecipient[]) =>
      people.map(({ person, messageId }) => ({
        schoolId,
        announcementId,
        guardianId: 'guardianId' in person ? person.guardianId : null,
        staffId: 'staffId' in person ? person.staffId : null,
        studentId: 'studentId' in person ? person.studentId : null,
        messageId,
      }));
    // Only guardian rows need their ids back (for their students); the rest are inserted plainly.
    const guardians = recipients.filter(({ person }) => 'guardianId' in person);
    const others = recipients.filter(({ person }) => !('guardianId' in person));
    const rows =
      guardians.length === 0
        ? []
        : await this.txHost.tx.announcementRecipient.createManyAndReturn({
            data: data(guardians),
            skipDuplicates: true,
            select: { id: true, guardianId: true },
          });
    const { count } =
      others.length === 0
        ? { count: 0 }
        : await this.txHost.tx.announcementRecipient.createMany({ data: data(others), skipDuplicates: true });
    const studentsOf = new Map(
      recipients.flatMap(({ person, studentIds }) =>
        'guardianId' in person ? [[person.guardianId, studentIds] as const] : [],
      ),
    );
    await this.txHost.tx.announcementRecipientStudent.createMany({
      data: rows.flatMap((row) =>
        row.guardianId === null
          ? []
          : (studentsOf.get(row.guardianId) ?? []).map((studentId) => ({
              schoolId,
              announcementRecipientId: row.id,
              studentId,
            })),
      ),
      skipDuplicates: true,
    });
    return rows.length + count;
  }

  /** One aggregate: a column's count is its non-null rows, and each row names exactly one person. */
  async counts(schoolId: SchoolId, announcementId: bigint): Promise<RecipientCounts> {
    const { _count } = await this.txHost.tx.announcementRecipient.aggregate({
      where: { schoolId, announcementId },
      _count: { guardianId: true, staffId: true, studentId: true },
    });
    const { guardianId: guardians, staffId: staff, studentId: students } = _count;
    return { total: guardians + staff + students, guardians, staff, students };
  }

  /**
   * viaStudents for announcements (§7.2): announcement id -> the students recorded for this
   * guardian's recipient row, among `studentIds` (the caller's current guardian scope). One read.
   */
  async studentsForGuardian(
    schoolId: SchoolId,
    guardianId: bigint,
    announcementIds: readonly bigint[],
    studentIds: readonly bigint[],
  ): Promise<Map<bigint, bigint[]>> {
    const result = new Map<bigint, bigint[]>();
    if (announcementIds.length === 0 || studentIds.length === 0) return result;
    const rows = await this.txHost.tx.announcementRecipientStudent.findMany({
      where: {
        schoolId,
        studentId: { in: [...studentIds] },
        recipient: { is: { schoolId, guardianId, announcementId: { in: [...announcementIds] } } },
      },
      select: { studentId: true, recipient: { select: { announcementId: true } } },
      orderBy: { studentId: 'asc' },
    });
    for (const row of rows) {
      const list = result.get(row.recipient.announcementId) ?? [];
      list.push(row.studentId);
      result.set(row.recipient.announcementId, list);
    }
    return result;
  }
}
