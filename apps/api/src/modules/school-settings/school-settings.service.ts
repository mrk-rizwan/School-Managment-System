import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { ApiException } from '../../common/errors/api-exception';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import {
  SchoolSettingsRepository,
  type SchoolSettingsRecord,
} from '../../repositories/school-settings.repository';
import type { SchoolId } from '../../tenancy/school-id';
import type { SchoolSettingsDto, UpdateSchoolSettingsDto } from './school-settings.dto';

// Every school has its row from creation (slice 1); its absence is a data fault, not a 404.
const missing = () => new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');

const toDto = (row: SchoolSettingsRecord): SchoolSettingsDto => ({
  feeDueDay: row.feeDueDay,
  studentLoginEnabled: row.studentLoginEnabled,
  updatedAt: row.updatedAt,
});

/** The school's own settings (contract slice-2 §6). */
@Injectable()
export class SchoolSettingsService {
  constructor(
    private readonly settings: SchoolSettingsRepository,
    private readonly audit: AuditLogRepository,
  ) {}

  async get(schoolId: SchoolId): Promise<SchoolSettingsDto> {
    const row = await this.settings.find(schoolId);
    if (!row) throw missing();
    return toDto(row);
  }

  /** Locks the row, writes only what changed, and audits only a real change. */
  @Transactional()
  async update(session: SchoolSessionContext, dto: UpdateSchoolSettingsDto): Promise<SchoolSettingsDto> {
    const { schoolId } = session;
    const current = await this.settings.lock(schoolId);
    if (!current) throw missing();
    const changes: Record<string, { from: number | boolean; to: number | boolean }> = {};
    const data: { feeDueDay?: number; studentLoginEnabled?: boolean } = {};
    if (dto.feeDueDay !== undefined && dto.feeDueDay !== current.feeDueDay) {
      data.feeDueDay = dto.feeDueDay;
      changes.feeDueDay = { from: current.feeDueDay, to: dto.feeDueDay };
    }
    if (
      dto.studentLoginEnabled !== undefined &&
      dto.studentLoginEnabled !== current.studentLoginEnabled
    ) {
      data.studentLoginEnabled = dto.studentLoginEnabled;
      changes.studentLoginEnabled = { from: current.studentLoginEnabled, to: dto.studentLoginEnabled };
    }
    if (Object.keys(changes).length === 0) return toDto(current);
    const updated = await this.settings.update(schoolId, data);
    await this.audit.record(schoolId, {
      actorUserId: session.access.userId,
      action: 'school_settings.updated',
      subjectType: 'school_settings',
      subjectId: updated.id,
      metadata: { changes },
    });
    return toDto(updated);
  }
}
