import { Capability } from '@asms/shared';
import { expect as baseExpect, test, type Page } from '@playwright/test';
import type { components as PlatformSchemas } from '../lib/api/platform';
import type { ApiErrorEnvelope } from '../lib/api/errors';
import { FINANCE_SETTINGS } from './support/settings';
import type { AcademicYearDto, ClassDto, SectionDto, SubjectDto } from '../lib/api/school-academics-contract';
import type {
  PlatformDeliveryHealthDto,
  PlatformSettingsDto,
  SchoolDto as PlatformSchoolDto,
} from '../lib/api/platform-messaging-contract';
import type { RegisterViewDto, SectionDayDto } from '../lib/api/school-attendance-contract';
import type { HolidayDto, TeachingDaysDto } from '../lib/api/school-calendar-contract';
import type { DiaryEntryDto } from '../lib/api/school-diary-contract';
import type {
  AnnouncementDto,
  AudiencePreviewDto,
  DeliverySummaryDto,
  InboxItemDto,
} from '../lib/api/school-announcements-contract';
import type { MyStaffAttendanceDto, StaffDayDto } from '../lib/api/school-staff-attendance-contract';
import type { MeDto, UserDto } from '../lib/api/school-contract';
import type {
  MessagingUsageDto,
  SchoolSettingsDto,
  WhatsAppSettingsDto,
} from '../lib/api/school-messaging-contract';
import type { GuardianDetailDto, GuardianStudentDto } from '../lib/api/school-guardians-contract';
import type { CustomRoleDto } from '../lib/api/school-roles-contract';
import type { StaffDto, TeacherAssignmentDto } from '../lib/api/school-staff-contract';
import type {
  EnrolmentDto,
  GuardianLinkDto,
  StudentDetailDto,
} from '../lib/api/school-students-contract';

// Plan §9: every screen works at tablet width. Each route is opened at 768 x 1024 against a
// mocked API (every /api/v1/* request answered in the browser by page.route) with a few
// realistic rows, so tables render. The page itself must not scroll sideways; a wide table may
// scroll inside its own container. An unmocked request fails the test, so no screen is checked
// in an error state by accident.

const expect = baseExpect.configure({ timeout: 15_000 });

const TABLET = { width: 768, height: 1024 };
const TOKEN = 'Abcdefghij_klmnopqrst-uvwxyz0123456789ABCDE';
const STAMP = '2026-09-01T05:00:00.000Z';

type PlatformMe = PlatformSchemas['schemas']['PlatformMeDto'];
type School = PlatformSchoolDto;

const PRINCIPAL_ME: MeDto = {
  id: 'u-principal',
  fullName: 'Amina Principal',
  email: 'amina@example.test',
  hasVerifiedEmail: true,
  passwordIsDefault: false,
  blockedCapabilities: [],
  school: { id: 's1', name: 'Green Valley Higher Secondary School', shortCode: 'greenvalley', status: 'active' },
  roles: ['principal'],
  capabilities: Object.values(Capability).sort(),
  capabilityScopes: Object.values(Capability)
    .sort()
    .map((capability) => ({ capability, scope: 'all' as const })),
  sessionExpiresAt: '2026-11-02T05:00:00.000Z',
  capacities: ['staff'],
  assignments: [],
  staffId: null,
  children: [],
};

const YEARS: AcademicYearDto[] = [
  { id: 'y1', name: '2026-27', startsOn: '2026-04-01', endsOn: '2027-03-31', status: 'active', createdAt: STAMP, updatedAt: STAMP },
  { id: 'y2', name: '2026-27 (September)', startsOn: '2026-09-01', endsOn: '2027-08-31', status: 'planned', createdAt: STAMP, updatedAt: STAMP },
  { id: 'y0', name: '2025-26', startsOn: '2025-04-01', endsOn: '2026-03-31', status: 'closed', createdAt: STAMP, updatedAt: STAMP },
];
const klass = (id: string, name: string, sortOrder: number): ClassDto => ({
  id,
  academicYearId: 'y1',
  academicYearName: '2026-27',
  name,
  attendanceMode: sortOrder > 8 ? 'period' : 'daily',
  sortOrder,
  status: 'active',
  createdAt: STAMP,
  updatedAt: STAMP,
});
const CLASSES = [klass('c5', 'Class 5', 5), klass('c6', 'Class 6', 6), klass('c9', 'Class 9 (Science)', 9)];
const section = (id: string, classId: string, name: string, capacity: number | null): SectionDto => ({
  id,
  classId,
  name,
  capacity,
  archivedAt: null,
  createdAt: STAMP,
  updatedAt: STAMP,
});
const SECTIONS = [section('sec-a', 'c5', 'A', 40), section('sec-b', 'c5', 'B', 40), section('sec-c', 'c5', 'Rose', null)];
const subject = (id: string, name: string, code: string | null): SubjectDto => ({
  id,
  name,
  code,
  archivedAt: null,
  createdAt: STAMP,
  updatedAt: STAMP,
});
const SUBJECTS = [subject('sub-m', 'Mathematics', 'MATH'), subject('sub-e', 'English', 'ENG'), subject('sub-i', 'Islamiyat', null)];

