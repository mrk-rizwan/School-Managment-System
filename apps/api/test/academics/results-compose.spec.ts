// R258-R260 (phase-4-academic.md §0.26, §1.1, §3.3): the result composition functions, table-
// tested with worked examples. Each figure is in basis points (7850 = 78.50 %), rounded half-up
// once from the exact fraction; the overall figures come from the printed per-subject marks.
import {
  bandsProblem,
  composeFinal,
  composeResult,
  composeSubject,
  defaultTermWeights,
  DEFAULT_GRADE_BANDS,
  formatPercentBp,
  gradeFor,
  positions,
  type ExamMarkInput,
  type KeyedSubject,
  type TestMarkInput,
} from '@asms/shared';

const W = { test: 20, exam: 80 };
const test = (obtained: number | null, max: number, extra: Partial<TestMarkInput> = {}): TestMarkInput => ({
  obtained,
  max,
  absent: obtained === null,
  excused: false,
  applicable: true,
  ...extra,
});
const exam = (obtained: number | null, max: number, excused = false): ExamMarkInput => ({
  obtained,
  max,
  absent: obtained === null,
  excused,
});

describe('R258 composeSubject', () => {
  it.each([
    // [name, input, testBp, examBp, percentBp, obtained, status]
    [
      'tests averaged as percentages, an absence counts 0: (80 % + 60 % + 0) / 3 × 20 + 70 % × 80',
      { tests: [test(8, 10), test(30, 50), test(null, 20)], exam: exam(70, 100), weights: W, max: 100 },
      4667, 7000, 6533, 65, 'assessed',
    ],
    [
      'an excused absence is left out of the average',
      { tests: [test(8, 10), test(null, 20, { excused: true })], exam: exam(70, 100), weights: W, max: 100 },
      8000, 7000, 7200, 72, 'assessed',
    ],
    [
      'an inapplicable test (before the student joined) is left out',
      { tests: [test(2, 10, { applicable: false }), test(9, 10)], exam: exam(70, 100), weights: W, max: 100 },
      9000, 7000, 7400, 74, 'assessed',
    ],
    [
      'no test held for the student: the exam carries 100 %, printed on its own max',
      { tests: [], exam: exam(45, 60), weights: W, max: 60 },
      null, 7500, 7500, 45, 'assessed',
    ],
    [
      'an excused exam: the tests carry 100 %; 82.5 prints as 83 (half-up)',
      { tests: [test(9, 10), test(15, 20)], exam: exam(null, 100, true), weights: W, max: 100 },
      8250, null, 8250, 83, 'assessed',
    ],
    [
      'an exam missed without excuse counts 0',
      { tests: [test(10, 10)], exam: exam(null, 100), weights: W, max: 100 },
      10000, 0, 2000, 20, 'assessed',
    ],
    [
      'no exam set up: the tests carry 100 %',
      { tests: [test(7, 10)], exam: null, weights: W, max: 100 },
      7000, null, 7000, 70, 'assessed',
    ],
    [
      'both components missing: not assessed',
      { tests: [test(5, 10, { applicable: false })], exam: exam(null, 100, true), weights: W, max: 100 },
      null, null, null, null, 'not_assessed',
    ],
    [
      'half-up on an exact half basis point: (1/16 + 0/1) / 2 = 3.125 % → 313',
      { tests: [test(1, 16), test(0, 1)], exam: null, weights: W, max: 100 },
      313, null, 313, 3, 'assessed',
    ],
    [
      'weights 0 / 100: only the exam counts when both are present',
      { tests: [test(10, 10)], exam: exam(50, 100), weights: { test: 0, exam: 100 }, max: 100 },
      10000, 5000, 5000, 50, 'assessed',
    ],
  ])('%s', (_name, input, testBp, examBp, percentBp, obtained, status) => {
    expect(composeSubject(input)).toEqual({ testBp, examBp, percentBp, obtained, max: input.max, status });
  });

  it('refuses impossible inputs', () => {
    expect(() => composeSubject({ tests: [test(11, 10)], exam: null, weights: W, max: 100 })).toThrow();
    expect(() => composeSubject({ tests: [], exam: exam(5, 10), weights: { test: 30, exam: 80 }, max: 10 })).toThrow();
    expect(() =>
      composeSubject({ tests: [{ obtained: 5, max: 10, absent: true, excused: false, applicable: true }], exam: null, weights: W, max: 10 }),
    ).toThrow();
    expect(() => composeSubject({ tests: [], exam: null, weights: W, max: 0 })).toThrow();
  });
});

