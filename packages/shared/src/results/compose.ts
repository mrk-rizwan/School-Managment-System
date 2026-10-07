// Result composition (rule 26, phase-4-academic.md §0.26, §1.1, §3.3): the one definition of how a
// term result, a final result, a grade, a position and a pass verdict are computed. The API calls
// these inside the approving transaction and stores the output; the web and the app call them
// only to preview a draft sheet. Percentages are integers in basis points (7850 = 78.50 %),
// rounded half-up exactly once per figure from exact (BigInt) fractions, so no floating-point
// error can move a boundary. The overall figures come from the printed per-subject marks, so a
// parent who adds up the card gets the card's percentage.
import type { PassRule, ResultSubjectStatus } from '../academics';
import { gradeFor, type GradeBand } from './grades';

/** 100.00 % in basis points. */
export const FULL_BP = 10_000;

/** `num ÷ den` rounded half-up, for num ≥ 0 and den > 0. */
function halfUp(num: bigint, den: bigint): number {
  return Number((2n * num + den) / (2n * den));
}

/** An exact non-negative fraction. */
interface Fraction {
  readonly num: bigint;
  readonly den: bigint;
}

const fraction = (num: number, den: number): Fraction => ({ num: BigInt(num), den: BigInt(den) });

const add = (a: Fraction, b: Fraction): Fraction => ({ num: a.num * b.den + b.num * a.den, den: a.den * b.den });

const toBp = (f: Fraction): number => halfUp(f.num * BigInt(FULL_BP), f.den);

function assertMarks(obtained: number | null, max: number, absent: boolean, what: string): void {
  if (!Number.isInteger(max) || max < 1) throw new Error(`${what}: max is a whole number of at least 1`);
  if (absent !== (obtained === null)) throw new Error(`${what}: exactly one of obtained or absent`);
  if (obtained !== null && (!Number.isInteger(obtained) || obtained < 0 || obtained > max)) {
    throw new Error(`${what}: obtained is a whole number from 0 to max`);
  }
}

// --------------------------------------------------------------------------------- a subject

/** One class test as the student met it. */
export interface TestMarkInput {
  /** Null when absent. */
  readonly obtained: number | null;
  readonly max: number;
  /** Counts 0 unless excused (rule 26). */
  readonly absent: boolean;
  /** An excused absence is left out of the average. */
  readonly excused: boolean;
  /**
   * False for a test the student could not sit (held before their first enrolment in the class,
   * §1.1): left out. A test held on or after it with no mark is a gap, which submission refuses.
   */
  readonly applicable: boolean;
}

/** The term exam as the student met it. */
export interface ExamMarkInput {
  readonly obtained: number | null;
  readonly max: number;
  readonly absent: boolean;
  readonly excused: boolean;
}

/** Whole percents summing to 100 (result_settings: test_weight, exam_weight). */
export interface ComponentWeights {
  readonly test: number;
  readonly exam: number;
}

export interface SubjectInput {
  readonly tests: readonly TestMarkInput[];
  /** Null when the subject has no exam for the student (not set up). */
  readonly exam: ExamMarkInput | null;
  readonly weights: ComponentWeights;
  /** The printed maximum: the exam's max marks, else the class-subject's exam_max_marks. */
  readonly max: number;
}

export interface SubjectFigures {
  /** The class-test aggregate, or null when no test counts. */
  readonly testBp: number | null;
  /** The exam, or null when it does not count (none, or excused). */
  readonly examBp: number | null;
  /** The subject's term percentage; null iff not assessed. */
  readonly percentBp: number | null;
  /** Printed obtained = round(percentBp × max ÷ 10000); null iff not assessed. */
  readonly obtained: number | null;
  readonly max: number;
  readonly status: ResultSubjectStatus;
}

function assertWeights(weights: ComponentWeights): void {
  const ok = (w: number) => Number.isInteger(w) && w >= 0 && w <= 100;
  if (!ok(weights.test) || !ok(weights.exam) || weights.test + weights.exam !== 100) {
    throw new Error('weights are whole percents summing to 100');
  }
}

/**
 * One subject's term figures (R258). Applicable, non-excused tests are averaged as percentages, so
 * a 10-mark quiz and a 50-mark test count equally; an absence counts 0; an excused absence and an
 * inapplicable test are left out. Composition is tests × W₁ + exam × W₂; when one component is
 * missing the other carries 100 %; when both are missing the subject is `not_assessed`.
 */