const staffRow = (id: string, fullName: string, extra: Partial<StaffDto> = {}): StaffDto => ({
  id,
  fullName,
  cnicMasked: '35201-*****-1',
  hasCnic: true,
  phone: '+923001234567',
  designation: 'Senior subject teacher',
  joinedOn: '2026-08-01',
  status: 'active',
  userId: null,
  systemRoles: [],
  customRoleNames: [],
  createdAt: STAMP,
  updatedAt: STAMP,
  ...extra,
});
const STAFF = [
  staffRow('st1', 'Ayesha Malik', { userId: 'u7', systemRoles: ['teacher'], customRoleNames: ['Exams desk'] }),
  staffRow('st2', 'Muhammad Bilal Ahmed Qureshi', { designation: 'Accounts and admissions officer', systemRoles: ['office_staff'], userId: 'u8' }),
  staffRow('st3', 'Sadia Noor', { cnicMasked: null, hasCnic: false, designation: null, status: 'suspended' }),
];
const ASSIGNMENTS: TeacherAssignmentDto[] = [
  {
    id: 'ta1',
    staffId: 'st1',
    staffFullName: 'Ayesha Malik',
    academicYearId: 'y1',
    academicYearName: '2026-27',
    classId: 'c5',
    className: 'Class 5',
    sectionId: 'sec-a',
    sectionName: 'A',
    subjectId: null,
    subjectName: null,
    role: 'class_teacher',
    startsOn: '2026-04-01',
    endsOn: null,
    voidedAt: null,
    activeToday: true,
    coversAssignmentId: null,
    coversStaffFullName: null,
    createdAt: STAMP,
  },
];

const user = (id: string, fullName: string, extra: Partial<UserDto> = {}): UserDto => ({
  id,
  staffId: `st-${id}`,
  guardianId: null,
  studentId: null,
  fullName,
  systemRoles: ['teacher'],
  customRoleNames: [],
  status: 'active',
  emailMasked: 'k***@example.test',
  hasEmail: true,
  hasVerifiedEmail: true,
  passwordIsDefault: false,
  lastLoginAt: '2026-10-01T04:30:00.000Z',
  createdAt: STAMP,
  ...extra,
});
const USERS = [
  user('u7', 'Ayesha Malik', { customRoleNames: ['Exams desk'] }),
  user('u8', 'Muhammad Bilal Ahmed Qureshi', { systemRoles: ['office_staff'], passwordIsDefault: true, emailMasked: null, hasEmail: false, hasVerifiedEmail: false, lastLoginAt: null }),
  user('u9', 'Ahmed Khan', { staffId: null, guardianId: 'g1', systemRoles: [] }),
];

const guardian = (id: string, fullName: string, extra: Partial<GuardianDetailDto> = {}): GuardianDetailDto => ({
  id,
  fullName,
  cnicMasked: '35201-*****-1',
  hasCnic: true,
  phone: '+923001234567',
  hasPhone: true,
  contactCapability: 'whatsapp',
  status: 'active',
  mergedIntoId: null,
  userId: null,
  createdAt: STAMP,
  updatedAt: STAMP,
  email: 'ahmed.khan.family@example.test',
  address: 'House 12, Street 4, Block C, Gulberg III, Lahore',
  ...extra,
});
const GUARDIANS = [
  guardian('g1', 'Ahmed Khan', { userId: 'u9' }),
  guardian('g2', 'Rukhsana Begum', { contactCapability: 'keypad', email: null }),
  guardian('g3', 'Tariq Mehmood Chaudhry', { contactCapability: 'smartphone_data', hasCnic: false, cnicMasked: null }),
];
const GUARDIAN_STUDENTS: GuardianStudentDto[] = [
  {
    linkId: 'l1',
    studentId: 'st-s1',
    studentFullName: 'Ali Khan',
    admissionNo: '1001',
    className: 'Class 5',
    sectionName: 'A',
    relationship: 'father',
    isPrimaryContact: true,
    isFeePayer: true,
    canLogin: true,
    linkEndedAt: null,
  },
];

