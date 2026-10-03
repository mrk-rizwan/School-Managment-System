import { Inject, Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import { FieldEncryption } from '../../../common/crypto/field-encryption';
import { ApiException, fieldRefused, notFound } from '../../../common/errors/api-exception';
import { summariseDatabaseError } from '../../../common/errors/prisma-errors';
import { identityHash, maskIdentityNumber, staffCnicAad } from '../../../common/identity';
import { readLocked } from '../../../common/locking';
import { toPage, type Page } from '../../../common/pagination';
import { SchoolContext, type Actor } from '../../../common/school-context';
import { ENV, type Env } from '../../../config/env';
import { AuditLogRepository, type AuditEntry } from '../../../repositories/audit-log.repository';
import {
  StaffRepository,
  type NewStaff,
  type StaffRecord,
} from '../../../repositories/staff.repository';
import { UserRoleRepository, type LiveRoles } from '../../../repositories/user-role.repository';
import type { SchoolId } from '../../../tenancy/school-id';
import { fromDateString, toDateString } from '../../academics/academics.shared';
import { addDays, SchoolClock } from '../../../common/school-clock';
import type { CreateStaffDto, ListStaffQueryDto, StaffDto, UpdateStaffDto } from './staff.dto';

// contracts/slice-4.md §3.1-§3.4. CNIC digits live only in request bodies and in memory here:
// stored encrypted with their lookup hash, returned masked, never logged or audited.

type AuditMetadata = NonNullable<AuditEntry['metadata']>;

const SUBJECT = 'staff';
const CNIC_UNIQUE = 'staff_school_id_cnic_hash_key';
/** joinedOn may be planned at most this far ahead (contract §3.3). */
const JOINED_ON_MAX_AHEAD_DAYS = 366;

interface Identity {
  digits: string;
  hash: string;
}

/** Staff records: list, read, create, edit (contract §3.1-§3.4), and the shared row lock. */
@Injectable()
export class StaffService {
  private readonly hashKey: string;

  constructor(
    private readonly context: SchoolContext,
    private readonly staff: StaffRepository,
    private readonly roles: UserRoleRepository,
    private readonly audit: AuditLogRepository,
    private readonly encryption: FieldEncryption,
    private readonly clock: SchoolClock,
    @Inject(ENV) env: Env,
  ) {
    this.hashKey = env.IDENTITY_HASH_KEY;
  }

  async list(query: ListStaffQueryDto): Promise<Page<StaffDto>> {
    const schoolId = this.context.schoolId;
    const phoneDigits = query.q === undefined ? undefined : phoneSearchDigits(query.q);
    const { rows, total } = await this.staff.list(schoolId, {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.role === undefined ? {} : { role: query.role }),
      ...(query.hasLogin === undefined ? {} : { hasLogin: query.hasLogin }),
      ...(query.hasCnic === undefined ? {} : { hasCnic: query.hasCnic }),
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(phoneDigits === undefined ? {} : { phoneDigits }),
      sort: query.sort ?? 'fullName',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(await this.toDtos(schoolId, rows), query, total);
  }

  get(id: bigint): Promise<StaffDto> {
    return this.read(this.context.schoolId, id);
  }

  /** The StaffDto of a row in the given school; 404 when absent. */
  async read(schoolId: SchoolId, id: bigint): Promise<StaffDto> {
    const row = await this.staff.findById(schoolId, id);
    if (!row) throw notFound();
    const [dto] = await this.toDtos(schoolId, [row]);
    if (!dto) throw notFound();
    return dto;
  }

  async create(dto: CreateStaffDto): Promise<StaffDto> {
    const actor = this.context.actor();
    const cnic = this.identity(dto.cnic ?? null);
    let id: bigint;
    try {
      id = await this.createInTransaction(actor, dto, cnic);
    } catch (error) {
      throw await this.cnicConflict(actor.schoolId, error, cnic);
    }
    return this.get(id);
  }

  async update(id: bigint, dto: UpdateStaffDto): Promise<StaffDto> {
    const actor = this.context.actor();
    const cnic = dto.cnic === undefined ? undefined : this.identity(dto.cnic);
    try {
      await this.updateInTransaction(actor, id, dto, cnic);
    } catch (error) {
      throw await this.cnicConflict(actor.schoolId, error, cnic ?? null);
    }
    return this.get(id);
  }

  /**
   * Reads the staff row, locks it if unchanged since the read (readLocked), and reads it again
   * under the lock: its login lives on users and does not move the row's updated_at. 404 when
   * absent. Call inside a transaction.
   */
  async lock(schoolId: SchoolId, id: bigint): Promise<StaffRecord> {
    await readLocked(
      () => this.staff.findById(schoolId, id),
      (row) => this.staff.lockIfUnchanged(schoolId, row),
    );
    const row = await this.staff.findById(schoolId, id);
    if (!row) throw notFound();
    return row;
  }

  /** The decrypted 13 digits of the row's CNIC, or null when none is recorded. */
  cnicDigits(schoolId: SchoolId, row: Pick<StaffRecord, 'cnic'>): string | null {
    return row.cnic === null ? null : this.encryption.decrypt(row.cnic, staffCnicAad(schoolId));
  }

  @Transactional()
  private async createInTransaction(
    actor: Actor,
    dto: CreateStaffDto,
    cnic: Identity | null,
  ): Promise<bigint> {
    const { schoolId } = actor;
    const joinedOn = dto.joinedOn === undefined ? null : fromDateString(dto.joinedOn);
    if (joinedOn) await this.assertJoinedOnAllowed(schoolId, joinedOn);
    if (cnic) await this.assertCnicFree(schoolId, cnic, null);
    const id = await this.staff.create(schoolId, {
      fullName: dto.fullName,
      cnic: cnic && this.encryption.encrypt(cnic.digits, staffCnicAad(schoolId)),
      cnicHash: cnic?.hash ?? null,
      phone: dto.phone,
      designation: dto.designation ?? null,
      joinedOn,
    });
    await this.audit.record(schoolId, {
      actorUserId: actor.userId,
      action: 'staff.created',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { hasCnic: cnic !== null },
    });
    return id;
  }

  /**
   * Decided under the row lock. Nothing actually changing is no write and no audit row. The
   * audit records that the CNIC or phone changed, never the value.
   */
  @Transactional()
  private async updateInTransaction(
    actor: Actor,
    id: bigint,
    dto: UpdateStaffDto,
    cnic: Identity | null | undefined,
  ): Promise<void> {
    const { schoolId } = actor;
    const row = await this.lock(schoolId, id);
    // R24: the CNIC is the username once a login exists; any change to it is refused.
    if (cnic !== undefined && row.userId !== null) {
      throw new ApiException(
        409,
        ErrorCode.STAFF_CNIC_LOCKED,
        'The CNIC cannot be changed once the staff member has a login: it is the username.',
      );
    }

    const data: Partial<NewStaff> = {};
    const changes: Record<string, AuditMetadata[string]> = {};
    if (dto.fullName !== undefined && dto.fullName !== row.fullName) {
      data.fullName = dto.fullName;
      changes.fullName = { from: row.fullName, to: dto.fullName };
    }
    if (dto.phone !== undefined && dto.phone !== row.phone) {
      data.phone = dto.phone;
      changes.phone = { changed: true };
    }
    if (dto.designation !== undefined && dto.designation !== row.designation) {
      data.designation = dto.designation;
      changes.designation = { from: row.designation, to: dto.designation };
    }
    if (dto.joinedOn !== undefined) {
      const joinedOn = dto.joinedOn === null ? null : fromDateString(dto.joinedOn);
      const current = row.joinedOn === null ? null : toDateString(row.joinedOn);
      if (dto.joinedOn !== current) {
        if (joinedOn) {
          await this.assertJoinedOnAllowed(schoolId, joinedOn);
          // CHECK staff_left_on_after_joined_check, as a 422 rather than a 500.
          if (row.leftOn && joinedOn > row.leftOn) {
            throw fieldRefused('joinedOn', ErrorCode.INVALID_VALUE, 'joinedOn must not be after the last day');
          }
        }
        data.joinedOn = joinedOn;
        changes.joinedOn = { from: current, to: dto.joinedOn };
      }
    }
    if (cnic !== undefined && (cnic?.hash ?? null) !== row.cnicHash) {
      if (cnic) await this.assertCnicFree(schoolId, cnic, row.id);
      data.cnic = cnic && this.encryption.encrypt(cnic.digits, staffCnicAad(schoolId));
      data.cnicHash = cnic?.hash ?? null;
      changes.cnic = { changed: true };
    }
    if (Object.keys(changes).length === 0) return;

    await this.staff.update(schoolId, id, data);
    await this.audit.record(schoolId, {
      actorUserId: actor.userId,
      action: 'staff.updated',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { changes },
    });
  }

  private async assertJoinedOnAllowed(schoolId: SchoolId, joinedOn: Date): Promise<void> {
    const latest = addDays(await this.clock.today(schoolId), JOINED_ON_MAX_AHEAD_DAYS);
    if (joinedOn > latest) {
      throw fieldRefused(
        'joinedOn',
        ErrorCode.INVALID_VALUE,
        `joinedOn must be at most ${JOINED_ON_MAX_AHEAD_DAYS} days ahead`,
      );
    }
  }

  /** R20: refuses a CNIC already on another staff row (any status), pointing at it. */
  private async assertCnicFree(schoolId: SchoolId, cnic: Identity, self: bigint | null): Promise<void> {
    const holder = await this.staff.findByCnicHash(schoolId, cnic.hash);
    if (holder && holder.id !== self) throw cnicExists(holder.id);
  }

  /**
   * The race loser of two writes of one CNIC (contract §3.3): the unique violation aborted its
   * transaction, so the winner is read here in a fresh statement and the same 409 returned.
   * Anything else is passed through unchanged.
   */
  private async cnicConflict(
    schoolId: SchoolId,
    error: unknown,
    cnic: Identity | null,
  ): Promise<unknown> {
    if (cnic === null || summariseDatabaseError(error)?.constraint !== CNIC_UNIQUE) return error;
    const holder = await this.staff.findByCnicHash(schoolId, cnic.hash);
    return holder ? cnicExists(holder.id) : error;
  }

  /** StaffDto for each row: one read of the live roles of their logins. */
  async toDtos(schoolId: SchoolId, rows: StaffRecord[]): Promise<StaffDto[]> {
    const userIds = rows.flatMap((row) => (row.userId === null ? [] : [row.userId]));
    const roles = await this.roles.liveRolesByUser(schoolId, userIds);
    const none: LiveRoles = { systemRoles: [], customRoleNames: [] };
    return rows.map((row) =>
      this.toDto(schoolId, row, row.userId === null ? none : (roles.get(row.userId) ?? none)),
    );
  }

  private toDto(schoolId: SchoolId, row: StaffRecord, { systemRoles, customRoleNames }: LiveRoles): StaffDto {
    const digits = this.cnicDigits(schoolId, row);
    return {
      id: row.id.toString(),
      fullName: row.fullName,
      cnicMasked: digits === null ? null : maskIdentityNumber(digits),
      hasCnic: row.cnic !== null,
      phone: row.phone,
      designation: row.designation,
      joinedOn: row.joinedOn === null ? null : toDateString(row.joinedOn),
      status: row.status,
      userId: row.userId?.toString() ?? null,
      systemRoles,
      customRoleNames,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** The DTO has already normalised the input to 13 digits. */
  private identity(digits: string | null): Identity | null {
    return digits === null ? null : { digits, hash: identityHash(digits, this.hashKey) };
  }
}

const cnicExists = (staffId: bigint): ApiException =>
  new ApiException(409, ErrorCode.STAFF_CNIC_EXISTS, 'A staff member with this CNIC already exists.', {
    staffId: staffId.toString(),
  });

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
