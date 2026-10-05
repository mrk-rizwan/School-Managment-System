import { Injectable } from '@nestjs/common';
import { notFound } from '../../common/errors/api-exception';
import { toPage, type Page } from '../../common/pagination';
import { SchoolClock } from '../../common/school-clock';
import { SchoolContext } from '../../common/school-context';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { titleOf } from '../../messaging/templates';
import { AnnouncementRecipientRepository } from '../../repositories/announcement-recipient.repository';
import { InboxRepository, type InboxPersons, type InboxRow } from '../../repositories/inbox.repository';
import { SchoolMessagingRepository } from '../../repositories/school-messaging.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { toDateString } from '../academics/academics.shared';
import { PermissionsService } from '../access/permissions.service';
import { attachmentMimeOf, type InboxItemDto, type InboxQueryDto } from '../announcements/announcements.dto';
import { AttachmentFiles, type AttachedFile } from '../documents/attachment-files.service';

// contracts/slice-14.md §7 (R147, R148, R164, R165): the messages addressed to the caller's
// persons, resolved at read time, so a guardian issued a login after a send still sees it. The
// guardian's children are read once per request: they filter the guardian's rows about one student
// (§7.1) and name the students of each row (§7.2).

type GuardianChildren = Awaited<ReturnType<PermissionsService['guardianChildren']>>;

const personsOf = (session: SchoolSessionContext, guardian: GuardianChildren): InboxPersons => ({
  guardianId: session.access.guardianId,
  guardianScope: guardian.scope,
  staffId: session.access.staffId,
  studentId: session.access.studentId,
});


@Injectable()
export class InboxService {
  constructor(
    private readonly context: SchoolContext,
    private readonly inbox: InboxRepository,
    private readonly recipients: AnnouncementRecipientRepository,
    private readonly permissions: PermissionsService,
    private readonly school: SchoolMessagingRepository,
    private readonly files: AttachmentFiles,
    private readonly clock: SchoolClock,
  ) {}

  /** §7.3: newest first; one page carries no bytes (R160). */
  async list(session: SchoolSessionContext, query: InboxQueryDto): Promise<Page<InboxItemDto>> {
    const schoolId = this.context.schoolId;
    const guardian = await this.permissions.guardianChildren(schoolId, session.access);
    const { rows, total } = await this.inbox.list(
      schoolId,
      personsOf(session, guardian),
      await this.clock.today(schoolId),
      {
        ...(query.kind === undefined ? {} : { kind: query.kind }),
        ...(query.category === undefined ? {} : { category: query.category }),
      },
      { skip: (query.page - 1) * query.limit, take: query.limit },
    );
    return toPage(await this.items(schoolId, session, guardian, rows), query, total);
  }

  /** §7.4: one item by its message id under the same predicate (an expired one is 404). */
  async get(session: SchoolSessionContext, id: bigint): Promise<InboxItemDto> {
    const schoolId = this.context.schoolId;
    const guardian = await this.permissions.guardianChildren(schoolId, session.access);
    const row = await this.require(schoolId, session, guardian, id);
    const [item] = await this.items(schoolId, session, guardian, [row]);
    if (!item) throw notFound();
    return item;
  }

  /** §7.5 (R148): only to a recipient, through the §7.1 predicate; never a URL. */
  async attachment(session: SchoolSessionContext, id: bigint, thumb: boolean): Promise<AttachedFile> {
    const schoolId = this.context.schoolId;
    const guardian = await this.permissions.guardianChildren(schoolId, session.access);
    const row = await this.require(schoolId, session, guardian, id);
    const mime = row.attachmentMime;
    if (row.mediaObjectKey === null || row.announcementId === null || mime === null || row.attachmentSizeBytes === null) {
      throw notFound();
    }
    const file = { objectKey: row.mediaObjectKey, mime, sizeBytes: row.attachmentSizeBytes };
    const name = `announcement-${row.announcementId}`;
    const log = { messageId: row.id.toString() };
    return thumb ? this.files.thumbnail(schoolId, file, name, log) : this.files.open(schoolId, file, name, log);
  }