const student = (id: string, fullName: string, extra: Partial<StudentDetailDto> = {}): StudentDetailDto => ({
  id,
  admissionNo: '1001',
  fullName,
  gender: 'male',
  dateOfBirth: '2016-05-04',
  hasBForm: true,
  bFormMasked: '35202-*****-3',
  status: 'active',
  admittedOn: '2025-04-01',
  current: {
    enrolmentId: 'e1',
    academicYearId: 'y1',
    academicYearName: '2026-27',
    classId: 'c5',
    className: 'Class 5',
    sectionId: 'sec-a',
    sectionName: 'A',
    rollNo: 7,
  },
  userId: null,
  createdAt: STAMP,
  updatedAt: STAMP,
  notes: 'Allergic to peanuts; collected by his uncle on Fridays.',
  photoDocumentId: null,
  ...extra,
});
const STUDENTS = [
  student('st-s1', 'Ali Khan'),
  student('st-s2', 'Fatima Zahra Siddiqui', { admissionNo: '1002', gender: 'female' }),
  student('st-s3', 'Hina Ali', { admissionNo: '0987', status: 'withdrawn', current: null }),
];
const LINKS: GuardianLinkDto[] = [
  {
    id: 'l1',
    studentId: 'st-s1',
    guardianId: 'g1',
    guardianFullName: 'Ahmed Khan',
    relationship: 'father',
    isPrimaryContact: true,
    isFeePayer: true,
    canLogin: true,
    phone: '+923001234567',
    endedAt: null,
    contactCapability: 'whatsapp',
    guardianCnicMasked: '35201-*****-1',
    guardianAddress: 'House 12, Street 4, Block C, Gulberg III, Lahore',
    guardianUserId: 'u9',
  },
];
const ENROLMENTS: EnrolmentDto[] = [
  {
    id: 'e1',
    studentId: 'st-s1',
    academicYearId: 'y1',
    academicYearName: '2026-27',
    classId: 'c5',
    className: 'Class 5',
    sectionId: 'sec-a',
    sectionName: 'A',
    rollNo: 7,
    status: 'active',
    startedOn: '2025-04-01',
    endedOn: null,
  },
];

const customRole = (id: string, name: string, capabilities: CustomRoleDto['capabilities'], holderCount: number): CustomRoleDto => ({
  id,
  key: name.toLowerCase().replace(/\W+/g, '_'),
  name,
  status: 'active',
  capabilities,
  holderCount,
  createdAt: STAMP,
  updatedAt: STAMP,
});
const CUSTOM_ROLES = [
  customRole('cr1', 'Accounts clerk', [Capability.PAYMENT_RECORD, Capability.PAYMENT_VERIFY], 2),
  customRole('cr2', 'Exams desk', [Capability.PAYMENT_RECORD], 1),
];

const SETTINGS: SchoolSettingsDto = {
  ...FINANCE_SETTINGS,
  feeDueDay: 10,
  studentLoginEnabled: true,
  periodsPerDay: 8,
  weeklyOffDays: [0],
  attendanceAmendWindowDays: 3,
  registerDeadlineTime: '10:00',
  absenceAlertTime: '09:30',
  lateAdviceEnabled: true,
  lateCountsAs: 'absent_after_cutoff',
  lateCutoffTime: '08:15',
  leaveCountsAs: 'excused',
  smsMonthlyCap: 500,
  smsAllowedTypes: ['absence_alert', 'late_advice', 'attendance_corrected', 'announcement_urgent', 'holiday_notice'],
  remarkDefaultVisibility: 'guardian',
  remarkNotifyGuardians: false,
  updatedAt: STAMP,
};

