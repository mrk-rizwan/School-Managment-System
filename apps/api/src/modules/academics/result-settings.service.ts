import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { bandsProblem, ErrorCode, type GradeBand } from '@asms/shared';
import { fieldRefused, notFound } from '../../common/errors/api-exception';
import { readLocked } from '../../common/locking';
import { SchoolContext } from '../../common/school-context';
import { AcademicYearRepository } from '../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import {
  ResultSettingsRepository,
  type ResultSettingsChanges,
  type ResultSettingsRecord,
} from '../../repositories/result-settings.repository';
import { type Changes, yearClosed } from './academics.shared';
import type { ResultSettingsDto, UpdateResultSettingsDto } from './result-settings.dto';

const SUBJECT = 'result_settings';

function toDto(row: ResultSettingsRecord): ResultSettingsDto {
  return {
    academicYearId: row.academicYearId.toString(),
    testWeight: row.testWeight,
    examWeight: row.examWeight,
    passPercent: row.passPercent,
    passRule: row.passRule,
    bands: row.bands.map((b) => ({ grade: b.grade, minPercent: b.minPercent })),
    showPosition: row.showPosition,
    showAttendance: row.showAttendance,
    showRemark: row.showRemark,
    withholdCardForDues: row.withholdCardForDues,
    notifyClassTests: row.notifyClassTests,
    // Wave O adds result_sheets and the lock (RESULT_SETTINGS_LOCKED, trigger result_settings_locked).
    locked: false,
    updatedAt: row.updatedAt,
  };
}

/** `A+:90 A:80 ... F:0`, for the audit row. */
const bandsText = (bands: readonly GradeBand[]): string => bands.map((b) => `${b.grade}:${b.minPercent}`).join(' ');

const SCALARS = [
  'testWeight',
  'examWeight',
  'passPercent',
  'passRule',
  'showPosition',
  'showAttendance',
  'showRemark',
  'withholdCardForDues',
  'notifyClassTests',
] as const;

/**
 * The result rules of an academic year (phase-4-academic.md §3.7, R255, contracts/slice-29.md
 * §3): weights, pass mark and rule, grade bands and the card toggles. One row per year, seeded
 * with it. Frozen once a sheet of the year is approved (R256, from wave O).
 */
@Injectable()
export class ResultSettingsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly settings: ResultSettingsRepository,
    private readonly years: AcademicYearRepository,
    private readonly audit: AuditLogRepository,
  ) {}

  async get(academicYearId: bigint): Promise<ResultSettingsDto> {
    const row = await this.settings.findForYear(this.context.schoolId, academicYearId);
    if (!row) throw notFound();
    return toDto(row);
  }

  /** Given fields, validated whole after the merge: weights sum to 100, bands by bandsProblem. */
  @Transactional()
  async update(academicYearId: bigint, dto: UpdateResultSettingsDto): Promise<ResultSettingsDto> {
    const { schoolId, userId } = this.context.actor();
    const year = await readLocked(
      () => this.years.findById(schoolId, academicYearId),
      (row) => this.years.lockIfUnchanged(schoolId, row),
    );
    if (year.status === 'closed') throw yearClosed();
    const current = await this.settings.findForYear(schoolId, academicYearId);
    if (!current) throw notFound();

    const data: ResultSettingsChanges = {};
    const changes: Changes = {};
    for (const key of SCALARS) {
      const value = dto[key];
      if (value !== undefined && value !== current[key]) {
        Object.assign(data, { [key]: value });
        changes[key] = {
          from: typeof current[key] === 'boolean' ? String(current[key]) : current[key],
          to: typeof value === 'boolean' ? String(value) : value,
        };
      }
    }
    if (dto.bands !== undefined) {
      const bands = dto.bands.map((b) => ({ grade: b.grade, minPercent: b.minPercent }));
      const problem = bandsProblem(bands);
      if (problem) throw fieldRefused('bands', ErrorCode.INVALID_VALUE, problem);
      if (bandsText(bands) !== bandsText(current.bands)) {
        data.bands = bands;
        changes.bands = { from: bandsText(current.bands), to: bandsText(bands) };
      }
    }
    if ((data.testWeight ?? current.testWeight) + (data.examWeight ?? current.examWeight) !== 100) {
      throw fieldRefused('testWeight', ErrorCode.INVALID_VALUE, 'testWeight and examWeight must sum to 100');
    }
    if (Object.keys(changes).length === 0) return toDto(current);

    const updated = await this.settings.update(schoolId, academicYearId, data, userId);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'result_settings.updated',
      subjectType: SUBJECT,
      subjectId: updated.id,
      metadata: { academicYearId: academicYearId.toString(), changes },
    });
    return toDto(updated);
  }
}
