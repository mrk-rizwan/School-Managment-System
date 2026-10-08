import { ErrorCode } from '@asms/shared';
import { fireEvent, screen } from '@testing-library/react-native';
import type {
  ApprovalsDto,
  MeDto,
  ResultPreviewRowDto,
  ResultSheetDetailDto,
} from '../api/contracts';
import { queryClient } from '../api/query-client';
import { ApprovalsScreen } from '../approvals/ApprovalsScreen';
import { sheetYearOf } from '../marks/SectionAssessmentsScreen';
import { LANES, ONLINE_ONLY_ACTIONS } from '../outbox/lanes';
import { errorBody, resetDevice, type FakeApi } from '../test/fake-api';
import { meFixture } from '../test/fixtures';
import { eventually, renderSignedIn, setOnline } from '../test/screen';
import { ResultSheetScreen } from './ResultSheetScreen';
import { ownChildNote, rowLine, sheetFailure } from './results';

// Phase 4 slice 31 on the phone: the class teacher's sheet under Marks (preview, remarks, submit)
// and the principal's under Approvals (preview, approve, return). Online only, never the outbox.

const STAMP = '2026-10-06T05:00:00.000Z';
const SHEET_GET = 'GET /api/v1/result-sheets/rs1';

const row = (
  enrolmentId: string,
  fullName: string,
  extra: Partial<ResultPreviewRowDto> = {},
): ResultPreviewRowDto => ({
  enrolmentId,
  studentId: `st-${enrolmentId}`,
  fullName,
  admissionNo: `10${enrolmentId}`,
  rollNo: 1,
  totalObtained: 149,
  totalMax: 200,
  percentBp: 7450,
  grade: 'B',
  passed: true,
  failedSubjects: 0,
  position: 1,
  positionOf: 2,
  attendanceBp: 9230,
  remark: null,
  ownChildFlags: [],
  missing: 0,
  subjects: [],
  ...extra,
});

const SHEET: ResultSheetDetailDto = {
  id: 'rs1',
  academicYearId: 'y1',
  termId: 't1',
  termName: 'Mid-term',
  isFinal: false,
  classId: 'c5',
  className: 'Class 5',
  sectionName: 'A',
  sectionId: 'sec-a',
  version: 1,
  status: 'draft',
  submittedAt: null,
  submittedByName: null,
  submittedByMe: false,
  cover: false,
  decidedAt: null,
  decidedByName: null,
  selfApproved: false,
  returnReason: null,
  publishedAt: null,
  publishedByName: null,
  ownChildFlags: [],
  createdAt: STAMP,
  updatedAt: STAMP,
  source: 'preview',
  settings: {
    testWeight: 20,
    examWeight: 80,
    passPercent: 40,
    passRule: 'all_subjects',
    snapshot: false,
  },
  subjects: [],
  preview: [
    row('e1', 'Zara Khan'),
    row('e2', 'Ali Raza', {
      rollNo: 2,
      percentBp: 2700,
      grade: 'F',
      passed: false,
      position: 2,
      missing: 1,
    }),
  ],
  flags: {
    ownChild: [],
    cover: false,
    selfApproved: false,
    missing: [{ enrolmentId: 'e2', assessmentId: 'a3' }],
    missingCount: 1,
    examsNotSetUp: [],
  },
  canRemark: true,
  canSubmit: true,
  canDecide: false,
  canPublish: false,
};

const SUBMITTED: ResultSheetDetailDto = {
  ...SHEET,
  status: 'submitted',
  submittedAt: STAMP,
  submittedByName: 'Ayesha Malik',
  canRemark: false,
  canSubmit: false,
  canDecide: true,
  ownChildFlags: [{ userId: 'u9', role: 'mark_author', userName: 'Kamran Parent' }],
  flags: { ...SHEET.flags, missing: [], missingCount: 0 },
};

const principal = (): MeDto => meFixture({ capabilities: ['result.approve', 'result.publish'] });
const teacher = (): MeDto => meFixture({ capabilities: ['marks.enter'] });
const posts = (fake: FakeApi, path: string) =>
  fake.calls.filter((c) => c.method !== 'GET' && c.path === path);

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});
afterEach(() => queryClient.clear());