// Wave D (contracts/slice-9.md, slice-10.md): messaging, calendar, platform delivery health.
const WHATSAPP: WhatsAppSettingsDto = {
  effectiveProvider: 'waha',
  number: {
    id: 'wn1',
    provider: 'waha',
    phoneMasked: '+9230*****67',
    status: 'down',
    lastHealthyAt: '2026-10-03T04:00:00.000Z',
    lastErrorCode: 'logged_out',
    inboundIgnoredCount: 3,
    pairedAt: STAMP,
    createdAt: STAMP,
  },
};
const USAGE: MessagingUsageDto = {
  months: [
    { yearMonth: '2026-10', byChannel: [{ channel: 'sms', count: 120 }, { channel: 'whatsapp', count: 2400 }, { channel: 'push', count: 310 }, { channel: 'email', count: 4 }] },
    { yearMonth: '2026-09', byChannel: [{ channel: 'sms', count: 480 }, { channel: 'whatsapp', count: 9100 }, { channel: 'push', count: 1200 }, { channel: 'email', count: 12 }] },
  ],
  cap: 500,
  remaining: 380,
};
const holiday = (id: string, name: string, startsOn: string, endsOn: string, status: HolidayDto['status']): HolidayDto => ({
  id,
  startsOn,
  endsOn,
  name,
  description: null,
  kind: 'school',
  appliesToStaff: true,
  status,
  publishedAt: status === 'draft' ? null : STAMP,
  publishedBy: status === 'draft' ? null : 'u-principal',
  publishedByName: status === 'draft' ? null : 'Amina Principal',
  cancelledAt: null,
  cancelledBy: null,
  cancelledByName: null,
  cancelReason: null,
  announcementId: null,
  createdAt: STAMP,
  updatedAt: STAMP,
});
const HOLIDAYS = [
  holiday('h1', 'Iqbal Day', '2026-11-09', '2026-11-09', 'published'),
  holiday('h2', 'Winter vacation for all classes and staff', '2026-12-22', '2027-01-04', 'draft'),
];
const TEACHING_DAYS: TeachingDaysDto = {
  dateFrom: '2026-10-01',
  dateTo: '2026-10-31',
  teachingDays: 26,
  weeklyOffDays: [0],
  holidays: [],
};
// Wave E (contracts/slice-11.md, slice-12.md, slice-13.md): attendance, staff attendance, diary.
const SECTION_DAYS: SectionDayDto[] = [
  {
    sectionId: 'sec-a',
    sectionName: 'A',
    classId: 'c5',
    className: 'Class 5',
    academicYearId: 'y1',
    date: '2026-10-04',
    mode: 'daily',
    rosterCount: 38,
    registersExpected: 1,
    registersRecorded: 0,
    recorded: false,
    submittedBy: null,
    submittedByName: null,
    submittedAt: null,
    classTeacherName: 'Ayesha Malik',
    classTeacherStaffId: 'st-ayesha',
    coverStaffName: 'Muhammad Bilal Ahmed Qureshi',
    coverStaffIds: ['st-bilal'],
    declaredHolidayAfter: false,
  },
];
const REGISTER_VIEW: RegisterViewDto = {
  section: { id: 'sec-a', name: 'A', classId: 'c5', className: 'Class 5', academicYearId: 'y1', attendanceMode: 'daily' },
  date: '2026-10-04',
  period: 1,
  periodsPerDay: 8,
  teachingDay: true,
  register: null,
  roster: ['Ali Khan', 'Fatima Zahra Siddiqui', 'Muhammad Abdullah bin Tariq Chaudhry'].map((name, i) => ({
    enrolmentId: `e${i + 1}`,
    studentId: `st-s${i + 1}`,
    studentFullName: name,
    rollNo: i + 1,
    onRoster: true,
    mark: null,
    alert: null,
  })),
  canSubmit: true,
  amendable: true,
  callerRole: 'all',
};
const STAFF_DAY: StaffDayDto[] = STAFF.map((s) => ({
  staffId: s.id,
  fullName: s.fullName,
  designation: s.designation,
  staffStatus: s.status,
  mark: null,
}));
const MY_ATTENDANCE: MyStaffAttendanceDto = {
  staffId: 'st1',
  dateFrom: '2026-10-01',
  dateTo: '2026-10-31',
  workingDays: 26,
  present: 3,
  absent: 0,
  late: 0,
  onLeave: 0,
  unrecorded: 23,
  days: [],
};
const DIARY: DiaryEntryDto[] = [
  {
    id: 'd1',
    sectionId: 'sec-a',
    classId: 'c5',
    academicYearId: 'y1',
    date: '2026-10-04',
    subjectId: 'sub-m',
    subjectName: 'Mathematics',
    authorStaffId: 'st1',
    authorName: 'Ayesha Malik',
    topic: 'Fractions: adding and subtracting fractions with unlike denominators, worked examples',
    assignment: 'Exercise 4.2, questions 1 to 10, in the homework copy',
    learningOutcome: null,
    dueOn: '2026-10-06',
    hasAttachment: true,
    attachmentMime: 'image/jpeg',
    attachmentSizeBytes: 182000,
    editWindowEndsOn: '2026-10-07',
    createdAt: STAMP,
    updatedAt: STAMP,
  },
];
const announcementRow = (id: string, extra: Partial<AnnouncementDto>): AnnouncementDto => ({
  id,
  title: 'Quarterly examinations begin on Monday 12 October for every class from Nursery to Class 10',
  body: 'The date sheet is attached. Please make sure your child arrives by 7:45 and brings two pencils, an eraser and a geometry box.',
  category: 'exam',
  priority: 'urgent',
  messageType: 'announcement_urgent',
  status: 'sent',
  audiences: [
    { kind: 'class', targetId: 'c9', targetName: 'Class 9 (Science)', roles: ['parents'] },
    { kind: 'section', targetId: 'sec-c', targetName: 'Class 5 Rose', roles: [] },
    { kind: 'guardian', targetId: 'g1', targetName: 'Muhammad Abdullah bin Tariq Chaudhry', roles: [] },
  ],
  scheduledAt: null,
  expiresOn: '2026-10-12',
  hasAttachment: true,
  attachmentMime: 'application/pdf',
  attachmentSizeBytes: 240000,
  holidayId: null,
  createdBy: 'u-principal',
  createdByName: 'Amina Principal',
  createdAt: STAMP,
  updatedAt: STAMP,
  sentAt: STAMP,
  cancelledAt: null,
  cancelledBy: null,
  cancelReason: null,
  recipientCount: 1240,
  sendFailedAt: null,
  smsSegments: 2,
  ...extra,
});
const ANNOUNCEMENTS = [
  announcementRow('a1', {}),
  announcementRow('a2', { status: 'draft', sentAt: null, recipientCount: 0, title: 'Sports day kit', priority: 'normal', smsSegments: null }),
];
const DELIVERY: DeliverySummaryDto = {
  announcementId: 'a1',
  status: 'sent',
  recipients: { total: 1240, guardians: 1100, staff: 90, students: 50 },
  messages: { queued: 0, sending: 0, sent: 300, delivered: 900, failed: 20, suppressed: 20 },
  byChannel: [
    { channel: 'push', accepted: 140, delivered: 120, failed: 0, suppressed: 0 },
    { channel: 'whatsapp', accepted: 1100, delivered: 1050, failed: 12, suppressed: 8 },
    { channel: 'sms', accepted: 400, delivered: 380, failed: 8, suppressed: 12 },
    { channel: 'email', accepted: 0, delivered: 0, failed: 0, suppressed: 0 },
  ],
  suppressions: [
    { reason: 'duplicate_phone', count: 12 },
    { reason: 'no_channel', count: 8 },
  ],
  smsSegmentsPerMessage: 2,
  smsUnitsReserved: 800,
  computedAt: STAMP,
};
const PREVIEW: AudiencePreviewDto = {
  recipients: { total: 1240, guardians: 1100, staff: 90, students: 50 },
  byAudience: ANNOUNCEMENTS[1].audiences.map((a) => ({ ...a, persons: 400 })),
  sms: { allowed: true, legs: 400, segments: 2, units: 800, remaining: 4200, cap: 5000 },
  warnings: ['whatsapp_not_connected'],
  computedAt: STAMP,
};
const INBOX: InboxItemDto[] = [
  {
    id: 'm1',
    kind: 'announcement',
    messageType: 'announcement_urgent',
    subjectType: 'announcement',
    subjectId: 'a1',
    title: ANNOUNCEMENTS[0].title,
    body: ANNOUNCEMENTS[0].body,
    category: 'exam',
    priority: 'urgent',
    sentAt: STAMP,
    expiresOn: '2026-10-12',
    hasAttachment: true,
    attachmentMime: 'application/pdf',
    announcementId: 'a1',
    viaStudents: [
      { studentId: 'st-s1', fullName: 'Ali Khan' },
      { studentId: 'st-s2', fullName: 'Fatima Zahra Siddiqui' },
    ],
  },
];
const PLATFORM_SETTINGS: PlatformSettingsDto = { defaultWhatsappProvider: 'waha', defaultSmsProvider: 'sendpk', enabledWhatsappProviders: ['waha', 'cloud_api'], updatedAt: STAMP };
const healthRow = (schoolId: string, name: string, shortCode: string): PlatformDeliveryHealthDto => ({
  schoolId,
  name,
  shortCode,
  schoolStatus: 'active',
  whatsapp: { status: 'down', lastHealthyAt: '2026-10-03T04:00:00.000Z', lastErrorCode: 'logged_out' },
  today: [
    { channel: 'whatsapp', accepted: 1200, delivered: 1100, failed: 14, suppressed: 0 },
    { channel: 'sms', accepted: 80, delivered: 75, failed: 2, suppressed: 9 },
    { channel: 'push', accepted: 300, delivered: 0, failed: 0, suppressed: 0 },
    { channel: 'email', accepted: 0, delivered: 0, failed: 0, suppressed: 0 },
  ],
  yesterday: [
    { channel: 'whatsapp', accepted: 900, delivered: 890, failed: 3, suppressed: 0 },
    { channel: 'sms', accepted: 40, delivered: 40, failed: 0, suppressed: 0 },
    { channel: 'push', accepted: 0, delivered: 0, failed: 0, suppressed: 0 },
    { channel: 'email', accepted: 1, delivered: 1, failed: 0, suppressed: 0 },
  ],
  sms: { used: 480, cap: 500 },
  computedAt: '2026-10-04T05:00:00.000Z',
});
const HEALTH = [
  healthRow('s1', 'Green Valley Higher Secondary School', 'greenvalley'),
  healthRow('s3', 'The City Grammar School, Model Town Campus', 'citygram'),
];

