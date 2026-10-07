import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

/** A live "not held" row of a term: the class it is skipped for (phase-4-academic.md §1.1). */
export interface TermSkipRecord {
  id: bigint;
  classId: bigint;
  className: string;
  reason: string;
  createdAt: Date;
}

export interface AcademicTermRecord {
  id: bigint;
  academicYearId: bigint;
  name: string;
  sortOrder: number;
  /** UTC midnight of the calendar date (a `date` column). */
  startsOn: Date;
  endsOn: Date;
  weight: number;
  createdBy: bigint | null;
  createdAt: Date;
  updatedAt: Date;
  /** Live skips, by class name. */
  skips: TermSkipRecord[];
}

const SKIP_SELECT = {
  id: true,
  classId: true,
  reason: true,
  createdAt: true,
  // Same school and year by the composite foreign key (school_id, class_id, academic_year_id).
  class: { select: { name: true } },
} satisfies Prisma.TermSkipSelect;

const SELECT = {
  id: true,
  academicYearId: true,
  name: true,
  sortOrder: true,
  startsOn: true,
  endsOn: true,
  weight: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  skips: { where: { endedAt: null }, select: SKIP_SELECT, orderBy: { id: 'asc' } },
} satisfies Prisma.AcademicTermSelect;

type TermRow = Prisma.AcademicTermGetPayload<{ select: typeof SELECT }>;

const toRecord = ({ skips, ...row }: TermRow): AcademicTermRecord => ({
  ...row,
  skips: skips
    .map(({ class: owner, ...skip }) => ({ ...skip, className: owner.name }))
    .sort((a, b) => a.className.localeCompare(b.className)),
});

/**
 * Terms of an academic year and their "not held" rows (tenant tables academic_terms, term_skips;
 * phase-4-academic.md §3.2, slice 29). Every write runs under the year's row lock, taken by the
 * caller, so the year's terms change one transaction at a time.
 */
@Injectable()
export class AcademicTermRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** A year's terms in order (sort_order is the rank by date). */
  async listForYear(
    schoolId: SchoolId,
    academicYearId: bigint,
    page: { skip: number; take: number; descending: boolean },
  ): Promise<{ rows: AcademicTermRecord[]; total: number }> {
    const where = { schoolId, academicYearId };
    const direction = page.descending ? 'desc' : 'asc';
    const rows = await this.txHost.tx.academicTerm.findMany({
      where,
      select: SELECT,
      orderBy: [{ sortOrder: direction }, { id: direction }],
      skip: page.skip,
      take: page.take,
    });
    const total = await this.txHost.tx.academicTerm.count({ where });
    return { rows: rows.map(toRecord), total };
  }

  /** Every term of the year, in date order: the service's view when it checks or renumbers. */
  async allForYear(schoolId: SchoolId, academicYearId: bigint): Promise<AcademicTermRecord[]> {
    const rows = await this.txHost.tx.academicTerm.findMany({
      where: { schoolId, academicYearId },
      select: SELECT,
      orderBy: [{ startsOn: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toRecord);
  }

  async findById(schoolId: SchoolId, id: bigint): Promise<AcademicTermRecord | null> {
    const row = await this.txHost.tx.academicTerm.findFirst({ where: { schoolId, id }, select: SELECT });
    return row && toRecord(row);
  }

  /**
   * The caller holds the year's lock and has checked dates and overlap; an overlap fails on
   * academic_terms_no_overlap, a date outside the year on trigger academic_terms_inside_year, a
   * taken name on academic_terms_name_key.
   */
  async create(
    schoolId: SchoolId,
    data: {
      academicYearId: bigint;
      name: string;
      sortOrder: number;
      startsOn: Date;
      endsOn: Date;
      weight: number;
      createdBy: bigint;
    },
  ): Promise<AcademicTermRecord> {
    return toRecord(await this.txHost.tx.academicTerm.create({ data: { schoolId, ...data }, select: SELECT }));
  }

  /** The caller holds the year's lock. */
  async update(
    schoolId: SchoolId,
    id: bigint,
    data: { name?: string; startsOn?: Date; endsOn?: Date; weight?: number; sortOrder?: number },
  ): Promise<AcademicTermRecord> {
    return toRecord(
      await this.txHost.tx.academicTerm.update({
        where: { schoolId_id: { schoolId, id } },
        data,
        select: SELECT,
      }),
    );
  }

  /**
   * The live skip of a term for a class, if any (term_skips_live_key: at most one).
   */
  findLiveSkip(schoolId: SchoolId, termId: bigint, classId: bigint): Promise<{ id: bigint } | null> {
    return this.txHost.tx.termSkip.findFirst({
      where: { schoolId, termId, classId, endedAt: null },
      select: { id: true },
    });
  }

  /** The caller holds the year's lock and found no live skip. */
  async addSkip(
    schoolId: SchoolId,
    data: { academicYearId: bigint; termId: bigint; classId: bigint; reason: string; createdBy: bigint },
  ): Promise<void> {
    await this.txHost.tx.termSkip.create({ data: { schoolId, ...data }, select: { id: true } });
  }

  /** Lifts a live skip; ended_at and ended_by are then frozen (term_skips_ended_frozen). Rows changed. */
  async endSkip(schoolId: SchoolId, id: bigint, endedBy: bigint): Promise<number> {
    const { count } = await this.txHost.tx.termSkip.updateMany({
      where: { schoolId, id, endedAt: null },
      data: { endedAt: new Date(), endedBy },
    });
    return count;
  }
}
