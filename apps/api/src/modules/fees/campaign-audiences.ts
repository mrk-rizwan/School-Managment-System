// A campaign's audience (phase-3-financial.md §5 slice 19, R184): the slice-14 picker's student
// kinds (everyone, students, class, section, student) under the same shape rules (§4.1 of
// contracts/slice-14.md: everyone alone, a target exactly for the targeted kinds, no repeats), and
// targets checked against the campaign's year. Resolution to enrolments is the repository's.
import { audiencesProblem, ErrorCode, normaliseAudiences } from '@asms/shared';
import { fieldRefused } from '../../common/errors/api-exception';
import type {
  CampaignAudienceKind,
  CampaignAudienceRow,
  CampaignRecord,
  ChargeCampaignRepository,
} from '../../repositories/charge-campaign.repository';
import type { SchoolId } from '../../tenancy/school-id';
import type { CampaignAudienceDto } from './campaigns.dto';

const KINDS: readonly CampaignAudienceKind[] = ['everyone', 'students', 'class', 'section', 'student'];

/** A stored or validated kind; anything else is a bug (the DTO and the CHECK allow these five). */
function campaignKind(kind: string): CampaignAudienceKind {
  const found = KINDS.find((k) => k === kind);
  if (found === undefined) throw new Error(`not a campaign audience kind: ${kind}`);
  return found;
}

const MESSAGES: Readonly<Record<string, string>> = {
  empty: 'audiences must have at least one item',
  too_many: 'audiences may have at most 20 items',
  everyone_not_alone: 'everyone combines with nothing',
  target_forbidden: 'targetId is not taken by this kind',
  target_required: 'targetId is required for this kind',
  duplicate: 'the same target appears twice',
};

/** The shape rules (422 INVALID_VALUE), then the normalised rows. */
export function parseCampaignAudiences(audiences: readonly CampaignAudienceDto[]): CampaignAudienceRow[] {
  const problem = audiencesProblem(audiences);
  if (problem !== null) {
    const path =
      problem.index === null
        ? 'audiences'
        : problem.reason.startsWith('target')
          ? `audiences[${problem.index}].targetId`
          : `audiences[${problem.index}]`;
    throw fieldRefused(path, ErrorCode.INVALID_VALUE, MESSAGES[problem.reason] ?? 'audiences are invalid');
  }
  return normaliseAudiences(audiences).map((a) => ({
    kind: campaignKind(a.kind),
    targetId: a.targetId === undefined ? null : BigInt(a.targetId),
  }));
}

/** Every target is a class or section of the campaign's year, or a student of the school (422). */
export async function assertTargetsExist(
  repository: ChargeCampaignRepository,
  schoolId: SchoolId,
  academicYearId: bigint,
  rows: readonly CampaignAudienceRow[],
): Promise<void> {
  const of = (kind: CampaignAudienceKind) => rows.flatMap((r) => (r.kind === kind && r.targetId !== null ? [r.targetId] : []));
  const found = new Set<bigint>([
    ...(await repository.classesOfYear(schoolId, academicYearId, of('class'))),
    ...(await repository.sectionsOfYear(schoolId, academicYearId, of('section'))),
  ]);
  const students = new Set(await repository.studentsOfSchool(schoolId, of('student')));
  rows.forEach((row, index) => {
    if (row.targetId === null) return;
    const ok = row.kind === 'student' ? students.has(row.targetId) : found.has(row.targetId);
    if (!ok) {
      throw fieldRefused(`audiences[${index}].targetId`, ErrorCode.REFERENCE_NOT_FOUND, 'The target does not exist in that academic year.');
    }
  });
}

/** The stored audience as rows. */
export function campaignAudienceRows(campaign: Pick<CampaignRecord, 'audiences'>): CampaignAudienceRow[] {
  return campaign.audiences.map((a) => ({
    kind: campaignKind(a.kind),
    targetId: a.classId ?? a.sectionId ?? a.studentId,
  }));
}

/** The rows as the API returns them. */
export function audienceDtos(rows: readonly CampaignAudienceRow[]): CampaignAudienceDto[] {
  return rows.map((r) => ({ kind: r.kind, ...(r.targetId === null ? {} : { targetId: r.targetId.toString() }) }));
}
