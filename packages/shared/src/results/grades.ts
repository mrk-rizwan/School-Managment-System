// Grade bands (rule 26, phase-4-academic.md §3.2, §3.3): a per-year table, validated whole.

/** One band: a percentage at or above `minPercent` earns `grade`. */
export interface GradeBand {
  readonly grade: string;
  /** Whole percent, 0-100. */
  readonly minPercent: number;
}

/** Rule 26's default: A+ ≥ 90, A 80, B 70, C 60, D 50, E 40, F below. */
export const DEFAULT_GRADE_BANDS: readonly GradeBand[] = [
  { grade: 'A+', minPercent: 90 },
  { grade: 'A', minPercent: 80 },
  { grade: 'B', minPercent: 70 },
  { grade: 'C', minPercent: 60 },
  { grade: 'D', minPercent: 50 },
  { grade: 'E', minPercent: 40 },
  { grade: 'F', minPercent: 0 },
];

/** At most this many bands; a grade label is 1-4 characters (`A+`, `B-`, `Fail`). */
export const MAX_GRADE_BANDS = 12;
export const GRADE_LABEL_MAX = 4;

const GRADE_LABEL = /^[A-Za-z0-9+-]{1,4}$/;

/**
 * Why a band table is unacceptable, or null when it is valid (R255): 1-12 bands; each grade 1-4
 * letters, digits, `+` or `-`; each minimum a whole percent 0-100; minimums strictly descending
 * (so unique); exactly one band at 0 (the last); grades unique. The one rule the API, the web
 * form and the app share.
 */
export function bandsProblem(bands: readonly GradeBand[]): string | null {
  if (bands.length === 0) return 'at least one band is needed';
  if (bands.length > MAX_GRADE_BANDS) return `at most ${MAX_GRADE_BANDS} bands`;
  const seen = new Set<string>();
  for (const [i, band] of bands.entries()) {
    if (!GRADE_LABEL.test(band.grade)) return `band ${i + 1}: a grade is 1-4 letters, digits, + or -`;
    if (seen.has(band.grade)) return `band ${i + 1}: grade ${band.grade} appears twice`;
    seen.add(band.grade);
    if (!Number.isInteger(band.minPercent) || band.minPercent < 0 || band.minPercent > 100) {
      return `band ${i + 1}: the minimum is a whole percent from 0 to 100`;
    }
    const previous = bands[i - 1];
    if (previous !== undefined && band.minPercent >= previous.minPercent) {
      return `band ${i + 1}: minimums must be strictly descending`;
    }
  }
  if (bands[bands.length - 1]?.minPercent !== 0) return 'the last band must start at 0';
  return null;
}

/** The grade of a percentage in basis points (7850 = 78.50 %): the first band it reaches. */
export function gradeFor(percentBp: number, bands: readonly GradeBand[]): string {
  const band = bands.find((b) => percentBp >= b.minPercent * 100);
  if (band === undefined) throw new Error('a band table ends at 0 (bandsProblem)');
  return band.grade;
}
