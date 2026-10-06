import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { AudienceKind, CampaignStatus, FeeFrequency } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// Charge campaigns and their audiences (tenant tables charge_campaigns, charge_campaign_audiences;
// phase-3-financial.md §4, R184). Never deleted; `draft -> generating | cancelled`, `generating ->
// generated | draft` (a failed or stale run, R252), `generated -> cancelled` (voids nothing). The
// content is editable only while a draft (charge_campaigns_content_frozen), and so is the
// audience, which is replaced on PATCH (the announcement precedent).

/** A campaign audience: the student kinds of the slice-14 resolver only. */
export type CampaignAudienceKind = Extract<AudienceKind, 'everyone' | 'students' | 'class' | 'section' | 'student'>;

export interface CampaignAudienceRow {
  kind: CampaignAudienceKind;
  targetId: bigint | null;
}

export interface CampaignRecord {
  id: bigint;
  name: string;
  academicYearId: bigint;
  feeHeadId: bigint;
  amount: number;
  dueOn: Date;
  description: string | null;
  applyConcessions: boolean;
  status: CampaignStatus;
  createdBy: bigint;
  createdAt: Date;
  generatedAt: Date | null;
  generatedCount: number | null;
  cancelledAt: Date | null;
  cancelledBy: bigint | null;
  cancelReason: string | null;
  updatedAt: Date;
  feeHead: { name: string; frequency: FeeFrequency; concessionEligible: boolean; status: string };
  audiences: { kind: AudienceKind; classId: bigint | null; sectionId: bigint | null; studentId: bigint | null }[];
}

const SELECT = {
  id: true,
  name: true,
  academicYearId: true,
  feeHeadId: true,
  amount: true,
  dueOn: true,
  description: true,
  applyConcessions: true,
  status: true,
  createdBy: true,
  createdAt: true,
  generatedAt: true,
  generatedCount: true,
  cancelledAt: true,
  cancelledBy: true,
  cancelReason: true,
  updatedAt: true,
} satisfies Prisma.ChargeCampaignSelect;

type CampaignRow = Omit<CampaignRecord, 'feeHead' | 'audiences'>;

export interface CampaignContent {
  name: string;
  academicYearId: bigint;
  feeHeadId: bigint;
  amount: number;
  dueOn: Date;
  description: string | null;
  applyConcessions: boolean;
}

const audienceData = (schoolId: SchoolId, campaignId: bigint, rows: readonly CampaignAudienceRow[]) =>
  rows.map((row) => ({
    schoolId,
    campaignId,
    kind: row.kind,
    classId: row.kind === 'class' ? row.targetId : null,
    sectionId: row.kind === 'section' ? row.targetId : null,
    studentId: row.kind === 'student' ? row.targetId : null,
  }));