export function composeSubject(input: SubjectInput): SubjectFigures {
  assertWeights(input.weights);
  if (!Number.isInteger(input.max) || input.max < 1) throw new Error('max is a whole number of at least 1');
  for (const test of input.tests) assertMarks(test.obtained, test.max, test.absent, 'test');
  if (input.exam) assertMarks(input.exam.obtained, input.exam.max, input.exam.absent, 'exam');

  const counted = input.tests.filter((t) => t.applicable && !t.excused);
  let tests: Fraction | null = null;
  if (counted.length > 0) {
    const sum = counted
      .map((t) => fraction(t.obtained ?? 0, t.max))
      .reduce((a, b) => add(a, b));
    tests = { num: sum.num, den: sum.den * BigInt(counted.length) };
  }
  const exam: Fraction | null =
    input.exam && !input.exam.excused ? fraction(input.exam.obtained ?? 0, input.exam.max) : null;

  let percent: Fraction | null;
  if (tests && exam) {
    percent = {
      num: tests.num * exam.den * BigInt(input.weights.test) + exam.num * tests.den * BigInt(input.weights.exam),
      den: tests.den * exam.den * 100n,
    };
  } else {
    percent = tests ?? exam;
  }
  const percentBp = percent && toBp(percent);
  return {
    testBp: tests && toBp(tests),
    examBp: exam && toBp(exam),
    percentBp,
    obtained: percentBp === null ? null : halfUp(BigInt(percentBp) * BigInt(input.max), BigInt(FULL_BP)),
    max: input.max,
    status: percentBp === null ? 'not_assessed' : 'assessed',
  };
}

// ---------------------------------------------------------------------------- a whole result

/** A subject's figures, keyed (the class-subject id as a string, say). */
export interface KeyedSubject {
  readonly key: string;
  readonly percentBp: number | null;
  readonly obtained: number | null;
  readonly max: number;
  readonly status: ResultSubjectStatus;
}

export interface ResultInput {
  readonly subjects: readonly KeyedSubject[];
  readonly bands: readonly GradeBand[];
  readonly passRule: PassRule;
  /** Whole percent 0-100. */
  readonly passPercent: number;
}

export interface ResultFigures {
  /** Σ printed obtained over assessed subjects. */
  readonly totalObtained: number;
  /** Σ max over assessed subjects. */
  readonly totalMax: number;
  /** totalObtained ÷ totalMax; null when nothing is assessed. */
  readonly percentBp: number | null;
  readonly grade: string | null;
  /** Null when nothing is assessed (R259). */
  readonly passed: boolean | null;
  /** Keys of the assessed subjects below the pass mark, in input order. */
  readonly failedSubjects: readonly string[];
  /** Per subject, in input order: its grade and pass verdict (null when not assessed). */
  readonly subjects: readonly { readonly key: string; readonly grade: string | null; readonly passed: boolean | null }[];
}

/** A keyed subject's printed max is a whole number of at least 1 (it divides the percentage). */
function assertSubjectMax(key: string, max: number): void {
  if (!Number.isInteger(max) || max < 1) throw new Error(`subject ${key}: max is a whole number of at least 1`);
}

/** printed obtained ÷ max ≥ pass mark, in integers. */
const subjectPasses = (obtained: number, max: number, passPercent: number): boolean =>
  obtained * 100 >= passPercent * max;

/**
 * The overall figures of one result (R259): totals from the printed marks; the overall percentage
 * from them, half-up; the grade from the bands; the per-subject pass check on printed obtained ÷
 * max; `passed` by the pass rule, null when no subject is assessed.
 */
export function composeResult(input: ResultInput): ResultFigures {
  if (!Number.isInteger(input.passPercent) || input.passPercent < 0 || input.passPercent > 100) {
    throw new Error('the pass mark is a whole percent from 0 to 100');
  }
  for (const s of input.subjects) assertSubjectMax(s.key, s.max);
  const subjects = input.subjects.map((s) => {
    if ((s.status === 'assessed') !== (s.percentBp !== null && s.obtained !== null)) {
      throw new Error(`subject ${s.key}: assessed iff it has a percentage and a printed mark`);
    }
    if (s.obtained === null || s.percentBp === null) return { key: s.key, grade: null, passed: null };
    return {
      key: s.key,
      grade: gradeFor(s.percentBp, input.bands),
      passed: subjectPasses(s.obtained, s.max, input.passPercent),
    };
  });
  const assessed = input.subjects.filter((s) => s.status === 'assessed');
  const totalObtained = assessed.reduce((n, s) => n + (s.obtained ?? 0), 0);
  const totalMax = assessed.reduce((n, s) => n + s.max, 0);
  const percentBp = assessed.length === 0 ? null : halfUp(BigInt(totalObtained) * BigInt(FULL_BP), BigInt(totalMax));
  const failedSubjects = subjects.filter((s) => s.passed === false).map((s) => s.key);
  let passed: boolean | null = null;
  if (percentBp !== null) {
    passed = input.passRule === 'overall' ? percentBp >= input.passPercent * 100 : failedSubjects.length === 0;
  }
  return {
    totalObtained,
    totalMax,
    percentBp,
    grade: percentBp === null ? null : gradeFor(percentBp, input.bands),
    passed,
    failedSubjects,
    subjects,
  };
}

