import { Inject, Injectable, Logger } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import { FieldEncryption } from '../../../common/crypto/field-encryption';
import { ApiException, notFound } from '../../../common/errors/api-exception';
import { summariseDatabaseError } from '../../../common/errors/prisma-errors';
import { identityHash, maskIdentityNumber } from '../../../common/identity';
import { readLocked } from '../../../common/locking';
import { toPage, type Page } from '../../../common/pagination';
import { SchoolContext, type Actor } from '../../../common/school-context';
import { ENV, type Env } from '../../../config/env';
import { AuditLogRepository, type AuditEntry } from '../../../repositories/audit-log.repository';
import {
  GuardianRepository,
  type GuardianRecord,
  type GuardianWrite,
} from '../../../repositories/guardian.repository';
import type { SchoolId } from '../../../tenancy/school-id';
import type {
  CreateGuardianDto,
  GuardianDetailDto,
  GuardianDto,
  GuardianLookupDto,
  GuardianLookupHitDto,
  GuardianLookupResultDto,
  GuardianStudentDto,
  ListGuardiansQueryDto,
  ListGuardianStudentsQueryDto,
  UpdateGuardianDto,
} from './guardians.dto';

// contracts/slice-5.md §3.1-§3.6. CNIC digits live only in request bodies and in memory here:
// stored encrypted with their lookup hash, returned masked, never logged or audited.

type AuditMetadata = NonNullable<AuditEntry['metadata']>;

const SUBJECT = 'guardian';
const CNIC_UNIQUE = 'guardians_school_id_cnic_hash_key';
const LOOKUP_MAX = 20;
/** Phone hits read before resolving and de-duplicating; more than this is reported as truncated. */
const LOOKUP_SCAN = 100;
/** Merge hops followed on lookup (R31); a longer chain is a data fault. */
const MAX_MERGE_DEPTH = 5;

/** Field-encryption AAD for guardians.cnic (§3.6). */
export const cnicAad = (schoolId: SchoolId): string => `${schoolId}|guardians|cnic`;

export const guardianMerged = () =>
  new ApiException(
    409,
    ErrorCode.GUARDIAN_MERGED,
    'This guardian was merged into another record and cannot be changed.',
  );
const internalError = () =>
  new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');

@Injectable()
export class GuardiansService {
  private readonly logger = new Logger('GuardiansService');
  private readonly hashKey: string;

  constructor(
    private readonly context: SchoolContext,
    private readonly guardians: GuardianRepository,
    private readonly audit: AuditLogRepository,
    private readonly encryption: FieldEncryption,
    @Inject(ENV) env: Env,
  ) {
    this.hashKey = env.IDENTITY_HASH_KEY;
  }

