import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode, MESSAGE_TYPES, type MessageType } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import { diffFields } from '../../common/diff';
import { ApiException } from '../../common/errors/api-exception';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { OwnSchoolRepository } from '../../repositories/own-school.repository';
import {
  SchoolSettingsRepository,
  type SchoolSettingsChanges,
  type SchoolSettingsRecord,
} from '../../repositories/school-settings.repository';
import type { SchoolId } from '../../tenancy/school-id';
import type { SchoolSettingsDto, UpdateSchoolSettingsDto } from './school-settings.dto';

// Every school has its row from creation (slice 1); its absence is a data fault, not a 404.
const missing = () => new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');

/** A TIME column as Prisma reads it (1970-01-01 UTC) → `HH:MM`. */
const toLocalTime = (value: Date): string => value.toISOString().slice(11, 16);
/** `HH:MM` → the TIME column's value. */
const fromLocalTime = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);

const ascending = (days: readonly number[]): number[] => [...days].sort((a, b) => a - b);
/** In the order of the message-type table (contracts/slice-9.md §7.2). */
const inTableOrder = (types: readonly MessageType[]): MessageType[] =>
  MESSAGE_TYPES.filter((type) => types.includes(type));

const toDto = (row: SchoolSettingsRecord, smsMonthlyCap: number): SchoolSettingsDto => ({
  feeDueDay: row.feeDueDay,
  studentLoginEnabled: row.studentLoginEnabled,
  periodsPerDay: row.periodsPerDay,
  weeklyOffDays: ascending(row.weeklyOffDays),
  attendanceAmendWindowDays: row.attendanceAmendWindowDays,
  registerDeadlineTime: toLocalTime(row.registerDeadlineTime),
  absenceAlertTime: toLocalTime(row.absenceAlertTime),
  lateAdviceEnabled: row.lateAdviceEnabled,
  lateCountsAs: row.lateCountsAs,
  lateCutoffTime: row.lateCutoffTime === null ? null : toLocalTime(row.lateCutoffTime),
  leaveCountsAs: row.leaveCountsAs,
  smsMonthlyCap,
  smsAllowedTypes: inTableOrder(row.smsAllowedTypes),
  remarkDefaultVisibility: row.remarkDefaultVisibility,
  remarkNotifyGuardians: row.remarkNotifyGuardians,
  feeCutoffDay: row.feeCutoffDay,
  lateFeeEnabled: row.lateFeeEnabled,
  lateFeeAmount: row.lateFeeAmount,
  lateFeeGraceDays: row.lateFeeGraceDays,
  lateFeeEnabledAt: row.lateFeeEnabledAt,
  expenseApprovalThreshold: row.expenseApprovalThreshold,
  payDay: row.payDay,
  feeReminderDaysBefore: row.feeReminderDaysBefore,
  overdueReminderEveryDays: row.overdueReminderEveryDays,
  updatedAt: row.updatedAt,
});

type Scalar = string | number | boolean | null;

/** Audit metadata holds scalars: arrays are recorded comma-joined. */
const flat = (value: Scalar | readonly (number | string)[]): Scalar =>
  value !== null && typeof value === 'object' ? value.join(',') : value;

/** Every writable field, in DTO order (contract slice-2 §6, slice-9 §4). */
const WRITABLE = [
  'feeDueDay',
  'studentLoginEnabled',
  'periodsPerDay',
  'weeklyOffDays',
  'attendanceAmendWindowDays',
  'registerDeadlineTime',
  'absenceAlertTime',
  'lateAdviceEnabled',
  'lateCountsAs',
  'lateCutoffTime',
  'leaveCountsAs',
  'smsAllowedTypes',
  'remarkDefaultVisibility',
  'remarkNotifyGuardians',
  // phase-3-financial.md §3.8 (lateFeeEnabledAt is stamped, never written by a client).
  'feeCutoffDay',
  'lateFeeEnabled',
  'lateFeeAmount',
  'lateFeeGraceDays',
  'expenseApprovalThreshold',
  'payDay',
  'feeReminderDaysBefore',
  'overdueReminderEveryDays',
] as const satisfies readonly (keyof UpdateSchoolSettingsDto & keyof SchoolSettingsDto)[];

