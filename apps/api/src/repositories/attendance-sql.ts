// SQL fragments shared by the attendance repositories (contracts/slice-11.md). Fragments only: no
// statement runs here, and every fragment is used inside a statement that filters on school_id.
import type { Scope } from '../tenancy/scope';
import { Prisma } from './generated/prisma/client';

/**
 * A calendar date as a `date` literal. Sent as text and cast, never as a JS Date: a Date travels
 * as a timestamptz and its cast to date would follow the connection's time zone.
 */
export const sqlDate = (date: Date): Prisma.Sql => Prisma.sql`${date.toISOString().slice(0, 10)}::date`;

/** `HH:MM` (or null) as a `time` value. */
export const sqlTime = (time: string | null): Prisma.Sql =>
  time === null ? Prisma.sql`NULL::time` : Prisma.sql`${time}::time`;

/** A `time` column as `HH:MM` text (null stays null). */
export const timeText = (column: Prisma.Sql): Prisma.Sql => Prisma.sql`to_char(${column}, 'HH24:MI')`;

/**
 * `statusOn(student, d)` of §3.1: the to_status of the latest student_status_changes row with
 * effective_on <= d (the admission row counts; none -> active). `studentId` is the column of the
 * enclosing query naming the student, `schoolId` its tenant column.
 */
export const statusOn = (schoolId: Prisma.Sql, studentId: Prisma.Sql, date: Prisma.Sql): Prisma.Sql =>
  Prisma.sql`COALESCE((
    SELECT c.to_status::text FROM student_status_changes c
     WHERE c.school_id = ${schoolId} AND c.student_id = ${studentId} AND c.effective_on <= ${date}
     ORDER BY c.effective_on DESC, c.id DESC LIMIT 1), 'active')`;

/**
 * `onRoster(S, d)` for an enrolment alias `e` (§3.1): in force on d (ended_on is the last day in
 * force) and the student not suspended on d.
 */
export const enrolmentOnRoster = (date: Prisma.Sql): Prisma.Sql =>
  Prisma.sql`(e.started_on <= ${date} AND (e.ended_on IS NULL OR e.ended_on >= ${date})
    AND ${statusOn(Prisma.sql`e.school_id`, Prisma.sql`e.student_id`, date)} <> 'suspended')`;

/**
 * studentInScope (student.repository.ts) as a raw predicate, the same rule: `all` adds nothing; a
 * `students` scope is exactly its ids; a `sections` scope needs an `active` enrolment of the
 * student in one of its sections. An empty list matches no row. `studentId` is the column of the
 * enclosing query naming the student, `schoolId` its tenant column.
 */
export function studentInScopeSql(scope: Scope, schoolId: Prisma.Sql, studentId: Prisma.Sql): Prisma.Sql {
  if (scope.kind === 'all') return Prisma.sql`TRUE`;
  if (scope.ids.length === 0) return Prisma.sql`FALSE`;
  const ids = Prisma.join([...scope.ids]);
  if (scope.kind === 'students') return Prisma.sql`${studentId} IN (${ids})`;
  return Prisma.sql`EXISTS (SELECT 1 FROM enrolments se
     WHERE se.school_id = ${schoolId} AND se.student_id = ${studentId}
       AND se.status = 'active' AND se.section_id IN (${ids}))`;
}

/** A text column read back as one of its enum's values; anything else is a programming error. */
export function oneOf<T extends string>(values: readonly T[], value: string): T {
  const found = values.find((v) => v === value);
  if (found === undefined) throw new Error(`unexpected enum value from the database: ${value}`);
  return found;
}
