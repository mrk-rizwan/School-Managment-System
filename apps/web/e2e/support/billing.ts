// Fixtures for the platform billing screens and the school's billing card (contracts/slice-26.md),
// shared by platform-billing.spec.ts and the tablet sweep in responsive.spec.ts.
import type {
  InvoiceDto,
  PlanDto,
  SchoolBillingDto,
} from '../../lib/api/platform-billing-contract';
import type { BillingStatusDto } from '../../lib/api/school-billing-contract';

const STAMP = '2026-10-01T04:00:00.000Z';

export const PLANS: PlanDto[] = [
  {
    id: 'p1',
    name: 'Small school',
    minStudents: 0,
    maxStudents: 300,
    monthlyPrice: 8000,
    smsAllowance: 1000,
    status: 'active',
    archivedAt: null,
    createdAt: STAMP,
    updatedAt: STAMP,
  },
  {
    id: 'p2',
    name: 'Large school',
    minStudents: 301,
    maxStudents: null,
    monthlyPrice: 15000,
    smsAllowance: 3000,
    status: 'active',
    archivedAt: null,
    createdAt: STAMP,
    updatedAt: STAMP,
  },
];

export const invoice = (over: Partial<InvoiceDto> = {}): InvoiceDto => ({
  id: 'i1',
  invoiceNo: 'INV-2026-00012',
  schoolId: 's1',
  schoolName: 'Green Valley Higher Secondary School',
  yearMonth: '2026-10',
  planName: 'Small school',
  studentCount: 245,
  amount: 8000,
  dueOn: '2026-10-10',
  status: 'issued',
  issuedAt: STAMP,
  overdueAt: null,
  suspensionEligibleAt: null,
  paidAt: null,
  voidedAt: null,
  ...over,
});

export const INVOICES: InvoiceDto[] = [
  invoice(),
  invoice({
    id: 'i2',
    invoiceNo: 'INV-2026-00007',
    schoolId: 's3',
    schoolName: 'The City Grammar School, Model Town Campus',
    yearMonth: '2026-09',
    planName: 'Large school',
    studentCount: 812,
    amount: 15000,
    dueOn: '2026-09-10',
    overdueAt: '2026-09-11T23:00:00.000Z',
    suspensionEligibleAt: '2026-09-26T23:00:00.000Z',
  }),
];

export const SCHOOL_BILLING: SchoolBillingDto = {
  subscription: {
    id: 'sub1',
    schoolId: 's1',
    planId: 'p1',
    planName: 'Small school',
    startedOn: '2026-10-01',
    endedOn: null,
    pinned: false,
    assignedByPlatform: false,
    reason: null,
    createdAt: STAMP,
  },
  metrics: { day: '2026-10-05', activeStudents: 245 },
  invoices: [invoice()],
  smsCap: { value: 1500, overridden: true },
  terminatedAt: null,
  retentionEndsOn: null,
};

export const BILLING_STATUS: BillingStatusDto = {
  plan: { name: 'Small school', smsAllowance: 1000 },
  currentInvoice: { invoiceNo: 'INV-2026-00012', yearMonth: '2026-10', amount: 8000, dueOn: '2026-10-10', status: 'issued' },
  overdue: false,
  suspensionEligibleAt: null,
};