const FULL_PLATFORM_ME: PlatformMe = {
  id: '1',
  email: 'admin@example.test',
  sessionStage: 'full',
  totpEnrolled: true,
  mustChangePassword: false,
  sessionExpiresAt: '2026-10-02T20:00:00.000Z',
};
const school = (id: string, name: string, shortCode: string, status: School['status']): School => ({
  id,
  name,
  shortCode,
  status,
  timezone: 'Asia/Karachi',
  createdAt: STAMP,
  updatedAt: STAMP,
  // contracts/slice-9.md §6.1: the messaging knobs on the school record.
  smsMonthlyCap: 500,
  whatsappProvider: 'platform_default',
  smsProvider: 'platform_default',
});
const SCHOOLS = [
  school('s1', 'Green Valley Higher Secondary School', 'greenvalley', 'active'),
  school('s2', 'Iqbal Academy', 'iqbal', 'trial'),
  school('s3', 'The City Grammar School, Model Town Campus', 'citygram', 'suspended'),
];

const page1 = <T,>(data: T[]) => ({ data, page: 1, limit: 25, total: data.length });
const errorBody = (code: ApiErrorEnvelope['error']['code'], message: string): ApiErrorEnvelope => ({
  error: { code, message, details: null, requestId: 'req-test' },
});