// ------------------------------------------------------------------------------- positions

export interface Positioned {
  /** Null for a student with nothing assessed: no position. */
  readonly position: number | null;
  readonly positionOf: number | null;
}

/**
 * Standard competition ranking (1, 1, 3) by `percentBp` within the section (R260): ties share a
 * position; `positionOf` is the number of positioned students; a student with nothing assessed
 * holds none. Ranking by percentage, not total, so an excused subject neither lifts nor lowers a
 * position. Returned in input order.
 */
export function positions(rows: readonly { readonly percentBp: number | null }[]): Positioned[] {
  const ranked = rows.flatMap((r) => (r.percentBp === null ? [] : [r.percentBp]));
  return rows.map((r) => {
    if (r.percentBp === null) return { position: null, positionOf: null };
    const percent = r.percentBp;
    return { position: 1 + ranked.filter((p) => p > percent).length, positionOf: ranked.length };
  });
}

// ---------------------------------------------------------------------------- the final result

export interface FinalTermInput {
  /** Whole percent; the held terms of a year sum to 100. */
  readonly weight: number;
  /** False for a term `not_held` for the class: skipped (A6). */
  readonly held: boolean;
  /** The student's stored term figures for that term, per subject. */
  readonly subjects: readonly { readonly key: string; readonly percentBp: number | null; readonly max: number }[];
}

export interface FinalInput extends Omit<ResultInput, 'subjects'> {
  /** In term order. */
  readonly terms: readonly FinalTermInput[];
}

export interface FinalFigures extends ResultFigures {
  /** Per subject, in order of first appearance: the final percentage and printed mark. */
  readonly subjectFigures: readonly KeyedSubject[];
}

/**
 * The final result (rule 26, A6, R275): per subject, the weighted mean of its term percentages
 * over the held terms in which the student was assessed in it, the weights renormalised; the
 * printed max is the last such term's (an excused or unassessed later term does not change it).
 * Subjects come from held terms only. A subject assessed only in terms of weight 0 is not
 * assessed. Every subject max is a whole number of at least 1. Then the overall figures exactly
 * as a term's (composeResult).
 */
export function composeFinal(input: FinalInput): FinalFigures {
  const keys: string[] = [];
  for (const term of input.terms) {
    if (!Number.isInteger(term.weight) || term.weight < 0 || term.weight > 100) {
      throw new Error('a term weight is a whole percent from 0 to 100');
    }
    for (const s of term.subjects) assertSubjectMax(s.key, s.max);
    // A term not held contributes nothing, not even a subject key.
    if (!term.held) continue;
    for (const s of term.subjects) if (!keys.includes(s.key)) keys.push(s.key);
  }
  const subjectFigures = keys.map((key): KeyedSubject => {
    let weighted = 0n;
    let weights = 0n;
    // The printed max: the last held term in which the student was assessed in the subject; for a
    // subject assessed in none, the last held term that lists it.
    let assessedMax: number | null = null;
    let listedMax = 1;
    for (const term of input.terms) {
      if (!term.held) continue;
      const s = term.subjects.find((x) => x.key === key);
      if (!s) continue;
      listedMax = s.max;
      if (s.percentBp === null) continue;
      assessedMax = s.max;
      weighted += BigInt(term.weight) * BigInt(s.percentBp);
      weights += BigInt(term.weight);
    }
    if (weights === 0n) {
      return { key, percentBp: null, obtained: null, max: assessedMax ?? listedMax, status: 'not_assessed' };
    }
    const max = assessedMax ?? listedMax;
    const percentBp = halfUp(weighted, weights);
    return {
      key,
      percentBp,
      obtained: halfUp(BigInt(percentBp) * BigInt(max), BigInt(FULL_BP)),
      max,
      status: 'assessed',
    };
  });
  return {
    ...composeResult({ ...input, subjects: subjectFigures }),
    subjectFigures,
  };
}

// -------------------------------------------------------------------------- weights, display

/**
 * The default weights of `n` held terms (§1.1): equal, `100 ÷ n` each with the remainder on the
 * last, so they sum to 100.
 */
export function defaultTermWeights(n: number): number[] {
  if (!Number.isInteger(n) || n < 1) return [];
  const each = Math.floor(100 / n);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? 100 - each * (n - 1) : each));
}

/** A percentage in basis points as printed: `78.50`. */
export const formatPercentBp = (bp: number): string =>
  `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, '0')}`;
