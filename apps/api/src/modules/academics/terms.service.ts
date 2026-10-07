import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode, MAX_TERMS_PER_YEAR } from '@asms/shared';
import { fieldRefused, notFound } from '../../common/errors/api-exception';
import { readLocked } from '../../common/locking';
import { SchoolContext } from '../../common/school-context';
import { toPage, type Page } from '../../common/pagination';
import {
  AcademicTermRepository,
  type AcademicTermRecord,
} from '../../repositories/academic-term.repository';
import { AcademicYearRepository, type AcademicYearRecord } from '../../repositories/academic-year.repository';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { ClassRepository } from '../../repositories/class.repository';
import type { SchoolId } from '../../tenancy/school-id';
import {
  type Changes,
  fromDateString,
  termNameTaken,
  termOutsideYear,
  termOverlaps,
  toDateString,
  yearClosed,
} from './academics.shared';
import type { CreateTermDto, ListTermsQueryDto, SkipClassDto, TermDto, UpdateTermDto } from './terms.dto';

const SUBJECT = 'academic_term';

export function toTermDto(term: AcademicTermRecord): TermDto {
  return {
    id: term.id.toString(),
    academicYearId: term.academicYearId.toString(),
    name: term.name,
    sortOrder: term.sortOrder,
    startsOn: toDateString(term.startsOn),
    endsOn: toDateString(term.endsOn),
    weight: term.weight,
    createdByUser: term.createdBy !== null,
    skippedClasses: term.skips.map((skip) => ({
      classId: skip.classId.toString(),
      className: skip.className,
      reason: skip.reason,
      createdAt: skip.createdAt,
    })),
    createdAt: term.createdAt,
    updatedAt: term.updatedAt,
  };
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The terms of an academic year and their "not held" classes (phase-4-academic.md slice 29,
 * R254, contracts/slice-29.md §2). Every write locks the year first, so a year's terms change one
 * transaction at a time; `sort_order` is kept as the rank by date.
 */
@Injectable()
export class TermsService {
  constructor(
    private readonly context: SchoolContext,
    private readonly terms: AcademicTermRepository,
    private readonly years: AcademicYearRepository,
    private readonly classes: ClassRepository,
    private readonly audit: AuditLogRepository,
  ) {}

  async list(academicYearId: bigint, query: ListTermsQueryDto): Promise<Page<TermDto>> {
    const { schoolId } = this.context;
    if (!(await this.years.findById(schoolId, academicYearId))) throw notFound();
    const { rows, total } = await this.terms.listForYear(schoolId, academicYearId, {
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      descending: query.sort === '-sortOrder',
    });
    return toPage(rows.map(toTermDto), query, total);
  }

  /**
   * In a year not closed: inside the year, overlapping no other term, a name the year does not
   * have, at most six. The weight defaults to what the other terms leave of 100.
   */
  @Transactional()
  async create(academicYearId: bigint, dto: CreateTermDto): Promise<TermDto> {
    const { schoolId, userId } = this.context.actor();
    const year = await this.lockOpenYear(schoolId, academicYearId);
    const startsOn = fromDateString(dto.startsOn);
    const endsOn = fromDateString(dto.endsOn);
    const existing = await this.terms.allForYear(schoolId, academicYearId);
    if (existing.length >= MAX_TERMS_PER_YEAR) {
      throw fieldRefused('startsOn', ErrorCode.INVALID_VALUE, `A year has at most ${MAX_TERMS_PER_YEAR} terms`);
    }
    this.assertPlaced(year, { id: null, name: dto.name, startsOn, endsOn }, existing);
    const weight = dto.weight ?? Math.max(0, 100 - existing.reduce((sum, t) => sum + t.weight, 0));
    const created = await this.terms.create(schoolId, {
      academicYearId,
      name: dto.name,
      sortOrder: existing.length + 1,
      startsOn,
      endsOn,
      weight,
      createdBy: userId,
    });
    await this.renumber(schoolId, academicYearId);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'academic_term.created',
      subjectType: SUBJECT,
      subjectId: created.id,
      metadata: {
        academicYearId: academicYearId.toString(),
        name: dto.name,
        startsOn: dto.startsOn,
        endsOn: dto.endsOn,
        weight,
      },
    });
    return toTermDto(await this.mustFind(schoolId, created.id));
  }

  /**
   * Name, dates and weight under the year's lock. The term-in-use lock (an assessment or a
   * submitted sheet of the term, TERM_IN_USE) arrives with those tables in waves N and O.
   */
  @Transactional()
  async update(id: bigint, dto: UpdateTermDto): Promise<TermDto> {
    const { schoolId, userId } = this.context.actor();
    const found = await this.mustFind(schoolId, id);
    const year = await this.lockOpenYear(schoolId, found.academicYearId);
    // Re-read under the year's lock: every term write takes it first.
    const term = await this.mustFind(schoolId, id);

    const data: { name?: string; startsOn?: Date; endsOn?: Date; weight?: number } = {};
    const changes: Changes = {};
    if (dto.name !== undefined && dto.name !== term.name) {
      data.name = dto.name;
      changes.name = { from: term.name, to: dto.name };
    }
    for (const field of ['startsOn', 'endsOn'] as const) {
      const value = dto[field];
      const current = toDateString(term[field]);
      if (value !== undefined && value !== current) {
        data[field] = fromDateString(value);
        changes[field] = { from: current, to: value };
      }
    }
    if (dto.weight !== undefined && dto.weight !== term.weight) {
      data.weight = dto.weight;
      changes.weight = { from: term.weight, to: dto.weight };
    }
    if (Object.keys(changes).length === 0) return toTermDto(term);

    const others = (await this.terms.allForYear(schoolId, term.academicYearId)).filter((t) => t.id !== id);
    this.assertPlaced(
      year,
      {
        id,
        name: data.name ?? term.name,
        startsOn: data.startsOn ?? term.startsOn,
        endsOn: data.endsOn ?? term.endsOn,
      },
      others,
    );
    await this.terms.update(schoolId, id, data);
    if (data.startsOn !== undefined || data.endsOn !== undefined) {
      await this.renumber(schoolId, term.academicYearId);
    }
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'academic_term.updated',
      subjectType: SUBJECT,
      subjectId: id,
      metadata: { changes },
    });
    return toTermDto(await this.mustFind(schoolId, id));
  }

  /**
   * Marks the term not held for a class of its year (§1.1); a repeat changes nothing. The final
   * result and the year close skip it (waves O and P).
   */
  @Transactional()
  async skipClass(id: bigint, dto: SkipClassDto): Promise<TermDto> {
    const { schoolId, userId } = this.context.actor();
    const term = await this.lockTermYear(schoolId, id);
    const classId = await this.classOfYear(schoolId, dto.classId, term.academicYearId);
    if (await this.terms.findLiveSkip(schoolId, id, classId)) return toTermDto(term);
    await this.terms.addSkip(schoolId, {
      academicYearId: term.academicYearId,
      termId: id,
      classId,
      reason: dto.reason,
      createdBy: userId,
    });
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'academic_term.skipped',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: { classId: classId.toString(), held: false },
    });
    return toTermDto(await this.mustFind(schoolId, id));
  }

  /** Lifts a skip: the term is held for the class again; a repeat changes nothing. */
  @Transactional()
  async unskipClass(id: bigint, dto: SkipClassDto): Promise<TermDto> {
    const { schoolId, userId } = this.context.actor();
    const term = await this.lockTermYear(schoolId, id);
    const classId = await this.classOfYear(schoolId, dto.classId, term.academicYearId);
    const skip = await this.terms.findLiveSkip(schoolId, id, classId);
    if (!skip) return toTermDto(term);
    await this.terms.endSkip(schoolId, skip.id, userId);
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: 'academic_term.skipped',
      subjectType: SUBJECT,
      subjectId: id,
      reason: dto.reason,
      metadata: { classId: classId.toString(), held: true },
    });
    return toTermDto(await this.mustFind(schoolId, id));
  }

  /**
   * R254: inside the year, no overlap with another term, a name the year does not have. The
   * database holds the same lines (trigger academic_terms_inside_year, EXCLUDE
   * academic_terms_no_overlap, academic_terms_name_key) for any write that skips this.
   */
  private assertPlaced(
    year: AcademicYearRecord,
    term: { id: bigint | null; name: string; startsOn: Date; endsOn: Date },
    others: readonly AcademicTermRecord[],
  ): void {
    if (term.endsOn < term.startsOn) {
      throw fieldRefused('endsOn', ErrorCode.INVALID_VALUE, 'endsOn must not be before startsOn');
    }
    if (term.startsOn < year.startsOn || term.endsOn > year.endsOn) throw termOutsideYear(term.id);
    const clash = others.find((t) => t.startsOn <= term.endsOn && term.startsOn <= t.endsOn);
    if (clash) throw termOverlaps(clash.id);
    if (others.some((t) => sameName(t.name, term.name))) throw termNameTaken();
  }

  /** sort_order = rank by date, 1..n (the exclusion on it is deferred to commit). */
  private async renumber(schoolId: SchoolId, academicYearId: bigint): Promise<void> {
    const all = await this.terms.allForYear(schoolId, academicYearId);
    for (const [i, term] of all.entries()) {
      if (term.sortOrder !== i + 1) await this.terms.update(schoolId, term.id, { sortOrder: i + 1 });
    }
  }

  private async lockTermYear(schoolId: SchoolId, id: bigint): Promise<AcademicTermRecord> {
    const found = await this.mustFind(schoolId, id);
    await this.lockOpenYear(schoolId, found.academicYearId);
    return this.mustFind(schoolId, id);
  }

  /** A class of the term's year, else 422 on classId. */
  private async classOfYear(schoolId: SchoolId, classId: string, academicYearId: bigint): Promise<bigint> {
    const row = await this.classes.findById(schoolId, BigInt(classId));
    if (!row || row.academicYearId !== academicYearId) {
      throw fieldRefused('classId', ErrorCode.REFERENCE_NOT_FOUND, 'No such class in the academic year of the term');
    }
    return row.id;
  }

  private async mustFind(schoolId: SchoolId, id: bigint): Promise<AcademicTermRecord> {
    const term = await this.terms.findById(schoolId, id);
    if (!term) throw notFound();
    return term;
  }

  private async lockOpenYear(schoolId: SchoolId, id: bigint): Promise<AcademicYearRecord> {
    const year = await readLocked(
      () => this.years.findById(schoolId, id),
      (row) => this.years.lockIfUnchanged(schoolId, row),
    );
    if (year.status === 'closed') throw yearClosed();
    return year;
  }
}