@Injectable()
export class ChargeCampaignRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async list(
    schoolId: SchoolId,
    query: { academicYearId?: bigint; status?: CampaignStatus; skip: number; take: number },
  ): Promise<{ rows: CampaignRecord[]; total: number }> {
    const where: Prisma.ChargeCampaignWhereInput = {
      schoolId,
      ...(query.academicYearId === undefined ? {} : { academicYearId: query.academicYearId }),
      ...(query.status === undefined ? {} : { status: query.status }),
    };
    const rows = await this.txHost.tx.chargeCampaign.findMany({
      where,
      select: SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.chargeCampaign.count({ where });
    return { rows: await this.named(schoolId, rows), total };
  }

  async findById(schoolId: SchoolId, id: bigint): Promise<CampaignRecord | null> {
    const row = await this.txHost.tx.chargeCampaign.findFirst({ where: { schoolId, id }, select: SELECT });
    return row ? ((await this.named(schoolId, [row]))[0] ?? null) : null;
  }

  /**
   * The head and the audience of each row, in sequential statements (Prisma loads sibling
   * relations of one select concurrently; statements must not overlap inside a transaction).
   */
  private async named(schoolId: SchoolId, rows: readonly CampaignRow[]): Promise<CampaignRecord[]> {
    if (rows.length === 0) return [];
    const heads = await this.txHost.tx.feeHead.findMany({
      where: { schoolId, id: { in: [...new Set(rows.map((r) => r.feeHeadId))] } },
      select: { id: true, name: true, frequency: true, concessionEligible: true, status: true },
    });
    const audiences = await this.txHost.tx.chargeCampaignAudience.findMany({
      where: { schoolId, campaignId: { in: rows.map((r) => r.id) } },
      select: { campaignId: true, kind: true, classId: true, sectionId: true, studentId: true },
      orderBy: { id: 'asc' },
    });
    const head = new Map(heads.map((h) => [h.id, h]));
    return rows.map((row) => {
      const h = head.get(row.feeHeadId);
      if (!h) throw new Error('campaign head missing');
      return {
        ...row,
        feeHead: { name: h.name, frequency: h.frequency, concessionEligible: h.concessionEligible, status: h.status },
        audiences: audiences
          .filter((a) => a.campaignId === row.id)
          .map((a) => ({ kind: a.kind, classId: a.classId, sectionId: a.sectionId, studentId: a.studentId })),
      };
    });
  }

  /** Locks the row if unchanged since `row` was read; false: read again. */
  async lockIfUnchanged(schoolId: SchoolId, row: Pick<CampaignRecord, 'id' | 'updatedAt'>): Promise<boolean> {
    const { count } = await this.txHost.tx.chargeCampaign.updateMany({
      where: { schoolId, id: row.id, updatedAt: row.updatedAt },
      data: { updatedAt: row.updatedAt },
    });
    return count === 1;
  }

  async create(
    schoolId: SchoolId,
    content: CampaignContent,
    audiences: readonly CampaignAudienceRow[],
    createdBy: bigint,
  ): Promise<bigint> {
    const { id } = await this.txHost.tx.chargeCampaign.create({
      data: { schoolId, ...content, createdBy },
      select: { id: true },
    });
    await this.txHost.tx.chargeCampaignAudience.createMany({ data: audienceData(schoolId, id, audiences) });
    return id;
  }

  /** A draft's content and, when given, its whole audience (replaced). The caller holds the lock. */
  async updateDraft(
    schoolId: SchoolId,
    id: bigint,
    content: Partial<CampaignContent>,
    audiences: readonly CampaignAudienceRow[] | undefined,
  ): Promise<void> {
    await this.txHost.tx.chargeCampaign.updateMany({ where: { schoolId, id, status: 'draft' }, data: content });
    if (audiences !== undefined) {
      await this.txHost.tx.chargeCampaignAudience.deleteMany({ where: { schoolId, campaignId: id } });
      await this.txHost.tx.chargeCampaignAudience.createMany({ data: audienceData(schoolId, id, audiences) });
    }
  }

  /** `from` → `to` with the stamps the move needs; 0 when the row was not in `from`. */
  async move(
    schoolId: SchoolId,
    id: bigint,
    from: CampaignStatus,
    to: CampaignStatus,
    stamps: Prisma.ChargeCampaignUncheckedUpdateManyInput = {},
  ): Promise<number> {
    const { count } = await this.txHost.tx.chargeCampaign.updateMany({
      where: { schoolId, id, status: from },
      data: { status: to, ...stamps },
    });
    return count;
  }

  /**
   * The live enrolments of the year an audience reaches, one per student (§5 slice 19: deduped
   * per enrolment): everyone and students reach the year's every live enrolment.
   */
  async targetEnrolments(
    schoolId: SchoolId,
    academicYearId: bigint,
    audiences: readonly CampaignAudienceRow[],
  ): Promise<{ id: bigint; studentId: bigint }[]> {
    const all = audiences.some((a) => a.kind === 'everyone' || a.kind === 'students');
    const ids = (kind: CampaignAudienceKind) =>
      audiences.flatMap((a) => (a.kind === kind && a.targetId !== null ? [a.targetId] : []));
    const or: Prisma.EnrolmentWhereInput[] = [
      { classId: { in: ids('class') } },
      { sectionId: { in: ids('section') } },
      { studentId: { in: ids('student') } },
    ];
    const rows = await this.txHost.tx.enrolment.findMany({
      where: { schoolId, academicYearId, endedOn: null, ...(all ? {} : { OR: or }) },
      select: { id: true, studentId: true },
      orderBy: [{ studentId: 'asc' }, { startedOn: 'desc' }, { id: 'desc' }],
    });
    const seen = new Set<bigint>();
    return rows.filter((row) => (seen.has(row.studentId) ? false : (seen.add(row.studentId), true)));
  }

  /** The class, section and student targets of an audience, for the request checks. */
  async classesOfYear(schoolId: SchoolId, academicYearId: bigint, ids: readonly bigint[]): Promise<bigint[]> {
    if (ids.length === 0) return [];
    const rows = await this.txHost.tx.class.findMany({
      where: { schoolId, academicYearId, id: { in: [...ids] } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async sectionsOfYear(schoolId: SchoolId, academicYearId: bigint, ids: readonly bigint[]): Promise<bigint[]> {
    if (ids.length === 0) return [];
    const rows = await this.txHost.tx.section.findMany({
      where: { schoolId, id: { in: [...ids] }, class: { schoolId, academicYearId } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async studentsOfSchool(schoolId: SchoolId, ids: readonly bigint[]): Promise<bigint[]> {
    if (ids.length === 0) return [];
    const rows = await this.txHost.tx.student.findMany({
      where: { schoolId, id: { in: [...ids] } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}