test('§0.30: every result-sheet action is online-only and none is an outbox lane', () => {
  const actions = [
    'open_result_sheet',
    'save_result_remarks',
    'submit_result_sheet',
    'approve_result_sheet',
    'return_result_sheet',
    'publish_result_sheet',
  ];
  expect(ONLINE_ONLY_ACTIONS).toEqual(expect.arrayContaining(actions));
  expect(Object.keys(LANES)).toEqual(expect.not.arrayContaining(actions));
});

test('the pure lines: a row, the own-child note, the refusals', () => {
  expect(rowLine(SHEET.preview[1]!)).toBe('27.00 % · F · 2 / 2 · fail · 1 missing');
  expect(ownChildNote(SUBMITTED)).toBe('Kamran Parent is a guardian of a student on this sheet.');
  expect(ownChildNote(SHEET)).toBeNull();
  expect(
    sheetYearOf(
      {
        assignments: [
          {
            ...meFixture().assignments[0]!,
            sectionId: 'sec-a',
            role: 'class_teacher',
            academicYearId: 'y9',
          },
        ],
      },
      'sec-a',
    ),
  ).toBe('y9');
  expect(sheetYearOf({ assignments: [] }, 'sec-a')).toBeNull();
});

test('offline: the sheet is not read and the screen says it needs a connection', async () => {
  setOnline(false);
  const { fake } = await renderSignedIn(<ResultSheetScreen id="rs1" secure />, teacher(), {
    [SHEET_GET]: () => ({ status: 200, body: SHEET }),
  });
  expect(await screen.findByText('Needs a connection')).toBeOnTheScreen();
  expect(fake.calls.filter((c) => c.path === '/api/v1/result-sheets/rs1')).toHaveLength(0);
});

test('the class teacher saves only the changed remarks, then submit is refused while a mark is missing', async () => {
  const { fake } = await renderSignedIn(<ResultSheetScreen id="rs1" secure />, teacher(), {
    [SHEET_GET]: () => ({ status: 200, body: SHEET }),
    'PATCH /api/v1/result-sheets/rs1': () => ({
      status: 200,
      body: { ...SHEET, updatedAt: '2026-10-06T06:00:00.000Z' },
    }),
    'POST /api/v1/result-sheets/rs1/submit': () => ({
      status: 409,
      body: errorBody(ErrorCode.MARKS_INCOMPLETE, 'Missing.', {
        missing: [{ enrolmentId: 'e2', assessmentId: 'a3' }],
      }),
    }),
  });
  expect(await screen.findByTestId('sheet.missing')).toHaveTextContent('1 mark is missing.');
  expect(screen.getByTestId('sheet.row.e2')).toHaveTextContent(/27.00 % · F/);
  fireEvent.changeText(screen.getByTestId('sheet.remark.e2'), 'Must revise English.');
  fireEvent.press(screen.getByTestId('sheet.saveRemarks'));
  await eventually(() =>
    expect(screen.getByTestId('sheet.message')).toHaveTextContent(/Remarks saved/),
  );
  expect(posts(fake, '/api/v1/result-sheets/rs1')[0]?.body).toEqual({
    remarks: [{ enrolmentId: 'e2', remark: 'Must revise English.' }],
  });
  fireEvent.press(screen.getByTestId('sheet.submit'));
  await eventually(() =>
    expect(screen.getByTestId('sheet.message')).toHaveTextContent(/Some marks are missing/),
  );
});

