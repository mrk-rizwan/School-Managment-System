import type { ClassSubjectDto } from '../../lib/api/school-academics-contract';
import type { StaffDto } from '../../lib/api/school-staff-contract';
import type {
  SectionTimetableDto,
  TimetableGridDto,
  TimetableSlotDto,
  TimetableSubstitutionDto,
  TimetableVersionDetailDto,
} from '../../lib/api/school-timetable-contract';

// Slice 37 fixtures (contracts/slice-37.md), shared by the timetable spec and the tablet check:
// Class 5 A with a live version from 1 September, four periods a day, Sunday off; Class 5 B has
// Imran Ali in Monday period 2.

const STAMP = '2026-09-20T05:00:00.000Z';

export const TT_SUBJECTS: ClassSubjectDto[] = [
  { id: 'cs-m', classId: 'c5', subjectId: 'sub-m', subjectName: 'Mathematics', subjectCode: null, examMaxMarks: 100, sortOrder: 1 },
  { id: 'cs-e', classId: 'c5', subjectId: 'sub-e', subjectName: 'English', subjectCode: null, examMaxMarks: 100, sortOrder: 2 },
];

export const TT_STAFF = [
  { id: 'st-t', fullName: 'Ayesha Malik' },
  { id: 'st-2', fullName: 'Imran Ali' },
] as unknown as StaffDto[];

const slot = (id: string, weekday: number, period: number, extra: Partial<TimetableSlotDto> = {}): TimetableSlotDto => ({
  id,
  weekday,
  period,
  classSubjectId: 'cs-m',
  subjectName: 'Mathematics',
  staffId: 'st-t',
  teacherName: 'Ayesha Malik',
  room: null,
  assignedTeacher: true,
  ...extra,
});

export const TT_SLOTS: TimetableSlotDto[] = [
  slot('slot-1', 1, 1, { room: 'Lab 1' }),
  slot('slot-2', 2, 1, { classSubjectId: 'cs-e', subjectName: 'English', staffId: 'st-2', teacherName: 'Imran Ali', assignedTeacher: false }),
];

export const TT_VERSION: TimetableVersionDetailDto = {
  id: 'tv1',
  sectionId: 'sec-a',
  sectionName: 'A',
  classId: 'c5',
  className: 'Class 5',
  academicYearId: 'y1',
  effectiveFrom: '2026-09-01',
  effectiveTo: null,
  status: 'live',
  slotCount: TT_SLOTS.length,
  createdByName: 'Amina Principal',
  createdAt: STAMP,
  voidedAt: null,
  voidedByName: null,
  voidReason: null,
  slots: TT_SLOTS,
};

export const TT_FUTURE_VERSION: TimetableVersionDetailDto = {
  ...TT_VERSION,
  id: 'tv2',
  effectiveFrom: '2026-11-01',
  status: 'future',
};

export const TT_SUBSTITUTION: TimetableSubstitutionDto = {
  id: 'sub1',
  sectionId: 'sec-a',
  sectionName: 'A',
  classId: 'c5',
  className: 'Class 5',
  date: '2026-10-05',
  period: 1,
  staffId: 'st-2',
  teacherName: 'Imran Ali',
  regularStaffId: 'st-t',
  regularTeacherName: 'Ayesha Malik',
  subjectName: 'Mathematics',
  reason: 'Ayesha is at a training day',
  createdByName: 'Amina Principal',
  createdAt: STAMP,
  voidedAt: null,
  voidReason: null,
};

const DATES = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];

/** The week of Monday 5 October 2026; `today` decides which day carries the live version. */
export function ttWeek(): SectionTimetableDto {
  return {
    section: { id: 'sec-a', name: 'A', classId: 'c5', className: 'Class 5', academicYearId: 'y1' },
    weekOf: DATES[0]!,
    periodsPerDay: 4,
    days: DATES.map((date, i) => {
      const weekday = (i + 1) % 7;
      return {
        date,
        weekday,
        teachingDay: weekday !== 0,
        versionId: 'tv1',
        slots: TT_SLOTS.filter((s) => s.weekday === weekday),
        substitutions: date === TT_SUBSTITUTION.date ? [TT_SUBSTITUTION] : [],
      };
    }),
  };
}

/** GET /timetable/grid for one weekday: Class 5 A (the version above) and Class 5 B. */
export function ttGrid(date: string, weekday: number): TimetableGridDto {
  return {
    academicYearId: 'y1',
    date,
    weekday,
    periodsPerDay: 4,
    weeklyOffDays: [0],
    sections: [
      {
        sectionId: 'sec-a',
        sectionName: 'A',
        classId: 'c5',
        className: 'Class 5',
        versionId: 'tv1',
        cells: TT_SLOTS.filter((s) => s.weekday === weekday),
      },
      {
        sectionId: 'sec-b',
        sectionName: 'B',
        classId: 'c5',
        className: 'Class 5',
        versionId: 'tv-b',
        cells: weekday === 1 ? [slot('slot-b1', 1, 2, { staffId: 'st-2', teacherName: 'Imran Ali', room: 'Room 7' })] : [],
      },
    ],
  };
}
