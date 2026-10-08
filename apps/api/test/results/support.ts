// Shared by the slice-31 suites (contracts/slice-31.md): the slice-30 mark room (one class, 6-A and
// 6-B, Maths and English on its list, teachers assigned 30 days back) with its Mid-term (the
// seeded first half of the year, ending today), the term's exams set up, and helpers that enter
// marks, create and drive a sheet through the API.
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { ResultSheetDetailDto } from '../../src/modules/results/results.dto';
import { EnvModule } from '../../src/config/env';
import { AccessModule } from '../../src/modules/access/access.module';
import { AssessmentRepository } from '../../src/repositories/assessment.repository';
import { MarkReadsRepository } from '../../src/repositories/mark-reads.repository';
import { ResultSheetRepository } from '../../src/repositories/result-sheet.repository';
import { ResultRepository } from '../../src/repositories/result.repository';
import { TenancyModule } from '../../src/tenancy/tenancy.module';
import { api, entryKey, markRoom, postKeyed, type MarkRoom } from '../assessments/support';
import { ORIGIN, type Caller, type StaffHarness } from '../staff/support';

export { api, entryKey, postKeyed };

export interface ResultRoom extends MarkRoom {
  midTermId: bigint;
  annualTermId: bigint;
  /** The Mid-term's exams by section and subject. */
  exams: { mathsA: bigint; englishA: bigint; mathsB: bigint; englishB: bigint };
}

/** The mark room plus its terms and the Mid-term's exams (set up by the principal). */
export async function resultRoom(h: StaffHarness): Promise<ResultRoom> {
  const room = await markRoom(h);
  const terms = await h.db.academicTerm.findMany({
    where: { schoolId: room.school.id, academicYearId: room.year.id },
    orderBy: { sortOrder: 'asc' },
  });
  const [mid, annual] = terms;
  if (!mid || !annual) throw new Error('resultRoom: the seeded terms are missing');
  const res = await h.send('post', api(`/terms/${mid.id}/set-up-exams`), {}, room.principal.cookie);
  if (res.status !== 200) throw new Error(`resultRoom: set-up refused ${res.status} ${res.text}`);
  const exams = await h.db.assessment.findMany({
    where: { schoolId: room.school.id, termId: mid.id, kind: 'exam' },
  });
  const exam = (sectionId: bigint, classSubjectId: bigint): bigint => {
    const found = exams.find(
      (e) => e.sectionId === sectionId && e.classSubjectId === classSubjectId,
    );
    if (!found) throw new Error('resultRoom: an exam is missing');
    return found.id;
  };
  return {
    ...room,
    midTermId: mid.id,
    annualTermId: annual.id,
    exams: {
      mathsA: exam(room.sixA.id, room.maths.classSubjectId),
      englishA: exam(room.sixA.id, room.english.classSubjectId),
      mathsB: exam(room.sixB.id, room.maths.classSubjectId),
      englishB: exam(room.sixB.id, room.english.classSubjectId),
    },
  };
}

/** Marks on an assessment through submit-marks (`'absent'` for an absence), all based on none. */
export async function enterMarks(
  h: StaffHarness,
  assessmentId: bigint | string,
  who: Caller,
  marks: readonly (readonly [bigint, number | 'absent'])[],
): Promise<void> {
  const res = await request(h.app.getHttpServer())
    .post(api(`/assessments/${assessmentId}/submit-marks`))
    .set('Cookie', who.cookie)
    .set('Origin', ORIGIN)
    .send({
      entries: marks.map(([enrolmentId, value]) => ({
        enrolmentId: String(enrolmentId),
        ...(value === 'absent' ? { absent: true } : { obtained: value }),
        clientEntryKey: entryKey(),
        basedOnMarkId: null,
      })),
    });
  if (res.status !== 200) throw new Error(`enterMarks: ${res.status} ${res.text}`);
}

/** A class test on a section's subject by its teacher; returns the id. */
export async function createTest(
  h: StaffHarness,
  who: Caller,
  body: {
    classSubjectId: bigint;
    sectionId: bigint;
    maxMarks: number;
    heldOn: string;
    name?: string;
  },
): Promise<string> {
  const res = await postKeyed(
    h,
    api('/assessments'),
    {
      classSubjectId: String(body.classSubjectId),
      sectionId: String(body.sectionId),
      testType: 'weekly',
      name: body.name ?? 'Weekly test',
      maxMarks: body.maxMarks,
      heldOn: body.heldOn,
    },
    who.cookie,
  );
  if (res.status !== 201) throw new Error(`createTest: ${res.status} ${res.text}`);
  return (res.body as { id: string }).id;
}

/** POST /sections/:id/result-sheets. */
export async function openSheet(
  h: StaffHarness,
  who: Caller,
  sectionId: bigint,
  termId: bigint | null,
): Promise<{ status: number; body: ResultSheetDetailDto }> {
  const res = await h.send(
    'post',
    api(`/sections/${sectionId}/result-sheets`),
    { termId: termId === null ? null : String(termId) },
    who.cookie,
  );
  return { status: res.status, body: res.body as ResultSheetDetailDto };
}

export const sheetVerb = (
  h: StaffHarness,
  id: string,
  verb: 'submit' | 'approve' | 'publish',
  who: Caller,
) => h.send('post', api(`/result-sheets/${id}/${verb}`), {}, who.cookie);

export const returnSheet = (
  h: StaffHarness,
  id: string,
  who: Caller,
  reason = 'Recheck the English marks',
) => h.send('post', api(`/result-sheets/${id}/return`), { reason }, who.cookie);

/**
 * The full Mid-term of 6-A with both subjects marked: Maths test (20) 15 and 10, the exams 80/100
 * and 55/100 for Maths, 70 and absent for English. Returns the test id.
 */
export async function markMidTerm(h: StaffHarness, r: ResultRoom, heldOn: string): Promise<string> {
  const test = await createTest(h, r.mathsTeacher, {
    classSubjectId: r.maths.classSubjectId,
    sectionId: r.sixA.id,
    maxMarks: 20,
    heldOn,
  });
  await enterMarks(h, test, r.mathsTeacher, [
    [r.enrolment1, 15],
    [r.enrolment2, 10],
  ]);
  await enterMarks(h, r.exams.mathsA, r.mathsTeacher, [
    [r.enrolment1, 80],
    [r.enrolment2, 55],
  ]);
  await enterMarks(h, r.exams.englishA, r.englishTeacher, [
    [r.enrolment1, 70],
    [r.enrolment2, 'absent'],
  ]);
  return test;
}

/**
 * The sheet, result and mark-reads repositories over the real database, for the isolation probes
 * (control 4): the tenant comes only from the SchoolId each call is given.
 */
export async function resultRepositories(): Promise<{
  sheets: ResultSheetRepository;
  results: ResultRepository;
  reads: MarkReadsRepository;
  assessments: AssessmentRepository;
  close: () => Promise<void>;
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [EnvModule, TenancyModule, AccessModule],
    providers: [ResultSheetRepository, ResultRepository, MarkReadsRepository, AssessmentRepository],
  }).compile();
  await moduleRef.init();
  return {
    sheets: moduleRef.get(ResultSheetRepository),
    results: moduleRef.get(ResultRepository),
    reads: moduleRef.get(MarkReadsRepository),
    assessments: moduleRef.get(AssessmentRepository),
    close: () => moduleRef.close(),
  };
}
