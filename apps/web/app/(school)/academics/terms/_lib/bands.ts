import { bandsProblem, MAX_GRADE_BANDS } from '@asms/shared';
import { z } from 'zod';

// The grade-band table as a form edits it (contracts/slice-29.md §4): rows of text, validated
// whole by the one rule the API applies (@asms/shared bandsProblem, R255): descending minimums,
// one at 0, unique grades. The plan's "zod schema for bands" lives here, because packages/shared
// has no zod dependency.

export const bandRowSchema = z.object({
  grade: z.string().trim().min(1, 'Enter a grade.').max(4, 'At most 4 characters.'),
  minPercent: z
    .string()
    .trim()
    .refine((v) => /^\d{1,3}$/.test(v) && Number(v) <= 100, 'Enter a whole percent from 0 to 100.'),
});

export const bandsSchema = z
  .array(bandRowSchema)
  .min(1, 'Add at least one band.')
  .max(MAX_GRADE_BANDS, `At most ${MAX_GRADE_BANDS} bands.`)
  .superRefine((rows, ctx) => {
    const problem = bandsProblem(toBands(rows));
    if (problem) ctx.addIssue({ code: 'custom', message: `Grade bands: ${problem}.` });
  });

export type BandRow = z.infer<typeof bandRowSchema>;

/** Form rows as the API's bands. */
export const toBands = (rows: readonly BandRow[]) =>
  rows.map((row) => ({ grade: row.grade.trim(), minPercent: Number(row.minPercent) }));

/** The API's bands as form rows. */
export const toBandRows = (bands: readonly { grade: string; minPercent: number }[]): BandRow[] =>
  bands.map((band) => ({ grade: band.grade, minPercent: String(band.minPercent) }));
