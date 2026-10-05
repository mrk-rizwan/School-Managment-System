import { Capability, formatDay } from '@asms/shared';
import type { MeAssignmentDto, MeDto, SectionDto } from '../api/contracts';
import { holds, schoolWide } from '../auth/capabilities';

// My classes (slice-16 §4.1), pure: the caller's assignments grouped into one row per section.
// Class teacher, cover and section-level subject rows on one section merge into one row listing
// the roles; a whole-class subject row (sectionId null, R54) stands for every section of its
// class, which the screen fetches.

export type SectionRow = {
  sectionId: string;
  classId: string;
  className: string;
  sectionName: string;
  attendanceMode: MeAssignmentDto['attendanceMode'];
  /** "Class teacher", "Covering until 10 Oct", "English, Urdu". */
  roles: string[];
  /** Class teacher or cover on the section: the daily register and every subject are theirs. */
  holdsSection: boolean;
  /** The subjects the caller teaches on the section (subject-teacher rows). */
  subjects: { id: string; name: string }[];
};

export type RowActions = {
  register: { shown: boolean; enabled: boolean; reason: string | null };
  diary: boolean;
  students: boolean;
};

/** The whole-class subject rows' class ids: the screen fetches each class's sections. */
export function wholeClassIds(assignments: readonly MeAssignmentDto[]): string[] {
  return [...new Set(assignments.filter((a) => a.sectionId === null).map((a) => a.classId))].sort();
}

/**
 * One row per section. `sectionsOf(classId)` gives a class's sections for whole-class subject
 * rows (undefined while not yet loaded: those rows wait).
 */
export function groupAssignments(
  assignments: readonly MeAssignmentDto[],
  sectionsOf: (classId: string) => readonly SectionDto[] | undefined,
): SectionRow[] {
  const rows = new Map<string, SectionRow & { subjectNames: Set<string> }>();
  const rowFor = (a: MeAssignmentDto, sectionId: string, sectionName: string) => {
    let row = rows.get(sectionId);
    if (row === undefined) {
      row = {
        sectionId,
        classId: a.classId,
        className: a.className,
        sectionName,
        attendanceMode: a.attendanceMode,
        roles: [],
        holdsSection: false,
        subjects: [],
        subjectNames: new Set(),
      };
      rows.set(sectionId, row);
    }
    return row;
  };
  const addSubject = (row: SectionRow & { subjectNames: Set<string> }, a: MeAssignmentDto) => {
    if (a.subjectId === null || a.subjectName === null) return;
    if (row.subjects.some((s) => s.id === a.subjectId)) return;
    row.subjects.push({ id: a.subjectId, name: a.subjectName });
    row.subjectNames.add(a.subjectName);
  };

  for (const a of assignments) {
    if (a.sectionId !== null) {
      const row = rowFor(a, a.sectionId, a.sectionName ?? '');
      if (a.role === 'class_teacher') {
        row.holdsSection = true;
        if (!row.roles.includes('Class teacher')) row.roles.unshift('Class teacher');
      } else if (a.role === 'cover') {
        row.holdsSection = true;
        row.roles.push(a.endsOn === null ? 'Covering' : `Covering until ${formatDay(a.endsOn)}`);
      } else addSubject(row, a);
    } else {
      for (const section of sectionsOf(a.classId) ?? []) {
        if (section.archivedAt !== null) continue;
        addSubject(rowFor(a, section.id, section.name), a);
      }
    }
  }

  return [...rows.values()]
    .map(({ subjectNames, ...row }) => ({
      ...row,
      roles: subjectNames.size > 0 ? [...row.roles, [...subjectNames].join(', ')] : row.roles,
    }))
    .sort(
      (x, y) =>
        x.className.localeCompare(y.className, 'en', { numeric: true }) ||
        x.sectionName.localeCompare(y.sectionName, 'en', { numeric: true }),
    );
}

/** What a row offers, by capability and role (slice-16 §4.1). */
export function actionsFor(
  me: Pick<MeDto, 'capabilities' | 'capabilityScopes'>,
  row: SectionRow,
): RowActions {
  const mark = holds(me, Capability.ATTENDANCE_STUDENT_MARK);
  // slice-11 §1.2: the daily register is the class teacher's (or the cover's) — unless the key is
  // held school-wide, which writes every register (MeDto.capabilityScopes, slice-14 §8).
  const subjectOnlyDaily =
    !row.holdsSection &&
    row.attendanceMode === 'daily' &&
    !schoolWide(me, Capability.ATTENDANCE_STUDENT_MARK);
  return {
    register: {
      shown: mark,
      enabled: mark && !subjectOnlyDaily,
      reason: subjectOnlyDaily ? 'Daily register is the class teacher’s' : null,
    },
    diary: holds(me, Capability.DIARY_WRITE),
    students: holds(me, Capability.STUDENT_VIEW),
  };
}

/** "Class 5 A": a section by its class and its own name. */
export const sectionTitle = (className: string, sectionName: string) =>
  `${className} ${sectionName}`.trim();