type Session = { school: MeDto | null; platform: PlatformMe | null };

/** Answers every GET a screen makes on first render; anything else is recorded as unmocked. */
async function mockApi(page: Page, session: Session) {
  const unmocked: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const method = request.method();
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.startsWith('/platform/')) {
      const p = path.replace('/platform', '');
      if (!session.platform) return json(401, errorBody('AUTH_REQUIRED', 'Sign in to continue.'));
      if (method === 'GET' && p === '/me') return json(200, session.platform);
      if (method === 'POST' && p === '/auth/totp/enrol') {
        return json(200, {
          otpauthUri: 'otpauth://totp/ASMS%20Platform:admin@example.test?secret=JBSWY3DPEHPK3PXP&issuer=ASMS%20Platform',
          secret: 'JBSWY3DPEHPK3PXP',
        });
      }
      if (method === 'GET' && p === '/schools') return json(200, page1(SCHOOLS));
      if (method === 'GET' && p === '/settings') return json(200, PLATFORM_SETTINGS);
      if (method === 'GET' && p === '/messaging/health') return json(200, page1(HEALTH));
      const detail = p.match(/^\/schools\/([^/]+)$/);
      const found = detail && SCHOOLS.find((s) => s.id === detail[1]);
      if (method === 'GET' && found) return json(200, found);
      unmocked.push(`${method} ${path}`);
      return json(500, errorBody('INTERNAL_ERROR', `Unmocked ${method} ${path}`));
    }

    if (!session.school) return json(401, errorBody('AUTH_REQUIRED', 'Sign in to continue.'));
    // The composer previews its audience as it opens: a POST that writes nothing (slice-14 §4.6).
    if (method === 'POST' && path === '/announcements/preview-audience') return json(200, PREVIEW);
    if (method !== 'GET') {
      unmocked.push(`${method} ${path}`);
      return json(500, errorBody('INTERNAL_ERROR', `Unmocked ${method} ${path}`));
    }
    const lists: Record<string, unknown[]> = {
      '/academic-years': YEARS,
      '/classes': CLASSES,
      '/subjects': SUBJECTS,
      '/staff': STAFF,
      '/users': USERS,
      '/guardians': GUARDIANS,
      '/students': STUDENTS,
      '/custom-roles': CUSTOM_ROLES,
      '/holidays': HOLIDAYS,
      '/classes/c5/sections': SECTIONS,
      '/classes/c6/sections': [],
      '/classes/c9/sections': [],
      '/staff/st1/teacher-assignments': ASSIGNMENTS,
      '/users/u7/roles': [],
      '/guardians/g1/students': GUARDIAN_STUDENTS,
      '/students/st-s1/guardian-links': LINKS,
      '/students/st-s1/enrolments': ENROLMENTS,
      '/students/st-s1/status-changes': [],
      '/students/st-s1/documents': [],
      '/students/st-s3/guardian-links': [],
      '/attendance-registers': SECTION_DAYS,
      '/attendance-reports/daily-summary': [],
      '/attendance-reports/absentees': [],
      '/staff-attendance': STAFF_DAY,
      '/sections/sec-a/diary-entries': DIARY,
      '/announcements': ANNOUNCEMENTS,
      '/me/inbox': INBOX,
      // Slice 18: fee setup and the settings page's payment accounts.
      '/fee-heads': [],
      '/fee-structures': [],
      '/payment-accounts': [],
    };
    if (path === '/me') return json(200, session.school);
    if (path === '/school/settings') return json(200, SETTINGS);
    if (path === '/messaging/whatsapp') return json(200, WHATSAPP);
    if (path === '/messaging/usage') return json(200, USAGE);
    if (path === '/calendar/teaching-days') return json(200, TEACHING_DAYS);
    if (lists[path]) return json(200, page1(lists[path]));
    const one: Record<string, unknown> = {
      '/classes/c5': CLASSES[0],
      '/staff/st1': STAFF[0],
      '/guardians/g1': GUARDIANS[0],
      '/students/st-s1': STUDENTS[0],
      '/students/st-s3': STUDENTS[2],
      '/custom-roles/cr1': CUSTOM_ROLES[0],
      '/sections/sec-a': SECTIONS[0],
      '/sections/sec-a/register': REGISTER_VIEW,
      '/me/staff/attendance': MY_ATTENDANCE,
      '/announcements/a1': ANNOUNCEMENTS[0],
      '/announcements/a1/delivery': DELIVERY,
      '/announcements/a2': ANNOUNCEMENTS[1],
      '/me/inbox/m1': INBOX[0],
    };
    if (one[path]) return json(200, one[path]);
    unmocked.push(`${method} ${path}`);
    return json(500, errorBody('INTERNAL_ERROR', `Unmocked ${method} ${path}`));
  });
  return unmocked;
}

