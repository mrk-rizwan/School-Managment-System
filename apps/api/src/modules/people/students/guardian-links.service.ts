import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { Capability, ErrorCode } from '@asms/shared';
import { scopeOf, type SchoolSessionContext } from '../../../common/auth/school-session';
import { FieldEncryption } from '../../../common/crypto/field-encryption';
import { ApiException, fieldRefused, notFound } from '../../../common/errors/api-exception';
import { summariseDatabaseError } from '../../../common/errors/prisma-errors';
import { guardianCnicAad, maskIdentityNumber } from '../../../common/identity';
import { readLocked } from '../../../common/locking';
import { toPage, type Page } from '../../../common/pagination';
import { SchoolContext } from '../../../common/school-context';
import { AuditLogRepository, type AuditEntry } from '../../../repositories/audit-log.repository';
import { GuardianRepository, type GuardianRecord } from '../../../repositories/guardian.repository';
import {
  StudentGuardianRepository,
  type GuardianLinkChanges,
  type GuardianLinkRecord,
  type GuardianLinkView,
} from '../../../repositories/student-guardian.repository';
import type { SchoolId } from '../../../tenancy/school-id';
import type { Scope } from '../../../tenancy/scope';
import type {
  CreateGuardianLinkDto,
  GuardianLinkDto,
  ListGuardianLinksQueryDto,
  ReasonDto,
  UpdateGuardianLinkDto,
} from './students.dto';
import {
  feePayerRequired,
  primaryContactNeedsPhone,
  primaryContactRequired,
} from './students.shared';
import { StudentsService, type Held } from './students.service';

// contracts/slice-6.md §4 (rule 9). Every write locks the student row first, which serialises
// R28 (one primary contact) and R29 (at least one fee payer) per student; a guardian becoming
// primary is locked next (R30: a concurrent PATCH clearing its phone waits or is refused).

type AuditMetadata = NonNullable<AuditEntry['metadata']>;

const SUBJECT = 'student_guardian';
const LIVE_PAIR_UNIQUE = 'student_guardians_live_pair_key';
const linkExists = (linkId: bigint) =>
  new ApiException(409, ErrorCode.GUARDIAN_LINK_EXISTS, 'This guardian is already linked.', {
    linkId: linkId.toString(),
  });

@Injectable()
export class GuardianLinksService {
  constructor(
    private readonly context: SchoolContext,
    private readonly links: StudentGuardianRepository,
    private readonly guardians: GuardianRepository,
    private readonly students: StudentsService,
    private readonly audit: AuditLogRepository,
    private readonly encryption: FieldEncryption,
  ) {}

