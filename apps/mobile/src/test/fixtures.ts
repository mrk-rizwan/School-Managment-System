import type {
  DiaryEntryDto,
  MeAssignmentDto,
  MeDto,
  RegisterViewDto,
  RosterRowDto,
  StudentAttendanceDto,
} from '../api/contracts';
import { todayInSchool } from '@asms/shared';
import { addDays } from '../diary/dates';
import { meFixture } from './fake-api';

// DTO builders for screen tests. Names, a phone and an identity number appear only where a test
// needs them to prove they never reach a body, a log or a screen they do not belong on.

/** The school's today, as the screens compute it. */
export const TODAY = todayInSchool();
const DAY = (back: number) => addDays(TODAY, -back);

export const NAMES = ['Ali Raza', 'Sara Khan', 'Bilal Ahmed', 'Hina Iqbal', 'Usman Tariq'];

export function rosterRow(n: number, patch: Partial<RosterRowDto> = {}): RosterRowDto {
  return {
    alert: null,
    enrolmentId: `${100 + n}`,
    mark: null,
    onRoster: true,
    rollNo: n,
    studentFullName: NAMES[(n - 1) % NAMES.length]!,
    studentId: `${500 + n}`,
    ...patch,
  };
}

export function registerView(patch: Partial<RegisterViewDto> = {}, size = 3): RegisterViewDto {
  return {
    amendable: true,
    callerRole: 'class_teacher',
    canSubmit: true,
    date: TODAY,
    period: 1,
    periodsPerDay: 1,
    register: null,
    roster: Array.from({ length: size }, (_, i) => rosterRow(i + 1)),
    section: {
      academicYearId: '3',
      attendanceMode: 'daily',
      classId: '20',
      className: 'Class 5',
      id: '12',
      name: 'A',
    },
    teachingDay: true,
    ...patch,
  };
}

export function recorded(view: RegisterViewDto): RegisterViewDto {
  return {
    ...view,
    register: {
      academicYearId: '3',
      classId: '20',
      className: 'Class 5',
      date: view.date,
      id: '900',
      lastAmendedAt: null,
      lastAmendedBy: null,
      lastAmendedByName: null,
      mode: 'daily',
      period: view.period,
      sectionId: '12',
      sectionName: 'A',
      source: 'app',
      submittedAt: '2026-10-04T03:10:00.000Z',
      submittedBy: '41',
      submittedByName: 'Nadia Teacher',
      teachingDay: true,
    },
    roster: view.roster.map((row) => ({
      ...row,
      mark: {
        amended: false,
        arrivedAt: null,
        date: view.date,
        enrolmentId: row.enrolmentId,
        id: `m${row.enrolmentId}`,
        note: null,
        period: view.period,
        registerId: '900',
        status: 'present',
        studentId: row.studentId,
      },
    })),
  };
}

export function assignment(patch: Partial<MeAssignmentDto> = {}): MeAssignmentDto {
  return {
    academicYearId: '3',
    attendanceMode: 'daily',
    classId: '20',
    className: 'Class 5',
    endsOn: null,
    id: '70',
    role: 'class_teacher',
    sectionId: '12',
    sectionName: 'A',
    startsOn: '2026-09-01',
    subjectId: null,
    subjectName: null,
    ...patch,
  };
}

export function teacherMe(patch: Partial<MeDto> = {}): MeDto {
  return meFixture({
    id: '41',
    fullName: 'Nadia Teacher',
    roles: ['teacher'],
    capabilities: [
      'attendance.student.mark',
      'diary.write',
      'remark.write',
      'student.view',
    ] as MeDto['capabilities'],
    capacities: ['staff'],
    assignments: [assignment()],
    staffId: '9',
    ...patch,
  });
}

export function guardianMe(patch: Partial<MeDto> = {}): MeDto {
  return meFixture({
    id: '61',
    fullName: 'Imran Raza',
    roles: ['parent'],
    capabilities: [],
    capacities: ['guardian'],
    staffId: null,
    children: [
      {
        current: {
          academicYearId: '3',
          academicYearName: '2026–27',
          classId: '20',
          className: 'Class 5',
          enrolmentId: '101',
          rollNo: 1,
          sectionId: '12',
          sectionName: 'A',
        },
        fullName: 'Ali Raza',
        relationship: 'father',
        status: 'active',
        studentId: '501',
      },
    ],
    ...patch,
  });
}

/** Four days to today: present, late (08:40), not a teaching day, absent today. */
export function studentAttendance(patch: Partial<StudentAttendanceDto> = {}): StudentAttendanceDto {
  return {
    absent: 1,
    countedDays: 2,
    dateFrom: DAY(3),
    dateTo: TODAY,
    days: [
      {
        date: DAY(3),
        enrolled: true,
        periods: [{ period: 1, status: 'present', arrivedAt: null }],
        status: 'present',
        teachingDay: true,
        value: 1,
      },
      {
        date: DAY(2),
        enrolled: true,
        periods: [{ period: 1, status: 'late', arrivedAt: '08:40' }],
        status: 'late',
        teachingDay: true,
        value: 1,
      },
      { date: DAY(1), enrolled: true, periods: [], status: null, teachingDay: false, value: null },
      {
        date: TODAY,
        enrolled: true,
        periods: [{ period: 1, status: 'absent', arrivedAt: null }],
        status: 'absent',
        teachingDay: true,
        value: 0,
      },
    ],
    excludedLeaveDays: 0,
    late: 1,
    onLeave: 0,
    partial: 0,
    percentage: 66.7,
    present: 1,
    studentId: '501',
    teachingDays: 3,
    unrecorded: 0,
    ...patch,
  };
}

export function diaryEntry(patch: Partial<DiaryEntryDto> = {}): DiaryEntryDto {
  return {
    academicYearId: '3',
    assignment: 'Exercise 4, questions 1–5',
    attachmentMime: null,
    attachmentSizeBytes: null,
    authorName: 'Nadia Teacher',
    authorStaffId: '9',
    classId: '20',
    createdAt: '2026-10-04T04:00:00.000Z',
    date: TODAY,
    dueOn: null,
    editWindowEndsOn: '2026-10-11',
    hasAttachment: false,
    id: '300',
    learningOutcome: null,
    sectionId: '12',
    subjectId: '7',
    subjectName: 'English',
    topic: 'Reading: chapter 3',
    updatedAt: '2026-10-04T04:00:00.000Z',
    ...patch,
  };
}