type Screen = {
  path: string;
  /** The screen's main heading: the page h1 inside the shell, the card title on sign-in screens. */
  heading: string;
  session: 'none' | 'school' | 'platform' | 'platform-enrolment' | 'platform-must-change';
};

const SCREENS: Screen[] = [
  // School sign-in screens
  { path: '/login', heading: 'Sign in', session: 'none' },
  { path: '/forgot', heading: 'Reset your password', session: 'none' },
  { path: `/reset/greenvalley#token=${TOKEN}`, heading: 'Choose a new password', session: 'none' },
  { path: `/verify-email/greenvalley#token=${TOKEN}`, heading: 'Verify your email address', session: 'none' },
  // School console
  { path: '/academics/years', heading: 'Academic structure', session: 'school' },
  { path: '/academics/classes', heading: 'Academic structure', session: 'school' },
  { path: '/academics/classes/c5', heading: 'Academic structure', session: 'school' },
  { path: '/academics/subjects', heading: 'Academic structure', session: 'school' },
  { path: '/account', heading: 'Your account', session: 'school' },
  { path: '/users', heading: 'User accounts', session: 'school' },
  { path: '/settings', heading: 'School settings', session: 'school' },
  { path: '/settings/messaging', heading: 'Messaging', session: 'school' },
  { path: '/fees/heads', heading: 'Fees', session: 'school' },
  { path: '/fees/structures', heading: 'Fees', session: 'school' },
  { path: '/calendar', heading: 'Calendar', session: 'school' },
  { path: '/staff', heading: 'Staff', session: 'school' },
  { path: '/staff/new', heading: 'New staff member', session: 'school' },
  { path: '/staff/st1', heading: 'Ayesha Malik', session: 'school' },
  { path: '/guardians', heading: 'Guardians', session: 'school' },
  { path: '/guardians/new', heading: 'New guardian', session: 'school' },
  { path: '/guardians/g1', heading: 'Ahmed Khan', session: 'school' },
  { path: '/students', heading: 'Students', session: 'school' },
  { path: '/students/st-s1', heading: 'Ali Khan', session: 'school' },
  { path: '/students/st-s3/readmit', heading: 'Readmit Hina Ali', session: 'school' },
  { path: '/admissions/new', heading: 'New admission', session: 'school' },
  { path: '/custom-roles', heading: 'Custom roles', session: 'school' },
  { path: '/custom-roles/new', heading: 'New custom role', session: 'school' },
  { path: '/custom-roles/cr1', heading: 'Accounts clerk', session: 'school' },
  { path: '/attendance', heading: 'Attendance', session: 'school' },
  { path: '/attendance/register?section=sec-a', heading: 'Attendance register', session: 'school' },
  { path: '/attendance/summary', heading: 'Attendance', session: 'school' },
  { path: '/attendance/reports', heading: 'Attendance', session: 'school' },
  { path: '/staff-attendance', heading: 'Staff attendance', session: 'school' },
  { path: '/my-attendance', heading: 'My attendance', session: 'school' },
  { path: '/diary', heading: 'Diary', session: 'school' },
  { path: '/sections/sec-a/diary', heading: 'Class 5 A diary', session: 'school' },
  { path: '/announcements', heading: 'Announcements', session: 'school' },
  { path: '/announcements/new', heading: 'New announcement', session: 'school' },
  { path: '/announcements/a1', heading: ANNOUNCEMENTS[0].title, session: 'school' },
  { path: '/announcements/a2/edit', heading: 'Edit announcement', session: 'school' },
  { path: '/inbox', heading: 'Inbox', session: 'school' },
  { path: '/inbox/m1', heading: INBOX[0].title, session: 'school' },
  // Platform console
  { path: '/platform/login', heading: 'Platform sign in', session: 'none' },
  { path: '/platform/enrol', heading: 'Set up your authenticator', session: 'platform-enrolment' },
  { path: '/platform/change-password', heading: 'Change your password', session: 'platform-must-change' },
  { path: '/platform/schools', heading: 'Schools', session: 'platform' },
  { path: '/platform/schools/new', heading: 'New school', session: 'platform' },
  { path: '/platform/schools/s1', heading: 'Green Valley Higher Secondary School', session: 'platform' },
  { path: '/platform/messaging', heading: 'Delivery health', session: 'platform' },
  { path: '/platform/settings', heading: 'Platform settings', session: 'platform' },
];