  async list(
    session: SchoolSessionContext,
    studentId: bigint,
    query: ListGuardianLinksQueryDto,
  ): Promise<Page<GuardianLinkDto>> {
    const schoolId = this.context.schoolId;
    await this.students.require(schoolId, scopeOf(session), studentId);
    const { rows, total } = await this.links.listForStudent(schoolId, studentId, {
      includeEnded: query.includeEnded ?? false,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const held = session.access.capabilities;
    return toPage(
      rows.map((row) => this.toDto(schoolId, held, row)),
      query,
      total,
    );
  }

  async create(
    session: SchoolSessionContext,
    studentId: bigint,
    dto: CreateGuardianLinkDto,
  ): Promise<GuardianLinkDto> {
    try {
      return await this.createInTransaction(session, studentId, dto);
    } catch (error) {
      // The race loser of two links of one pair: read the winner in a fresh statement.
      if (summariseDatabaseError(error)?.constraint !== LIVE_PAIR_UNIQUE) throw error;
      const winner = await this.links.findLivePair(
        this.context.schoolId,
        studentId,
        BigInt(dto.guardianId),
      );
      throw winner ? linkExists(winner.id) : error;
    }
  }

  /**
   * Flags and relationship. Moving the primary contact is setting `true` on the new link; the
   * current primary is cleared in the same transaction. Nothing changing is no write, no audit.
   */
  @Transactional()
  async update(
    session: SchoolSessionContext,
    id: bigint,
    dto: UpdateGuardianLinkDto,
  ): Promise<GuardianLinkDto> {
    const { schoolId, userId } = this.context.actor();
    const link = await this.lockLink(schoolId, scopeOf(session), id);
    if (link.endedAt !== null) {
      throw new ApiException(409, ErrorCode.GUARDIAN_LINK_ENDED, 'This link has ended.');
    }

    const data: GuardianLinkChanges = {};
    const changes: Record<string, AuditMetadata[string]> = {};
    if (dto.relationship !== undefined && dto.relationship !== link.relationship) {
      data.relationship = dto.relationship;
      changes.relationship = { from: link.relationship, to: dto.relationship };
    }
    if (dto.isPrimaryContact !== undefined && dto.isPrimaryContact !== link.isPrimaryContact) {
      if (!dto.isPrimaryContact) throw primaryContactRequired();
      await this.lockPrimaryCandidate(schoolId, link.guardianId);
      data.isPrimaryContact = true;
      changes.isPrimaryContact = { from: false, to: true };
    }
    if (dto.isFeePayer !== undefined && dto.isFeePayer !== link.isFeePayer) {
      if (!dto.isFeePayer) await this.assertOtherFeePayer(schoolId, link);
      data.isFeePayer = dto.isFeePayer;
      changes.isFeePayer = { from: link.isFeePayer, to: dto.isFeePayer };
    }
    if (dto.canLogin !== undefined && dto.canLogin !== link.canLogin) {
      data.canLogin = dto.canLogin;
      changes.canLogin = { from: link.canLogin, to: dto.canLogin };
    }
    if (Object.keys(changes).length === 0) return this.view(schoolId, session, link);

    if (data.isPrimaryContact) await this.links.clearPrimary(schoolId, link.studentId);
    const updated = await this.links.update(schoolId, id, data);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'guardian_link.updated',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { changes },
    });
    return this.view(schoolId, session, updated);
  }

