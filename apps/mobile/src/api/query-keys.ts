// TanStack Query keys, in one place so a wipe or an invalidation names exactly what it means
// (slice-16 §3.1's normative table). Dates are YYYY-MM-DD in school time; a page is part of a key.
export const queryKeys = {
  me: ['me'] as const,
  calendar: (dateFrom: string, dateTo: string) => ['me', 'calendar', dateFrom, dateTo] as const,
  cacheRow: (key: string) => ['cache-row', key] as const,

  // Teacher
  classSections: (classId: string) => ['classes', classId, 'sections'] as const,
  register: (sectionId: string, date: string, period: number) =>
    ['sections', sectionId, 'register', date, period] as const,
  markChanges: (markId: string, page: number) =>
    ['attendance-marks', markId, 'changes', page] as const,
  sectionDiary: (sectionId: string, dateFrom: string, dateTo: string, page: number) =>
    ['sections', sectionId, 'diary', dateFrom, dateTo, page] as const,
  subjects: ['subjects'] as const,
  studentRemarks: (studentId: string, page: number) =>
    ['students', studentId, 'remarks', page] as const,

  // Parent, student, staff
  /**
   * A family read (slice-16 §5): a guardian's child (`studentId`) or the student's own (null) —
   * ['me','children',id,…] or ['me','student',…], then the resource and its key parts
   * (attendance: dateFrom, dateTo; diary: dateFrom, dateTo, page; remarks: page).
   */
  family: (
    studentId: string | null,
    resource: 'attendance' | 'diary' | 'remarks',
    ...parts: (string | number)[]
  ) =>
    [
      ...(studentId === null ? ['me', 'student'] : ['me', 'children', studentId]),
      resource,
      ...parts,
    ] as const,
  staffAttendance: (dateFrom: string, dateTo: string) =>
    ['me', 'staff', 'attendance', dateFrom, dateTo] as const,

  // Principal (16b): Today and Announce
  unrecorded: (date: string, page: number) =>
    ['attendance-registers', date, 'unrecorded', page] as const,
  dailySummary: (date: string, page: number) =>
    ['attendance-reports', 'daily-summary', date, page] as const,
  activeStaff: (page: number) => ['staff', 'active', page] as const,
  staffAssignments: (staffId: string) => ['staff', staffId, 'assignments'] as const,
  messagingUsage: ['messaging', 'usage'] as const,
  announcements: (page: number) => ['announcements', page] as const,
  announcement: (id: string) => ['announcements', 'one', id] as const,
  delivery: (id: string) => ['announcements', 'one', id, 'delivery'] as const,
  classes: (page: number) => ['classes', page] as const,

  // Everyone (16b): the inbox
  inbox: (category: string, page: number) => ['me', 'inbox', category, page] as const,
  inboxItem: (id: string) => ['me', 'inbox', 'item', id] as const,

  // Rows on the device (local tables), refreshed whenever the outbox changes.
  local: ['local'] as const,
  localRegister: (sectionId: string, date: string, period: number) =>
    ['local', 'register', sectionId, date, period] as const,
  localDiary: (sectionId: string) => ['local', 'diary', sectionId] as const,
  localRemarks: (studentId: string) => ['local', 'remarks', studentId] as const,
};

/** Prefixes for invalidation after a write reaches the server (slice-16 §3.1). */
export const invalidationKeys = {
  register: (sectionId: string, date: string, period: number) => [
    queryKeys.register(sectionId, date, period),
    ['attendance-registers', date],
    ['attendance-reports'],
  ],
  sectionDiary: (sectionId: string) => [['sections', sectionId, 'diary']],
  studentRemarks: (studentId: string) => [['students', studentId, 'remarks']],
};