  private async require(
    schoolId: SchoolId,
    session: SchoolSessionContext,
    guardian: GuardianChildren,
    id: bigint,
  ): Promise<InboxRow> {
    const row = await this.inbox.find(schoolId, personsOf(session, guardian), await this.clock.today(schoolId), id);
    if (!row) throw notFound();
    return row;
  }

  private async items(
    schoolId: SchoolId,
    session: SchoolSessionContext,
    guardian: GuardianChildren,
    rows: readonly InboxRow[],
  ): Promise<InboxItemDto[]> {
    const settings = await this.school.find(schoolId);
    const schoolName = settings?.name ?? '';
    const via = await this.viaStudents(schoolId, session, guardian.children, rows);
    return rows.map((row) => {
      const announcement = row.subjectType === 'announcement' && row.announcementId !== null;
      return {
        id: row.id.toString(),
        kind: announcement ? 'announcement' : 'notice',
        messageType: row.type,
        subjectType: row.subjectType,
        subjectId: row.subjectId.toString(),
        title: announcement ? (row.announcementTitle ?? '') : titleOf(row.type, row.subjectType, schoolName),
        body: announcement ? (row.announcementBody ?? row.body) : row.body,
        category: row.category,
        priority: row.priority,
        sentAt: row.createdAt,
        expiresOn: row.expiresOn === null ? null : toDateString(row.expiresOn),
        hasAttachment: row.mediaObjectKey !== null,
        attachmentMime: row.mediaObjectKey === null ? null : attachmentMimeOf(row.attachmentMime),
        announcementId: row.announcementId?.toString() ?? null,
        viaStudents: via.get(row.id) ?? [],
      };
    });
  }

  /**
   * §7.2 (R164, R165): for the guardian's own rows only, the students of the caller's current
   * guardian scope that the message is about. One read per subject type present, never per row.
   */
  private async viaStudents(
    schoolId: SchoolId,
    session: SchoolSessionContext,
    children: GuardianChildren['children'],
    rows: readonly InboxRow[],
  ): Promise<Map<bigint, { studentId: string; fullName: string }[]>> {
    const result = new Map<bigint, { studentId: string; fullName: string }[]>();
    const guardianId = session.access.guardianId;
    const own = rows.filter((row) => guardianId !== null && row.guardianId === guardianId);
    if (guardianId === null || own.length === 0 || children.length === 0) return result;
    const names = new Map(children.map((c) => [c.studentId, c.fullName]));
    const scopeIds = children.map((c) => c.studentId);
    const of = (subjectType: string) => own.filter((row) => row.subjectType === subjectType);
    const name = (ids: readonly bigint[]) =>
      ids.flatMap((id) => {
        const fullName = names.get(id);
        return fullName === undefined ? [] : [{ studentId: id.toString(), fullName }];
      });

    const announcements = of('announcement').filter((row) => row.announcementId !== null);
    if (announcements.length > 0) {
      const byAnnouncement = await this.recipients.studentsForGuardian(
        schoolId,
        guardianId,
        announcements.map((row) => row.subjectId),
        scopeIds,
      );
      for (const row of announcements) result.set(row.id, name(byAnnouncement.get(row.subjectId) ?? []));
    }
    for (const subjectType of ['attendance_alert', 'remark'] as const) {
      const subjectRows = of(subjectType);
      if (subjectRows.length === 0) continue;
      const studentOf = await this.inbox.studentOfSubjects(
        schoolId,
        subjectType,
        subjectRows.map((row) => row.subjectId),
        scopeIds,
      );
      for (const row of subjectRows) {
        const studentId = studentOf.get(row.subjectId);
        result.set(row.id, studentId === undefined ? [] : name([studentId]));
      }
    }
    const diary = of('diary_entry');
    if (diary.length > 0) {
      const byEntry = await this.inbox.studentsOfDiaryEntries(
        schoolId,
        diary.map((row) => row.subjectId),
        scopeIds,
      );
      for (const row of diary) result.set(row.id, name(byEntry.get(row.subjectId) ?? []));
    }
    return result;
  }
}