  async list(query: ListGuardiansQueryDto): Promise<Page<GuardianDto>> {
    const schoolId = this.context.schoolId;
    const phoneDigits = query.q === undefined ? undefined : phoneSearchDigits(query.q);
    const { rows, total } = await this.guardians.list(schoolId, {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.contactCapability === undefined
        ? {}
        : { contactCapability: query.contactCapability }),
      ...(query.hasCnic === undefined ? {} : { hasCnic: query.hasCnic }),
      ...(query.hasPhone === undefined ? {} : { hasPhone: query.hasPhone }),
      ...(query.hasLogin === undefined ? {} : { hasLogin: query.hasLogin }),
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(phoneDigits === undefined ? {} : { phoneDigits }),
      sort: query.sort ?? 'fullName',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(
      rows.map((row) => this.toDto(schoolId, row)),
      query,
      total,
    );
  }

  async get(id: bigint): Promise<GuardianDetailDto> {
    const schoolId = this.context.schoolId;
    return this.toDetailDto(schoolId, await this.require(schoolId, id));
  }

  /** The shape is fixed now; slice 6 brings student_guardians and fills the query. */
  async students(
    id: bigint,
    query: ListGuardianStudentsQueryDto,
  ): Promise<Page<GuardianStudentDto>> {
    await this.require(this.context.schoolId, id);
    return toPage([], query, 0);
  }

  async create(dto: CreateGuardianDto): Promise<GuardianDetailDto> {
    const actor = this.context.actor();
    const cnic = this.identity(dto.cnic ?? null);
    try {
      return await this.createInTransaction(actor, dto, cnic);
    } catch (error) {
      throw await this.cnicConflict(actor.schoolId, error, cnic);
    }
  }

  async update(id: bigint, dto: UpdateGuardianDto): Promise<GuardianDetailDto> {
    const actor = this.context.actor();
    const cnic = dto.cnic === undefined ? undefined : this.identity(dto.cnic);
    try {
      return await this.updateInTransaction(actor, id, dto, cnic);
    } catch (error) {
      throw await this.cnicConflict(actor.schoolId, error, cnic ?? null);
    }
  }

  /**
   * By CNIC hash or exact phone; every hit followed to its survivor (R31), de-duplicated, ordered
   * by name, at most 20 (R32: all phone hits, the office picks). No CNIC and no phone matches
   * nothing (R27). Not audited.
   */
  async lookup(dto: GuardianLookupDto): Promise<GuardianLookupResultDto> {
    const schoolId = this.context.schoolId;
    // The DTO refuses null on either key; this is the "exactly one" rule over what is present.
    if ((dto.cnic === undefined) === (dto.phone === undefined)) {
      throw new ApiException(422, ErrorCode.VALIDATION_FAILED, 'Some fields are invalid.', {
        fields: [
          { path: '', code: ErrorCode.INVALID_VALUE, message: 'Give exactly one of cnic or phone' },
        ],
      });
    }
    let hits: GuardianRecord[];
    if (dto.cnic !== undefined) {
      const hit = await this.guardians.findByCnicHash(
        schoolId,
        identityHash(dto.cnic, this.hashKey),
      );
      hits = hit ? [hit] : [];
    } else {
      hits = await this.guardians.findByPhone(schoolId, dto.phone ?? '', LOOKUP_SCAN + 1);
    }
    const scanTruncated = hits.length > LOOKUP_SCAN;

    const bySurvivor = new Map<bigint, GuardianLookupHitDto>();
    for (const { hit, survivor } of await this.resolveSurvivors(
      schoolId,
      hits.slice(0, LOOKUP_SCAN),
    )) {
      const resolvedFromId = hit.id === survivor.id ? null : hit.id.toString();
      const existing = bySurvivor.get(survivor.id);
      // A direct hit on the survivor wins over reaching it through a merged row.
      if (existing && (existing.resolvedFromId === null || resolvedFromId !== null)) continue;
      bySurvivor.set(survivor.id, {
        guardian: this.toDto(schoolId, survivor),
        resolvedFromId,
        students: [],
      });
    }
    const data = [...bySurvivor.values()].sort(
      (a, b) =>
        compareText(a.guardian.fullName, b.guardian.fullName) ||
        compareIds(a.guardian.id, b.guardian.id),
    );
    return {
      data: data.slice(0, LOOKUP_MAX),
      truncated: scanTruncated || data.length > LOOKUP_MAX,
    };
  }

  /**
   * Reads the guardian, locks it if unchanged since the read (readLocked), and reads it again
   * under the lock: its login lives on users and does not move the guardian's updated_at. The
   * caller decides on current data with concurrent writers queued behind it. Call inside a
   * transaction.
   */
  async lock(schoolId: SchoolId, id: bigint): Promise<GuardianRecord> {
    await readLocked(
      () => this.guardians.findById(schoolId, id),
      (row) => this.guardians.lockIfUnchanged(schoolId, row),
    );
    return this.require(schoolId, id);
  }

  toDto(schoolId: SchoolId, row: GuardianRecord): GuardianDto {
    return {
      id: row.id.toString(),
      fullName: row.fullName,
      cnicMasked:
        row.cnic === null
          ? null
          : maskIdentityNumber(this.encryption.decrypt(row.cnic, cnicAad(schoolId))),
      hasCnic: row.cnic !== null,
      phone: row.phone,
      hasPhone: row.phone !== null,
      contactCapability: row.contactCapability,
      status: row.status,
      mergedIntoId: row.mergedIntoId?.toString() ?? null,
      userId: row.userId?.toString() ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toDetailDto(schoolId: SchoolId, row: GuardianRecord): GuardianDetailDto {
    return { ...this.toDto(schoolId, row), email: row.email, address: row.address };
  }

  @Transactional()
  private async createInTransaction(
    actor: Actor,
    dto: CreateGuardianDto,
    cnic: Identity | null,
  ): Promise<GuardianDetailDto> {
    const { schoolId } = actor;
    if (cnic) await this.assertCnicFree(schoolId, cnic, null);
    const row = await this.guardians.create(schoolId, {
      fullName: dto.fullName,
      cnic: cnic && this.encryption.encrypt(cnic.digits, cnicAad(schoolId)),
      cnicHash: cnic?.hash ?? null,
      phone: dto.phone ?? null,
      email: dto.email ?? null,
      contactCapability: dto.contactCapability,
      address: dto.address ?? null,
    });
    await this.audit.record(schoolId, {
      actorUserId: actor.userId,
      action: 'guardian.created',
      subjectType: SUBJECT,
      subjectId: row.id,
      metadata: {
        hasCnic: row.cnic !== null,
        hasPhone: row.phone !== null,
        contactCapability: row.contactCapability,
      },
    });
    return this.toDetailDto(schoolId, row);
  }

  /**
   * Decided under the row lock (lock). Nothing actually changing is no write and no
   * audit row. Audit metadata records that an identity, contact or address field changed, never
   * its value (an identity number or a phone can trip the audit CHECK; all are personal data).
   */
  @Transactional()
  private async updateInTransaction(
    actor: Actor,
    id: bigint,
    dto: UpdateGuardianDto,
    cnic: Identity | null | undefined,
  ): Promise<GuardianDetailDto> {
    const { schoolId } = actor;
    const row = await this.lock(schoolId, id);
    if (row.status === 'merged') throw guardianMerged();
    if (cnic !== undefined && row.userId !== null) {
      throw new ApiException(
        409,
        ErrorCode.GUARDIAN_CNIC_LOCKED,
        'The CNIC cannot be changed once the guardian has a login: it is the username.',
      );
    }

    const data: Partial<GuardianWrite> = {};
    const changes: Record<string, AuditMetadata[string]> = {};
    if (dto.fullName !== undefined && dto.fullName !== row.fullName) {
      data.fullName = dto.fullName;
      changes.fullName = { from: row.fullName, to: dto.fullName };
    }
    if (dto.contactCapability !== undefined && dto.contactCapability !== row.contactCapability) {
      data.contactCapability = dto.contactCapability;
      changes.contactCapability = { from: row.contactCapability, to: dto.contactCapability };
    }
    if (dto.phone !== undefined && dto.phone !== row.phone) {
      if (dto.phone === null) this.assertPhoneClearable();
      data.phone = dto.phone;
      changes.phone = { changed: true };
    }
    if (dto.email !== undefined && dto.email !== row.email) {
      data.email = dto.email;
      changes.email = { changed: true };
    }
    if (dto.address !== undefined && dto.address !== row.address) {
      data.address = dto.address;
      changes.address = { changed: true };
    }
    if (cnic !== undefined && (cnic?.hash ?? null) !== row.cnicHash) {
      if (cnic) await this.assertCnicFree(schoolId, cnic, row.id);
      data.cnic = cnic && this.encryption.encrypt(cnic.digits, cnicAad(schoolId));
      data.cnicHash = cnic?.hash ?? null;
      changes.cnic = { changed: true };
    }
    if (Object.keys(changes).length === 0) return this.toDetailDto(schoolId, row);

    const updated = await this.guardians.update(schoolId, id, data);
    await this.audit.record(schoolId, {
      actorUserId: actor.userId,
      action: 'guardian.updated',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { changes },
    });
    return this.toDetailDto(schoolId, updated);
  }

  /**
   * R30 (contract §3.5): clearing the phone of a primary contact on a live link is refused with
   * GUARDIAN_IS_PRIMARY_CONTACT. Links arrive in slice 6, which adds the check here.
   */
  private assertPhoneClearable(): void {}

  /** Refuses a CNIC already on another guardian, pointing at that guardian's survivor. */
  private async assertCnicFree(
    schoolId: SchoolId,
    cnic: Identity,
    self: bigint | null,
  ): Promise<void> {
    const holder = await this.guardians.findByCnicHash(schoolId, cnic.hash);
    if (holder && holder.id !== self) throw await this.cnicExists(schoolId, holder);
  }

  /**
   * The race loser of two writes of one CNIC (contract §3.4): the unique violation aborted its
   * transaction, so the winner is read here in a fresh statement and the same 409 returned.
   * Anything else is passed through unchanged.
   */
  private async cnicConflict(
    schoolId: SchoolId,
    error: unknown,
    cnic: Identity | null,
  ): Promise<unknown> {
    if (cnic === null || summariseDatabaseError(error)?.constraint !== CNIC_UNIQUE) return error;
    const holder = await this.guardians.findByCnicHash(schoolId, cnic.hash);
    return holder ? this.cnicExists(schoolId, holder) : error;
  }

  private async cnicExists(schoolId: SchoolId, holder: GuardianRecord): Promise<ApiException> {
    const [resolved] = await this.resolveSurvivors(schoolId, [holder]);
    const survivor = resolved?.survivor ?? holder;
    return new ApiException(
      409,
      ErrorCode.GUARDIAN_CNIC_EXISTS,
      'A guardian with this CNIC already exists.',
      { guardianId: survivor.id.toString() },
    );
  }

  /** Follows merged_into_id from each hit to its survivor, one batched read per hop. */
  private async resolveSurvivors(
    schoolId: SchoolId,
    hits: GuardianRecord[],
  ): Promise<{ hit: GuardianRecord; survivor: GuardianRecord }[]> {
    const resolved = hits.map((hit) => ({ hit, survivor: hit }));
    for (let hops = 0; ; hops++) {
      const pending = resolved.filter((r) => r.survivor.mergedIntoId !== null);
      if (pending.length === 0) return resolved;
      if (hops === MAX_MERGE_DEPTH) throw this.mergeFault(pending[0]?.hit.id);
      const targets = new Map(
        (
          await this.guardians.findByIds(
            schoolId,
            pending.flatMap((r) =>
              r.survivor.mergedIntoId === null ? [] : [r.survivor.mergedIntoId],
            ),
          )
        ).map((g) => [g.id, g]),
      );
      for (const r of pending) {
        const next =
          r.survivor.mergedIntoId === null ? undefined : targets.get(r.survivor.mergedIntoId);
        if (!next) throw this.mergeFault(r.hit.id);
        r.survivor = next;
      }
    }
  }

  /** Logged by id only: no identity data. */
  private mergeFault(guardianId: bigint | undefined): ApiException {
    this.logger.error(
      { guardianId: guardianId?.toString() ?? null, maxDepth: MAX_MERGE_DEPTH },
      'guardian merge chain is broken or longer than the maximum',
    );
    return internalError();
  }

  private async require(schoolId: SchoolId, id: bigint): Promise<GuardianRecord> {
    const row = await this.guardians.findById(schoolId, id);
    if (!row) throw notFound();
    return row;
  }

  /** The DTO has already normalised the input to 13 digits. */
  private identity(digits: string | null): Identity | null {
    return digits === null ? null : { digits, hash: identityHash(digits, this.hashKey) };
  }
}

interface Identity {
  digits: string;
  hash: string;
}

/**
 * The digits to match against phones when `q` looks like part of a phone number: 4-12 digits once
 * `+`, `-` and spaces are removed. A leading 0 (the local form, 0300...) is dropped, since phones
 * are stored as E.164 (+92300...).
 */
function phoneSearchDigits(q: string): string | undefined {
  const digits = q.replace(/[\s+-]/g, '');
  if (!/^[0-9]{4,12}$/.test(digits)) return undefined;
  return digits.replace(/^0/, '');
}

const compareText = (a: string, b: string): number => a.localeCompare(b, 'en');
/** Decimal id strings without leading zeros: the shorter is the smaller. */
const compareIds = (a: string, b: string): number =>
  a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