const lateFeeAmountRequired = () =>
  new ApiException(422, ErrorCode.VALIDATION_FAILED, 'Some fields are invalid.', {
    fields: [
      {
        path: 'lateFeeAmount',
        code: ErrorCode.INVALID_VALUE,
        message: 'lateFeeAmount is required while late fees are enabled',
      },
    ],
  });

const lateCutoffRequired = () =>
  new ApiException(422, ErrorCode.VALIDATION_FAILED, 'Some fields are invalid.', {
    fields: [
      {
        path: 'lateCutoffTime',
        code: ErrorCode.INVALID_VALUE,
        message: 'lateCutoffTime is required when late arrivals count as absent after a cut-off',
      },
    ],
  });

/** The school's own settings (contract slice-2 §6, slice-9 §4). */
@Injectable()
export class SchoolSettingsService {
  constructor(
    private readonly settings: SchoolSettingsRepository,
    private readonly ownSchool: OwnSchoolRepository,
    private readonly audit: AuditLogRepository,
  ) {}

  async get(schoolId: SchoolId): Promise<SchoolSettingsDto> {
    const row = await this.settings.find(schoolId);
    if (!row) throw missing();
    return toDto(row, await this.smsMonthlyCap(schoolId));
  }

  /**
   * Locks the row, writes only what changed, and audits only a real change: one action, its
   * `changes` as scalar from/to pairs, arrays comma-joined (audit metadata holds scalars).
   */
  @Transactional()
  async update(session: SchoolSessionContext, dto: UpdateSchoolSettingsDto): Promise<SchoolSettingsDto> {
    const { schoolId } = session;
    const current = await this.settings.lock(schoolId);
    if (!current) throw missing();
    const before = toDto(current, 0);

    // The requested values in DTO form (normalised as they are returned), then compared.
    const wanted: UpdateSchoolSettingsDto = {
      ...dto,
      ...(dto.weeklyOffDays === undefined ? {} : { weeklyOffDays: ascending(dto.weeklyOffDays) }),
      ...(dto.smsAllowedTypes === undefined
        ? {}
        : { smsAllowedTypes: inTableOrder(dto.smsAllowedTypes) }),
    };
    // contracts/slice-9.md §4: after the patch, absent_after_cutoff needs a cut-off time.
    const lateCountsAs = dto.lateCountsAs ?? before.lateCountsAs;
    const lateCutoffTime = dto.lateCutoffTime === undefined ? before.lateCutoffTime : dto.lateCutoffTime;
    if (lateCountsAs === 'absent_after_cutoff' && lateCutoffTime === null) throw lateCutoffRequired();
    // §3.8, R178: late fees need an amount while on; switching them on stamps the time.
    const lateFeeEnabled = dto.lateFeeEnabled ?? before.lateFeeEnabled;
    const lateFeeAmount = dto.lateFeeAmount === undefined ? before.lateFeeAmount : dto.lateFeeAmount;
    if (lateFeeEnabled && lateFeeAmount === null) throw lateFeeAmountRequired();

    const { data: diff, changes } = diffFields(before, wanted, WRITABLE, flat);
    const data: SchoolSettingsChanges = {};
    for (const key of WRITABLE) {
      if (diff[key] !== undefined) Object.assign(data, { [key]: this.column(key, diff[key]) });
    }
    if (Object.keys(changes).length === 0) {
      return toDto(current, await this.smsMonthlyCap(schoolId));
    }
    if (lateFeeEnabled && !before.lateFeeEnabled) data.lateFeeEnabledAt = new Date();
    const updated = await this.settings.update(schoolId, data);
    await this.audit.record(schoolId, {
      actorUserId: session.access.userId,
      action: 'school_settings.updated',
      subjectType: 'school_settings',
      subjectId: updated.id,
      metadata: { changes },
    });
    return toDto(updated, await this.smsMonthlyCap(schoolId));
  }

  /** A DTO value as its column stores it: times become TIME values; the rest is as is. */
  private column(key: keyof SchoolSettingsDto, value: unknown): unknown {
    if (key === 'registerDeadlineTime' || key === 'absenceAlertTime' || key === 'lateCutoffTime') {
      return typeof value === 'string' ? fromLocalTime(value) : null;
    }
    return value;
  }

  private async smsMonthlyCap(schoolId: SchoolId): Promise<number> {
    const school = await this.ownSchool.find(schoolId);
    if (!school) throw missing();
    return school.smsMonthlyCap;
  }
}
