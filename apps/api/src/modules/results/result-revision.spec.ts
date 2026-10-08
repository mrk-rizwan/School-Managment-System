// Slice 32 fix round (contracts/slice-32.md §4.1 step 3): `revised` compares a correction's
// figures subject by subject, by class-subject — a print-order change is not a figure change.
import { changed } from './result-revision.service';

type Figures = Parameters<typeof changed>[0];
type Subject = Figures['subjects'][number];

const subject = (classSubjectId: bigint, sortOrder: number, percentBp: number): Subject => ({
  classSubjectId,
  subjectName: `Subject ${classSubjectId}`,
  sortOrder,
  testBp: null,
  examBp: percentBp,
  examObtained: percentBp / 100,
  examMax: 100,
  examAbsent: false,
  examExcused: false,
  percentBp,
  obtained: percentBp / 100,
  max: 100,
  grade: 'A',
  status: 'assessed',
  ownChildOf: null,
});

const figures = (subjects: Subject[]): Figures => ({
  totalObtained: 150,
  totalMax: 200,
  percentBp: 7500,
  grade: 'B',
  passed: true,
  failedSubjects: 0,
  position: 1,
  positionOf: 2,
  ownChildFlags: [],
  subjects,
});

describe('changed (R280 revised)', () => {
  it('ignores the print order: the same figures in another order are not a revision', () => {
    const prev = figures([subject(1n, 1, 8000), subject(2n, 2, 7000)]);
    const next = figures([subject(2n, 1, 7000), subject(1n, 2, 8000)]);
    expect(changed(prev, next)).toBe(false);
  });

  it('a subject figure, a missing subject or a total is a revision', () => {
    const prev = figures([subject(1n, 1, 8000), subject(2n, 2, 7000)]);
    expect(changed(prev, figures([subject(2n, 2, 7000), subject(1n, 1, 8100)]))).toBe(true);
    expect(changed(prev, figures([subject(1n, 1, 8000), subject(3n, 2, 7000)]))).toBe(true);
    expect(changed(prev, { ...figures(prev.subjects), position: 2 })).toBe(true);
  });
});
