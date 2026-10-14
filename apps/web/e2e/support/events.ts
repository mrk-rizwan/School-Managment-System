import type { PaymentDto } from '../../lib/api/school-payments-contract';
import type { EventDto, EventReportDto, EventRosterDto, EventRosterRowDto } from '../../lib/api/school-events-contract';

// Slice 38 fixtures (contracts/slice-38.md), shared by the events spec and the tablet check: a
// draft PTM for Class 5 A with a Rs 1,500 charge, and a published trip whose campaign is raised,
// with Ayesha Malik (st-t) on the collection duty. Times are Karachi (+05:00).

const STAMP = '2026-09-20T05:00:00.000Z';

export const EV_DRAFT: EventDto = {
  id: 'ev1',
  academicYearId: 'y1',
  academicYearName: '2026-27',
  type: 'ptm',
  title: 'Parent-teacher meeting',
  startsAt: '2026-11-14T04:00:00.000Z',
  endsAt: '2026-11-14T07:00:00.000Z',
  venue: 'School hall',
  details: 'Meet the class teacher.',
  status: 'draft',
  charge: { amount: 1500, dueOn: '2026-11-14' },
  sections: [{ sectionId: 'sec-a', sectionName: 'A', classId: 'c5', className: 'Class 5' }],
  duties: [],
  announcementId: null,
  cancelAnnouncementId: null,
  campaignId: null,
  campaignStatus: null,
  createdByName: 'Amina Principal',
  createdAt: STAMP,
  completedAt: null,
  cancelledAt: null,
  cancelReason: null,
  myDuties: [],
};

export const EV_DUTY = {
  id: 'du1',
  eventId: 'ev2',
  staffId: 'st-t',
  staffName: 'Ayesha Malik',
  duty: 'collection' as const,
  note: 'At the gate',
  createdAt: STAMP,
  endedAt: null,
  endReason: null,
};

export const EV_PUBLISHED: EventDto = {
  ...EV_DRAFT,
  id: 'ev2',
  type: 'trip',
  title: 'Museum trip',
  venue: 'Lahore Museum',
  details: null,
  status: 'published',
  charge: { amount: 1500, dueOn: '2026-11-10' },
  announcementId: 'a9',
  campaignId: 'cmp1',
  campaignStatus: 'generated',
  duties: [EV_DUTY],
  myDuties: ['collection'],
};

const row = (studentId: string, fullName: string, extra: Partial<EventRosterRowDto> = {}): EventRosterRowDto => ({
  studentId,
  enrolmentId: `en-${studentId}`,
  fullName,
  admissionNo: `ADM-${studentId}`,
  rollNo: 1,
  sectionId: 'sec-a',
  sectionName: 'A',
  className: 'Class 5',
  participation: null,
  recordedAt: null,
  charge: null,
  ...extra,
});

export const EV_ROSTER: EventRosterDto = {
  eventId: 'ev2',
  status: 'published',
  rows: [
    row('s1', 'Ali Khan', { charge: { chargeId: 'ch1', amount: 1500, outstanding: 1500, status: 'open' } }),
    row('s2', 'Sara Ahmed', {
      rollNo: 2,
      participation: 'attended',
      recordedAt: STAMP,
      charge: { chargeId: 'ch2', amount: 1500, outstanding: 0, status: 'settled' },
    }),
  ],
};

export const EV_PAYMENT = {
  id: 'p1',
  academicYearId: 'y1',
  advanceForStudentId: null,
  allocatedAmount: 1500,
  amount: 1500,
  claimId: null,
  duplicateOfPaymentId: null,
  handoverId: null,
  method: 'cash',
  payerGuardianId: 'g1',
  payerName: 'Ahmed Khan',
  possibleDuplicate: false,
  receipt: {
    id: 'r1',
    academicYearId: 'y1',
    amount: 1500,
    issuedAt: STAMP,
    issuedByName: 'Ayesha Malik',
    lines: [],
    paymentId: 'p1',
    receiptLabel: '2026-27/0042',
    receiptNo: 42,
    voidedAt: null,
  },
  receivedOn: '2026-10-06',
  recordedByName: 'Ayesha Malik',
  recordedByUserId: 'u-teacher',
  reference: null,
  reversals: [],
  status: 'verified',
  students: [{ studentId: 's2', fullName: 'Sara Ahmed', amount: 1500 }],
  unallocatedAmount: 0,
  verifiedAt: STAMP,
  voidedAt: null,
} satisfies PaymentDto;

export const EV_REPORT: EventReportDto = {
  eventId: 'ev2',
  title: 'Museum trip',
  status: 'published',
  participants: { roster: 2, attended: 1, absent: 0, excused: 0, unrecorded: 1 },
  collections: { chargeCount: 2, charged: 3000, collected: 1500, outstanding: 1500 },
  expenses: { count: 1, total: 4000 },
  net: -2500,
};