test('the final sheet: remarks are written (canRemark) and there is no Submit (canSubmit false)', async () => {
  const FINAL: ResultSheetDetailDto = {
    ...SHEET,
    termId: null,
    termName: null,
    canRemark: true,
    canSubmit: false,
  };
  const { fake } = await renderSignedIn(<ResultSheetScreen id="rs1" secure />, teacher(), {
    [SHEET_GET]: () => ({ status: 200, body: FINAL }),
    'PATCH /api/v1/result-sheets/rs1': () => ({
      status: 200,
      body: { ...FINAL, updatedAt: '2026-10-06T06:00:00.000Z' },
    }),
  });
  fireEvent.changeText(await screen.findByTestId('sheet.remark.e2'), 'A good year.');
  expect(screen.queryByTestId('sheet.submit')).toBeNull();
  fireEvent.press(screen.getByTestId('sheet.saveRemarks'));
  await eventually(() =>
    expect(screen.getByTestId('sheet.message')).toHaveTextContent(/Remarks saved/),
  );
  expect(posts(fake, '/api/v1/result-sheets/rs1')[0]?.body).toEqual({
    remarks: [{ enrolmentId: 'e2', remark: 'A good year.' }],
  });
});

test('the principal sees the own-child flag, returns with a reason, and approves', async () => {
  const { fake } = await renderSignedIn(<ResultSheetScreen id="rs1" secure />, principal(), {
    [SHEET_GET]: () => ({ status: 200, body: SUBMITTED }),
    'POST /api/v1/result-sheets/rs1/return': () => ({
      status: 200,
      body: {
        ...SHEET,
        status: 'returned',
        returnReason: 'Recheck English',
        canSubmit: false,
        updatedAt: '2026-10-06T07:00:00.000Z',
      },
    }),
  });
  expect(await screen.findByTestId('sheet.ownChild')).toHaveTextContent(
    /Kamran Parent is a guardian/,
  );
  expect(screen.getByTestId('sheet.status')).toHaveTextContent(
    /Waiting for approval · submitted by Ayesha Malik/,
  );
  fireEvent.press(screen.getByTestId('sheet.return'));
  fireEvent.changeText(await screen.findByTestId('reasonSheet.reason'), 'Recheck English');
  fireEvent.press(screen.getByTestId('reasonSheet.confirm'));
  await eventually(() =>
    expect(screen.getByTestId('sheet.returnReason')).toHaveTextContent(/Returned: Recheck English/),
  );
  expect(posts(fake, '/api/v1/result-sheets/rs1/return')[0]?.body).toEqual({
    reason: 'Recheck English',
  });
});

test('approve: published for a principal; a self-decision refusal is said plainly', async () => {
  let calls = 0;
  await renderSignedIn(<ResultSheetScreen id="rs1" secure />, principal(), {
    [SHEET_GET]: () => ({ status: 200, body: SUBMITTED }),
    'POST /api/v1/result-sheets/rs1/approve': () =>
      ++calls === 1
        ? {
            status: 409,
            body: errorBody(ErrorCode.SELF_ACTION_FORBIDDEN, 'Own sheet.', { reason: 'submitter' }),
          }
        : {
            status: 200,
            body: {
              ...SUBMITTED,
              status: 'published',
              source: 'stored',
              canDecide: false,
              updatedAt: '2026-10-06T08:00:00.000Z',
            },
          },
  });
  fireEvent.press(await screen.findByTestId('sheet.approve'));
  await eventually(() =>
    expect(screen.getByTestId('sheet.message')).toHaveTextContent(/another principal decides it/),
  );
  fireEvent.press(screen.getByTestId('sheet.approve'));
  await eventually(() => expect(screen.getByTestId('sheet.status')).toHaveTextContent(/Published/));
  expect(sheetFailure(new Error('x')).message).toBe('This could not be sent. Try again.');
});

test('Approvals lists the waiting result sheets with their flags', async () => {
  const body: ApprovalsDto = { results: { count: 1, items: [SUBMITTED] } };
  await renderSignedIn(<ApprovalsScreen secure />, principal(), {
    'GET /api/v1/me/approvals': () => ({ status: 200, body }),
  });
  expect(await screen.findByText('Result sheets · 1')).toBeOnTheScreen();
  expect(screen.getByTestId('approvals.result.rs1')).toHaveTextContent(
    /Class 5 A · Mid-term.*Submitted by Ayesha Malik.*Own child/,
  );
});