  /** Sets ended_at. Already ended is a 200 with no audit row (retry-safe). */
  @Transactional()
  async end(session: SchoolSessionContext, id: bigint, dto: ReasonDto): Promise<GuardianLinkDto> {
    const { schoolId, userId } = this.context.actor();
    const link = await this.lockLink(schoolId, scopeOf(session), id);
    if (link.endedAt !== null) return this.view(schoolId, session, link);
    if (link.isPrimaryContact) throw primaryContactRequired();
    if (link.isFeePayer) await this.assertOtherFeePayer(schoolId, link);

    await this.links.end(schoolId, id, new Date());
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'guardian_link.ended',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: {},
    });
    const ended = await this.links.findById(schoolId, scopeOf(session), id);
    if (!ended) throw notFound();
    return this.view(schoolId, session, ended);
  }

  /**
   * The guardian side is nulled for a caller without guardian.manage (contract decision 2): a
   * teacher sees name, relationship, phone and the flags only.
   */
  toDto(schoolId: SchoolId, held: Held, row: GuardianLinkView): GuardianLinkDto {
    const full = held.has(Capability.GUARDIAN_MANAGE);
    const { guardian } = row;
    return {
      id: row.id.toString(),
      studentId: row.studentId.toString(),
      guardianId: row.guardianId.toString(),
      guardianFullName: guardian.fullName,
      relationship: row.relationship,
      isPrimaryContact: row.isPrimaryContact,
      isFeePayer: row.isFeePayer,
      canLogin: row.canLogin,
      phone: guardian.phone,
      endedAt: row.endedAt,
      contactCapability: full ? guardian.contactCapability : null,
      guardianCnicMasked:
        full && guardian.cnic !== null
          ? maskIdentityNumber(this.encryption.decrypt(guardian.cnic, guardianCnicAad(schoolId)))
          : null,
      guardianAddress: full ? guardian.address : null,
      guardianUserId: full ? (guardian.userId?.toString() ?? null) : null,
    };
  }

  @Transactional()
  private async createInTransaction(
    session: SchoolSessionContext,
    studentId: bigint,
    dto: CreateGuardianLinkDto,
  ): Promise<GuardianLinkDto> {
    const { schoolId, userId } = this.context.actor();
    await this.students.lock(schoolId, scopeOf(session), studentId);
    const guardianId = BigInt(dto.guardianId);
    const guardian = await this.guardians.findById(schoolId, guardianId);
    if (!guardian) {
      throw fieldRefused('guardianId', ErrorCode.REFERENCE_NOT_FOUND, 'No such guardian');
    }
    if (guardian.status === 'merged' || guardian.mergedIntoId !== null) throw merged(guardian);
    const existing = await this.links.findLivePair(schoolId, studentId, guardianId);
    if (existing) throw linkExists(existing.id);
    if (dto.isPrimaryContact) {
      await this.lockPrimaryCandidate(schoolId, guardianId);
      await this.links.clearPrimary(schoolId, studentId);
    }

    const link = await this.links.create(schoolId, {
      studentId,
      guardianId,
      relationship: dto.relationship,
      isPrimaryContact: dto.isPrimaryContact,
      isFeePayer: dto.isFeePayer,
      canLogin: dto.canLogin,
    });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'guardian_link.created',
      subjectType: SUBJECT,
      subjectId: link.id,
      metadata: { studentId: studentId.toString(), guardianId: dto.guardianId },
    });
    return this.view(schoolId, session, link);
  }

  /**
   * Reads the link in scope, locks its student (StudentsService.lock), and reads the link again
   * under that lock. Call inside a transaction.
   */
  private async lockLink(
    schoolId: SchoolId,
    scope: Scope,
    id: bigint,
  ): Promise<GuardianLinkRecord> {
    const link = await this.links.findById(schoolId, scope, id);
    if (!link) throw notFound();
    await this.students.lock(schoolId, scope, link.studentId);
    const current = await this.links.findById(schoolId, scope, id);
    if (!current) throw notFound();
    return current;
  }

  /**
   * Locks the guardian about to become a primary contact and refuses one without a phone (R30)
   * or merged. GuardiansService's PATCH holds the same lock while it checks before clearing a
   * phone, so the two cannot interleave.
   */
  private async lockPrimaryCandidate(schoolId: SchoolId, guardianId: bigint): Promise<void> {
    const guardian = await readLocked(
      () => this.guardians.findById(schoolId, guardianId),
      (row) => this.guardians.lockIfUnchanged(schoolId, row),
    );
    if (guardian.status === 'merged' || guardian.mergedIntoId !== null) throw merged(guardian);
    if (guardian.phone === null) throw primaryContactNeedsPhone();
  }

  /** R29: refuses taking away the last live fee payer of the link's student. */
  private async assertOtherFeePayer(schoolId: SchoolId, link: GuardianLinkRecord): Promise<void> {
    const live = await this.links.liveForStudent(schoolId, link.studentId);
    if (!live.some((other) => other.id !== link.id && other.isFeePayer)) throw feePayerRequired();
  }

  private async view(
    schoolId: SchoolId,
    session: SchoolSessionContext,
    link: GuardianLinkRecord,
  ): Promise<GuardianLinkDto> {
    const [row] = await this.links.views(schoolId, [link]);
    if (!row) throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    return this.toDto(schoolId, session.access.capabilities, row);
  }
}

const merged = (guardian: GuardianRecord) =>
  new ApiException(
    409,
    ErrorCode.GUARDIAN_MERGED,
    'This guardian was merged into another record. Link the surviving record instead.',
    { mergedIntoId: guardian.mergedIntoId?.toString() ?? null },
  );
