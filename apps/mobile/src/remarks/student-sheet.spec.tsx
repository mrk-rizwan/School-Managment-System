import { fireEvent, screen, within } from '@testing-library/react-native';
import { preventScreenCaptureAsync } from 'expo-screen-capture';
import type { RemarkDto } from '../api/contracts';
import { queryClient } from '../api/query-client';
import { listByState } from '../db/outbox.repository';
import { errorBody, resetDevice, type Handler } from '../test/fake-api';
import { registerView, teacherMe, TODAY } from '../test/fixtures';
import { eventually, renderSignedIn, setOnline, settleOutbox } from '../test/screen';
import { StudentSheetScreen } from './StudentSheetScreen';
import { StudentsScreen } from './StudentsScreen';

// slice-16 §4.6 (remarks/student-sheet.spec.tsx, remarks/compose.spec.tsx): a student's remarks
// for staff, and a new remark saved on the device.

const ROSTER = 'GET /api/v1/sections/12/register';
const REMARKS = 'GET /api/v1/students/502/remarks';
const CREATE = 'POST /api/v1/students/502/remarks';

function remark(patch: Partial<RemarkDto> = {}): RemarkDto {
  return {
    authorName: 'Nadia Teacher',
    authorStaffId: '9',
    category: 'behaviour',
    correctionReason: null,
    createdAt: '2026-10-03T05:00:00.000Z',
    date: TODAY,
    enrolmentId: '102',
    id: '77',
    studentId: '502',
    subjectId: null,
    subjectName: null,
    supersededAt: null,
    supersededById: null,
    supersedesId: null,
    text: 'Helped a classmate',
    visibility: 'internal',
    ...patch,
  };
}

const routes = (extra: Record<string, Handler> = {}) => ({
  [ROSTER]: () => ({ status: 200, body: registerView() }),
  [REMARKS]: () => ({ status: 200, body: { data: [remark()], page: 1, limit: 25, total: 1 } }),
  ...extra,
});

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});
afterEach(() => queryClient.clear());

async function mount(extra: Record<string, Handler> = {}) {
  const result = await renderSignedIn(
    <StudentSheetScreen sectionId="12" studentId="502" secure />,
    teacherMe(),
    routes(extra),
  );
  await screen.findByTestId('student.remark.77');
  return result;
}

test('the students list is the cached roster, secure', async () => {
  await renderSignedIn(<StudentsScreen sectionId="12" secure />, teacherMe(), routes());
  expect(await screen.findByTestId('students.row.502')).toHaveTextContent(/Sara Khan.*Roll 2/);
  expect(preventScreenCaptureAsync).toHaveBeenCalled();
});

test('name and roll from the roster; staff see every visibility, "Staff only" for internal', async () => {
  const { fake } = await mount();
  expect(screen.getByText('Sara Khan')).toBeOnTheScreen();
  expect(screen.getByTestId('student.remark.77')).toHaveTextContent(/Behaviour.*Staff only/);
  expect(
    fake.calls.find((c) => c.path === '/api/v1/students/502/remarks')!.query.get('limit'),
  ).toBe('25');
  expect(preventScreenCaptureAsync).toHaveBeenCalled();
});

test('a new remark: "School default" leaves visibility out; saved on the device with the key as the outbox id', async () => {
  const { fake } = await mount({ [CREATE]: () => ({ status: 201, body: remark({ id: '78' }) }) });
  setOnline(false);
  fireEvent.press(screen.getByTestId('student.newRemark'));
  const form = await screen.findByTestId('remarkForm');
  fireEvent.press(within(form).getByTestId('remarkForm.category.homework'));
  fireEvent.changeText(within(form).getByTestId('remarkForm.text'), 'Homework done well');
  fireEvent.press(within(form).getByTestId('remarkForm.save'));
  await eventually(async () => expect(await listByState('pending')).toHaveLength(1));
  const [item] = await listByState('pending');
  expect(JSON.parse(item!.body)).toEqual({
    date: TODAY,
    category: 'homework',
    text: 'Homework done well',
  });
  await eventually(() =>
    expect(screen.getByTestId('student.localRemarks')).toHaveTextContent(/Saved on device/),
  );
  setOnline(true);
  await settleOutbox();
  expect(fake.calls.find((c) => c.method === 'POST')!.headers.get('Idempotency-Key')).toBe(
    item!.id,
  );
});

test('an identity number in the text is refused before saving', async () => {
  await mount();
  fireEvent.press(screen.getByTestId('student.newRemark'));
  const form = await screen.findByTestId('remarkForm');
  fireEvent.changeText(within(form).getByTestId('remarkForm.text'), 'Father 35202-1234567-1 came');
  fireEvent.press(within(form).getByTestId('remarkForm.save'));
  expect(within(form).getByTestId('remarkForm.text.error')).toHaveTextContent(
    'Do not type an identity number or a phone number here.',
  );
  expect(await listByState('pending')).toEqual([]);
});

test('a refused remark: STUDENT_NOT_ACTIVE is shown with discard; a 422 offers "Edit and resend" (a new key)', async () => {
  let reply: Handler = () => ({
    status: 409,
    body: errorBody('STUDENT_NOT_ACTIVE', 'The student has left.'),
  });
  await mount({ [CREATE]: (r) => reply(r) });
  fireEvent.press(screen.getByTestId('student.newRemark'));
  let form = await screen.findByTestId('remarkForm');
  fireEvent.changeText(within(form).getByTestId('remarkForm.text'), 'Good');
  fireEvent.press(within(form).getByTestId('remarkForm.save'));
  await settleOutbox();
  await eventually(() =>
    expect(screen.getByTestId('student.localRemarks')).toHaveTextContent(
      /Not saved: The student has left./,
    ),
  );
  const first = (await listByState('failed'))[0]!;
  expect(screen.getByTestId(`student.local.${first.domainId}.discard`)).toBeOnTheScreen();
  expect(screen.queryByTestId(`student.local.${first.domainId}.edit`)).toBeNull();

  reply = () => ({
    status: 422,
    body: errorBody('VALIDATION_FAILED', 'No enrolment on that date.'),
  });
  fireEvent.press(screen.getByTestId('student.newRemark'));
  form = await screen.findByTestId('remarkForm');
  fireEvent.changeText(within(form).getByTestId('remarkForm.text'), 'Second try');
  fireEvent.press(within(form).getByTestId('remarkForm.save'));
  await settleOutbox();
  const second = (await listByState('failed')).find((i) => i.id !== first.id)!;
  const edit = await screen.findByTestId(`student.local.${second.domainId}.edit`);
  setOnline(false);
  fireEvent.press(edit);
  form = await screen.findByTestId('remarkForm');
  expect(within(form).getByTestId('remarkForm.text').props.value).toBe('Second try');
  fireEvent.changeText(within(form).getByTestId('remarkForm.text'), 'Second try, corrected');
  fireEvent.press(within(form).getByTestId('remarkForm.save'));
  await eventually(async () => expect(await listByState('pending')).toHaveLength(1));
  const [resent] = await listByState('pending');
  expect(resent!.id).not.toBe(second.id);
  expect((await listByState('failed')).map((i) => i.id)).toEqual([first.id]);
});
