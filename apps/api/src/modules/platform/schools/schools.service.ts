import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import {
  canChangeSchoolStatus,
  DEFAULT_FEE_DUE_DAY,
  DEFAULT_TIMEZONE,
  ErrorCode,
  type SchoolStatus,
} from '@asms/shared';
import { ApiException, notFound } from '../../../common/errors/api-exception';
import { toPage, type Page } from '../../../common/pagination';
import { PlatformAuditRepository } from '../../../repositories/platform/platform-audit.repository';
import { SchoolRepository, type SchoolRecord } from '../../../repositories/platform/school.repository';
import { SchoolCounterRepository } from '../../../repositories/school-counter.repository';
import { SchoolSettingsRepository } from '../../../repositories/school-settings.repository';
import { fromPlatformSchool } from '../../../tenancy/school-id.mint';
import type {
  ChangeSchoolStatusDto,
  CreateSchoolDto,
  ListSchoolsQueryDto,
  SchoolDto,
  UpdateSchoolDto,
} from './schools.dto';

const SUBJECT = 'school';

/** Reads before giving up when the row keeps changing between the read and the lock or write. */
const ATTEMPTS = 3;

const terminated = () =>
  new ApiException(409, ErrorCode.SCHOOL_TERMINATED, 'A terminated school cannot be changed.');

export function toSchoolDto(school: SchoolRecord): SchoolDto {
  return {
    id: school.id.toString(),
    name: school.name,
    shortCode: school.shortCode,
    status: school.status,
    timezone: school.timezone,
    createdAt: school.createdAt,
    updatedAt: school.updatedAt,
  };
}

/** Platform management of the school record (contracts/slice-1.md section 4). */
@Injectable()
export class SchoolsService {
  constructor(
    private readonly schools: SchoolRepository,
    private readonly settings: SchoolSettingsRepository,
    private readonly counters: SchoolCounterRepository,
    private readonly audit: PlatformAuditRepository,
  ) {}

  async list(query: ListSchoolsQueryDto): Promise<Page<SchoolDto>> {
    const { rows, total } = await this.schools.list({
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.q === undefined ? {} : { q: query.q }),
      sort: query.sort ?? 'name',
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(rows.map(toSchoolDto), query, total);
  }

  async get(id: bigint): Promise<SchoolDto> {
    return toSchoolDto(await this.require(id));
  }

  /**
   * The tenant comes into being (named exception 1): the school row, its settings, its admission
   * counter and the audit row, in one transaction. A taken short code fails the first insert
   * (constraint schools_short_code_key, mapped to 409 SCHOOL_SHORT_CODE_TAKEN) and nothing is kept.
   */
  @Transactional()
  async create(actorId: bigint, dto: CreateSchoolDto): Promise<SchoolDto> {
    const timezone = dto.timezone ?? DEFAULT_TIMEZONE;
    const feeDueDay = dto.feeDueDay ?? DEFAULT_FEE_DUE_DAY;
    const school = await this.schools.create({
      name: dto.name,
      shortCode: dto.shortCode,
      timezone,
    });
    const schoolId = fromPlatformSchool(school);
    await this.settings.create(schoolId, { feeDueDay });
    await this.counters.create(schoolId, 'admission_no');
    await this.audit.record({
      actorPlatformUserId: actorId,
      schoolId: school.id,
      action: 'school.created',
      subjectType: SUBJECT,
      subjectId: school.id,
      metadata: { shortCode: school.shortCode, name: school.name, timezone, feeDueDay },
    });
    return toSchoolDto(school);
  }

  /**
   * Decided under the row lock: the row is read, locked only if it still holds what was read
   * (otherwise read again), and only then compared. So two concurrent PATCHes audit a chain
   * (X to Y, then Y to Z), never two changes from X, and setting the value a concurrent PATCH is
   * replacing is applied after it rather than taken for a no-op.
   */
  @Transactional()
  async update(actorId: bigint, id: bigint, dto: UpdateSchoolDto): Promise<SchoolDto> {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const school = await this.require(id);
      if (dto.shortCode !== undefined) {
        throw new ApiException(
          409,
          ErrorCode.SCHOOL_SHORT_CODE_IMMUTABLE,
          'A school short code cannot be changed.',
          { field: 'shortCode' },
        );
      }
      if (school.status === 'terminated') throw terminated();
      // An empty body: nothing to compare, so nothing to lock.
      if (dto.name === undefined && dto.timezone === undefined) return toSchoolDto(school);
      if (!(await this.schools.lockIfUnchanged(school))) continue;

      const data: { name?: string; timezone?: string } = {};
      const changes: Record<string, { from: string; to: string }> = {};
      if (dto.name !== undefined && dto.name !== school.name) {
        data.name = dto.name;
        changes.name = { from: school.name, to: dto.name };
      }
      if (dto.timezone !== undefined && dto.timezone !== school.timezone) {
        data.timezone = dto.timezone;
        changes.timezone = { from: school.timezone, to: dto.timezone };
      }
      // Nothing actually changes: no write, no audit row.
      if (Object.keys(changes).length === 0) return toSchoolDto(school);

      await this.schools.update(id, data);
      await this.audit.record({
        actorPlatformUserId: actorId,
        schoolId: id,
        action: 'school.updated',
        subjectType: SUBJECT,
        subjectId: id,
        metadata: { changes },
      });
      return toSchoolDto(await this.require(id));
    }
    // The row changed under this request on every attempt: the caller retries rather than this
    // request looping.
    throw new ApiException(
      409,
      ErrorCode.CONCURRENT_UPDATE,
      'The school changed while this request ran. Reload and try again.',
    );
  }

  /**
   * Checked and applied as compare-and-set: the update matches only while the status is still
   * the one the transition was checked against. If another request changed it in between, the
   * update matches nothing and the decision is taken again on the fresh row, which gives the
   * outcome a FOR UPDATE lock would (contract 4.5) without raw SQL.
   */
  @Transactional()
  async changeStatus(actorId: bigint, id: bigint, dto: ChangeSchoolStatusDto): Promise<SchoolDto> {
    const to: SchoolStatus = dto.status;
    let from: SchoolStatus | undefined;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const school = await this.require(id);
      from = school.status;
      // A double-submitted dialog: unchanged, no audit row.
      if (from === to) return toSchoolDto(school);
      if (!canChangeSchoolStatus(from, to)) {
        throw new ApiException(
          409,
          ErrorCode.ILLEGAL_STATUS_TRANSITION,
          `A ${from} school cannot become ${to}.`,
          { from, to },
        );
      }
      if ((await this.schools.changeStatus(id, from, to)) === 0) continue;
      await this.audit.record({
        actorPlatformUserId: actorId,
        schoolId: id,
        action: 'school.status_changed',
        subjectType: SUBJECT,
        subjectId: id,
        reason: dto.reason,
        metadata: { from, to },
      });
      return toSchoolDto(await this.require(id));
    }
    // Lost the race on every attempt: the caller reloads rather than this request looping.
    // `from` is the status last read (contract 4.5: details { from, to }).
    throw new ApiException(
      409,
      ErrorCode.ILLEGAL_STATUS_TRANSITION,
      'The school status changed while this request ran. Reload and try again.',
      { from, to },
    );
  }

  private async require(id: bigint): Promise<SchoolRecord> {
    const school = await this.schools.findById(id);
    if (!school) throw notFound();
    return school;
  }
}