const subject = (key: string, percentBp: number | null, obtained: number | null, max: number): KeyedSubject => ({
  key,
  percentBp,
  obtained,
  max,
  status: percentBp === null ? 'not_assessed' : 'assessed',
});

describe('R259 composeResult', () => {
  const card = [
    subject('maths', 6533, 65, 100),
    subject('english', 7200, 72, 100),
    subject('urdu', null, null, 100),
    subject('science', 7500, 45, 60),
  ];

  it('totals and the overall percentage come from the printed marks; a not-assessed subject is left out', () => {
    const r = composeResult({ subjects: card, bands: DEFAULT_GRADE_BANDS, passRule: 'all_subjects', passPercent: 40 });
    expect(r.totalObtained).toBe(182);
    expect(r.totalMax).toBe(260);
    expect(r.percentBp).toBe(7000);
    expect(r.grade).toBe('B');
    expect(r.passed).toBe(true);
    expect(r.failedSubjects).toEqual([]);
    expect(r.subjects).toEqual([
      { key: 'maths', grade: 'C', passed: true },
      { key: 'english', grade: 'B', passed: true },
      { key: 'urdu', grade: null, passed: null },
      { key: 'science', grade: 'B', passed: true },
    ]);
  });

  it('a parent adding up the card gets its percentage: 65.49 % and 65.50 % print as 65 and 66 → 131 / 200 = 65.50 %', () => {
    const r = composeResult({
      subjects: [subject('a', 6549, 65, 100), subject('b', 6550, 66, 100)],
      bands: DEFAULT_GRADE_BANDS,
      passRule: 'all_subjects',
      passPercent: 40,
    });
    expect(r.percentBp).toBe(6550);
    expect(r.totalObtained).toBe(131);
  });

  it('the subject pass check reads printed obtained ÷ max: 39 / 100 fails at 40 %, 40 / 100 passes', () => {
    const fail = composeResult({
      subjects: [subject('a', 3949, 39, 100), subject('b', 9000, 90, 100)],
      bands: DEFAULT_GRADE_BANDS,
      passRule: 'all_subjects',
      passPercent: 40,
    });
    expect(fail.passed).toBe(false);
    expect(fail.failedSubjects).toEqual(['a']);
    // The overall rule passes the same card on its 64.5 % → 6450.
    const overall = composeResult({
      subjects: [subject('a', 3949, 39, 100), subject('b', 9000, 90, 100)],
      bands: DEFAULT_GRADE_BANDS,
      passRule: 'overall',
      passPercent: 40,
    });
    expect(overall.passed).toBe(true);
    expect(overall.percentBp).toBe(6450);
    expect(overall.failedSubjects).toEqual(['a']);
    const pass = composeResult({ subjects: [subject('a', 3950, 40, 100)], bands: DEFAULT_GRADE_BANDS, passRule: 'all_subjects', passPercent: 40 });
    expect(pass.passed).toBe(true);
  });

  it('nothing assessed: no percentage, no grade, passed is null', () => {
    const r = composeResult({ subjects: [subject('a', null, null, 100)], bands: DEFAULT_GRADE_BANDS, passRule: 'overall', passPercent: 40 });
    expect(r).toMatchObject({ totalObtained: 0, totalMax: 0, percentBp: null, grade: null, passed: null, failedSubjects: [] });
  });
});

describe('R260 positions', () => {
  it('standard competition ranking by percentage (1, 1, 3); nothing assessed holds none', () => {
    expect(positions([{ percentBp: 9000 }, { percentBp: 8000 }, { percentBp: 9000 }, { percentBp: null }, { percentBp: 7000 }])).toEqual([
      { position: 1, positionOf: 4 },
      { position: 3, positionOf: 4 },
      { position: 1, positionOf: 4 },
      { position: null, positionOf: null },
      { position: 4, positionOf: 4 },
    ]);
    expect(positions([])).toEqual([]);
  });

  it('ranks by percentage, not total: an excused subject neither lifts nor lowers a position', () => {
    // A: 270 / 300 = 90 %; B excused one subject: 180 / 200 = 90 %. They tie.
    const a = composeResult({ subjects: [subject('x', 9000, 90, 100), subject('y', 9000, 90, 100), subject('z', 9000, 90, 100)], bands: DEFAULT_GRADE_BANDS, passRule: 'all_subjects', passPercent: 40 });
    const b = composeResult({ subjects: [subject('x', 9000, 90, 100), subject('y', 9000, 90, 100), subject('z', null, null, 100)], bands: DEFAULT_GRADE_BANDS, passRule: 'all_subjects', passPercent: 40 });
    expect(positions([a, b]).map((p) => p.position)).toEqual([1, 1]);
  });
});