function sessionFor(kind: Screen['session']): Session {
  switch (kind) {
    case 'none':
      return { school: null, platform: null };
    case 'school':
      return { school: PRINCIPAL_ME, platform: null };
    case 'platform':
      return { school: null, platform: FULL_PLATFORM_ME };
    case 'platform-enrolment':
      return { school: null, platform: { ...FULL_PLATFORM_ME, sessionStage: 'totp_enrolment', totpEnrolled: false } };
    case 'platform-must-change':
      return { school: null, platform: { ...FULL_PLATFORM_ME, mustChangePassword: true } };
  }
}

const exactly = (text: string) => new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);

test.use({ viewport: TABLET });

for (const screen of SCREENS) {
  test(`tablet 768px: ${screen.path.split('#')[0]} shows its heading and does not scroll sideways`, async ({ page }) => {
    const unmocked = await mockApi(page, sessionFor(screen.session));
    await page.goto(screen.path);
    const heading = page.locator('h1, [data-slot="card-title"]').filter({ hasText: exactly(screen.heading) });
    await expect(heading.first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    // The URL did not move away (a redirect would mean the session mock was wrong for the screen).
    expect(new URL(page.url()).pathname).toBe(screen.path.split(/[?#]/)[0]);
    expect(unmocked).toEqual([]);
    const widths = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(widths.scrollWidth, `${screen.path} is wider than the viewport`).toBeLessThanOrEqual(widths.innerWidth);
  });
}
