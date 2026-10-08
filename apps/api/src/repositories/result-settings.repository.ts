import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { GradeBand, PassRule } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

export interface ResultSettingsRecord {
  id: bigint;
  academicYearId: bigint;
  testWeight: number;
  examWeight: number;
  passPercent: number;
  passRule: PassRule;
  /** As stored; the service validates a write whole with bandsProblem (R255). */
  bands: GradeBand[];
  showPosition: boolean;
  showAttendance: boolean;
  showRemark: boolean;
  withholdCardForDues: boolean;
  notifyClassTests: boolean;
  updatedBy: bigint | null;
  updatedAt: Date;
}

export type ResultSettingsChanges = Partial<
  Pick<
    ResultSettingsRecord,
    | 'testWeight'
    | 'examWeight'
    | 'passPercent'
    | 'passRule'
    | 'bands'
    | 'showPosition'
    | 'showAttendance'
    | 'showRemark'
    | 'withholdCardForDues'
    | 'notifyClassTests'
  >
>;

const SELECT = {
  id: true,
  academicYearId: true,
  testWeight: true,
  examWeight: true,
  passPercent: true,
  passRule: true,
  bands: true,
  showPosition: true,
  showAttendance: true,
  showRemark: true,
  withholdCardForDues: true,
  notifyClassTests: true,
  updatedBy: true,
  updatedAt: true,
} satisfies Prisma.ResultSettingsSelect;

type Row = Prisma.ResultSettingsGetPayload<{ select: typeof SELECT }>;

/** The stored JSON as bands: an array of { grade, minPercent } (CHECK result_settings_bands_check). */
function toBands(value: Prisma.JsonValue): GradeBand[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
    const { grade, minPercent } = entry;
    return typeof grade === 'string' && typeof minPercent === 'number' ? [{ grade, minPercent }] : [];
  });
}

const toRecord = ({ bands, ...row }: Row): ResultSettingsRecord => ({ ...row, bands: toBands(bands) });

/**
 * The result rules of an academic year (tenant table result_settings, phase-4-academic.md §3.7):
 * one row per year, written with the year by asms_seed_year_results.
 */
@Injectable()
export class ResultSettingsRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async findForYear(schoolId: SchoolId, academicYearId: bigint): Promise<ResultSettingsRecord | null> {
    const row = await this.txHost.tx.resultSettings.findFirst({
      where: { schoolId, academicYearId },
      select: SELECT,
    });
    return row && toRecord(row);
  }

  /**
   * R256: whether the year's composition settings are frozen — a result sheet of the year is
   * approved or published (the condition of the trigger result_settings_locked).
   */
  async locked(schoolId: SchoolId, academicYearId: bigint): Promise<boolean> {
    const sheet = await this.txHost.tx.resultSheet.findFirst({
      where: { schoolId, academicYearId, status: { in: ['approved', 'published'] } },
      select: { id: true },
    });
    return sheet !== null;
  }

  /** The caller holds the year's lock and has validated the merged settings. */
  async update(
    schoolId: SchoolId,
    academicYearId: bigint,
    data: ResultSettingsChanges,
    updatedBy: bigint,
  ): Promise<ResultSettingsRecord> {
    const { bands, ...rest } = data;
    return toRecord(
      await this.txHost.tx.resultSettings.update({
        where: { schoolId_academicYearId: { schoolId, academicYearId } },
        data: {
          ...rest,
          ...(bands === undefined ? {} : { bands: bands.map((b) => ({ grade: b.grade, minPercent: b.minPercent })) }),
          updatedBy,
        },
        select: SELECT,
      }),
    );
  }
}