describe('composeFinal (A6, R275)', () => {
  const base = { bands: DEFAULT_GRADE_BANDS, passRule: 'all_subjects' as const, passPercent: 40 };

  it('per subject over the terms assessed, weights renormalised; a term not held is skipped', () => {
    const r = composeFinal({
      ...base,
      terms: [
        { weight: 50, held: true, subjects: [{ key: 'maths', percentBp: 6000, max: 100 }, { key: 'urdu', percentBp: null, max: 100 }] },
        { weight: 50, held: true, subjects: [{ key: 'maths', percentBp: 8000, max: 100 }, { key: 'urdu', percentBp: 9000, max: 75 }] },
        { weight: 0, held: false, subjects: [{ key: 'maths', percentBp: 1000, max: 100 }] },
      ],
    });
    expect(r.subjectFigures).toEqual([
      { key: 'maths', percentBp: 7000, obtained: 70, max: 100, status: 'assessed' },
      { key: 'urdu', percentBp: 9000, obtained: 68, max: 75, status: 'assessed' },
    ]);
    expect(r.totalObtained).toBe(138);
    expect(r.totalMax).toBe(175);
    expect(r.percentBp).toBe(7886); // 138 / 175 = 78.857 %
    expect(r.grade).toBe('B');
    expect(r.passed).toBe(true);
  });

  it('weighted 33 / 33 / 34 with half-up once; a subject assessed in no held term is not assessed', () => {
    const r = composeFinal({
      ...base,
      terms: [
        { weight: 33, held: true, subjects: [{ key: 's', percentBp: 7000, max: 100 }, { key: 'none', percentBp: null, max: 100 }] },
        { weight: 33, held: true, subjects: [{ key: 's', percentBp: 8000, max: 100 }] },
        { weight: 34, held: true, subjects: [{ key: 's', percentBp: 9001, max: 100 }] },
      ],
    });
    expect(r.subjectFigures[0]).toEqual({ key: 's', percentBp: 8010, obtained: 80, max: 100, status: 'assessed' });
    expect(r.subjectFigures[1]).toEqual({ key: 'none', percentBp: null, obtained: null, max: 100, status: 'not_assessed' });
  });

  it('a 40 / 60 year with the first term missing for the subject carries the second at 100 %', () => {
    const r = composeFinal({
      ...base,
      terms: [
        { weight: 40, held: true, subjects: [] },
        { weight: 60, held: true, subjects: [{ key: 's', percentBp: 5000, max: 100 }] },
      ],
    });
    expect(r.subjectFigures).toEqual([{ key: 's', percentBp: 5000, obtained: 50, max: 100, status: 'assessed' }]);
  });

  it('the printed max is the last held term in which the student was assessed: T1 70 % of 100, T2 excused (max 50) → 70 / 100', () => {
    const r = composeFinal({
      ...base,
      terms: [
        { weight: 50, held: true, subjects: [{ key: 'maths', percentBp: 7000, max: 100 }, { key: 'english', percentBp: 6000, max: 100 }] },
        { weight: 50, held: true, subjects: [{ key: 'maths', percentBp: null, max: 50 }, { key: 'english', percentBp: 8000, max: 100 }] },
      ],
    });
    expect(r.subjectFigures).toEqual([
      { key: 'maths', percentBp: 7000, obtained: 70, max: 100, status: 'assessed' },
      { key: 'english', percentBp: 7000, obtained: 70, max: 100, status: 'assessed' },
    ]);
    // The overall comes from the printed marks: (70 + 70) / (100 + 100) = 70.00 %.
    expect(r.totalObtained).toBe(140);
    expect(r.totalMax).toBe(200);
    expect(r.percentBp).toBe(7000);
    expect(r.grade).toBe('B');
  });

  it('subjects come from held terms only: a subject listed only in a term not held does not appear', () => {
    const r = composeFinal({
      ...base,
      terms: [
        { weight: 100, held: true, subjects: [{ key: 'maths', percentBp: 8000, max: 100 }] },
        { weight: 0, held: false, subjects: [{ key: 'maths', percentBp: 1000, max: 100 }, { key: 'art', percentBp: 9000, max: 50 }] },
      ],
    });
    expect(r.subjectFigures.map((s) => s.key)).toEqual(['maths']);
    expect(r.totalMax).toBe(100);
    expect(r.percentBp).toBe(8000);
  });

  it('refuses a subject max below 1 with a clear error, not a BigInt RangeError', () => {
    const final = () =>
      composeFinal({ ...base, terms: [{ weight: 100, held: true, subjects: [{ key: 'maths', percentBp: 7000, max: 0 }] }] });
    expect(final).toThrow('subject maths: max is a whole number of at least 1');
    expect(() => composeResult({ ...base, subjects: [subject('maths', 7000, 70, 0)] })).toThrow(
      'subject maths: max is a whole number of at least 1',
    );
    expect(() => composeResult({ ...base, subjects: [subject('maths', 7000, 70, 1.5)] })).toThrow('max is a whole number');
  });
});

describe('grades, bands and weights', () => {
  it('gradeFor: the first band reached (rule 26 defaults)', () => {
    expect(gradeFor(10000, DEFAULT_GRADE_BANDS)).toBe('A+');
    expect(gradeFor(9000, DEFAULT_GRADE_BANDS)).toBe('A+');
    expect(gradeFor(8999, DEFAULT_GRADE_BANDS)).toBe('A');
    expect(gradeFor(4000, DEFAULT_GRADE_BANDS)).toBe('E');
    expect(gradeFor(3999, DEFAULT_GRADE_BANDS)).toBe('F');
    expect(gradeFor(0, DEFAULT_GRADE_BANDS)).toBe('F');
  });

  it.each([
    ['the default table', DEFAULT_GRADE_BANDS, null],
    ['one band at 0', [{ grade: 'P', minPercent: 0 }], null],
    ['empty', [], 'at least one band is needed'],
    ['not ending at 0', [{ grade: 'A', minPercent: 50 }], 'the last band must start at 0'],
    ['ascending', [{ grade: 'B', minPercent: 0 }, { grade: 'A', minPercent: 50 }], 'band 2: minimums must be strictly descending'],
    ['two at the same minimum', [{ grade: 'A', minPercent: 50 }, { grade: 'B', minPercent: 50 }, { grade: 'F', minPercent: 0 }], 'band 2: minimums must be strictly descending'],
    ['a grade twice', [{ grade: 'A', minPercent: 50 }, { grade: 'A', minPercent: 0 }], 'band 2: grade A appears twice'],
    ['a fractional minimum', [{ grade: 'A', minPercent: 50.5 }, { grade: 'F', minPercent: 0 }], 'band 1: the minimum is a whole percent from 0 to 100'],
    ['above 100', [{ grade: 'A', minPercent: 101 }, { grade: 'F', minPercent: 0 }], 'band 1: the minimum is a whole percent from 0 to 100'],
    ['a long label', [{ grade: 'Excellent', minPercent: 0 }], 'band 1: a grade is 1-4 letters, digits, + or -'],
    ['thirteen bands', Array.from({ length: 13 }, (_, i) => ({ grade: `G${i}`, minPercent: 60 - i * 5 })), 'at most 12 bands'],
  ])('R255 bandsProblem: %s', (_name, bands, problem) => {
    expect(bandsProblem(bands)).toBe(problem);
  });

  it('default term weights are equal, the remainder on the last, summing to 100', () => {
    expect(defaultTermWeights(1)).toEqual([100]);
    expect(defaultTermWeights(2)).toEqual([50, 50]);
    expect(defaultTermWeights(3)).toEqual([33, 33, 34]);
    expect(defaultTermWeights(6)).toEqual([16, 16, 16, 16, 16, 20]);
    expect(defaultTermWeights(0)).toEqual([]);
  });

  it('formatPercentBp prints two decimals exactly', () => {
    expect(formatPercentBp(7850)).toBe('78.50');
    expect(formatPercentBp(1005)).toBe('10.05');
    expect(formatPercentBp(5)).toBe('0.05');
    expect(formatPercentBp(10000)).toBe('100.00');
  });
});
