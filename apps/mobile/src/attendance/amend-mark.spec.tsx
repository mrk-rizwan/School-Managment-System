import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import type { AttendanceMarkDto, RegisterViewDto } from '../api/contracts';
import { queryClient } from '../api/query-client';
import { listUnfinished } from '../db/outbox.repository';
import { errorBody, resetDevice, type Handler } from '../test/fake-api';
import { recorded, registerView, teacherMe, TODAY } from '../test/fixtures';
import { eventually, renderSignedIn, setOnline } from '../test/screen';
import { describeAmendError } from './AmendMarkSheet';
import { RegisterScreen } from './RegisterScreen';

// slice-16 §4.3 (attendance/amend-mark.spec.tsx): the online per-mark amend with fromStatus.

const GET = 'GET /api/v1/sections/12/register';
const AMEND = 'POST /api/v1/attendance-marks/m102/amend';
const CHANGES = 'GET /api/v1/attendance-marks/m102/changes';

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});
afterEach(() => queryClient.clear());

async function openAmend(view: RegisterViewDto, routes: Record<string, Handler>) {
  const result = await renderSignedIn(
    <RegisterScreen sectionId="12" date={TODAY} period={1} secure />,
    teacherMe(),
    {
      [GET]: () => ({ status: 200, body: view }),
      [CHANGES]: () => ({ status: 200, body: { data: [], page: 1, limit: 25, total: 0 } }),
      ...routes,
    },
  );
  await screen.findByTestId('register.roster');
  fireEvent(screen.getByTestId('register.chip.102'), 'longPress');
  const rowSheet = await screen.findByTestId('register.rowSheet');
  fireEvent.press(within(rowSheet).getByTestId('register.rowSheet.amend'));
  return { ...result, sheet: await screen.findByTestId('amendMark') };
}

function fill(sheet: ReturnType<typeof screen.getByTestId>, reason = 'Parent called: was ill') {
  fireEvent.press(within(sheet).getByTestId('amendMark.status.absent'));
  fireEvent.changeText(within(sheet).getByTestId('amendMark.reason'), reason);
  fireEvent.press(within(sheet).getByTestId('amendMark.submit'));
}

test('200: sent with fromStatus, never enqueued; the row updates from the DTO', async () => {
  const view = recorded(registerView());
  const amended: AttendanceMarkDto = { ...view.roster[1]!.mark!, status: 'absent', amended: true };
  const { fake, sheet } = await openAmend(view, {
    [AMEND]: () => {
      // The server now holds the amended mark: the refetch after the amend agrees.
      view.roster[1] = { ...view.roster[1]!, mark: amended };
      return { status: 200, body: amended };
    },
  });
  fill(sheet);
  await eventually(() => expect(fake.calls.some((c) => c.path.endsWith('/amend'))).toBe(true));
  await eventually(() => expect(screen.queryByTestId('amendMark')).toBeNull());
  const call = fake.calls.find((c) => c.path.endsWith('/amend'))!;
  expect(call.body).toEqual({
    fromStatus: 'present',
    status: 'absent',
    reason: 'Parent called: was ill',
  });
  expect(await listUnfinished()).toEqual([]);
  await eventually(() =>
    expect(screen.getByTestId('register.chip.102').props.accessibilityLabel).toBe('Absent'),
  );
});

test('a reason is required (3–500)', async () => {
  const { fake, sheet } = await openAmend(recorded(registerView()), {});
  fill(sheet, 'no');
  expect(within(sheet).getByTestId('amendMark.reason.error')).toBeOnTheScreen();
  expect(fake.calls.filter((c) => c.path.endsWith('/amend'))).toHaveLength(0);
});

test('409 STALE_STATUS: the colleague’s status is named, the register reloads, the sheet stays with the new fromStatus', async () => {
  let calls = 0;
  const view = recorded(registerView());
  const { fake, sheet } = await openAmend(view, {
    [AMEND]: () => {
      calls += 1;
      return calls === 1
        ? { status: 409, body: errorBody('STALE_STATUS', 'Changed', { currentStatus: 'late' }) }
        : { status: 200, body: { ...view.roster[1]!.mark!, status: 'absent', amended: true } };
    },
  });
  fill(sheet);
  expect(await within(sheet).findByTestId('amendMark.message')).toHaveTextContent(
    'This mark was changed by a colleague to late. Reload and amend again.',
  );
  expect(screen.getByTestId('amendMark')).toBeOnTheScreen();
  const registerReads = fake.calls.filter(
    (c) => c.method === 'GET' && c.path.endsWith('/register'),
  );
  await waitFor(() => expect(registerReads.length).toBeGreaterThanOrEqual(1));
  fireEvent.press(within(screen.getByTestId('amendMark')).getByTestId('amendMark.submit'));
  await waitFor(() => expect(calls).toBe(2));
  expect(fake.calls.filter((c) => c.path.endsWith('/amend'))[1]!.body).toMatchObject({
    fromStatus: 'late',
  });
});

test.each([
  ['ATTENDANCE_LOCKED', 409],
  ['NOT_A_TEACHING_DAY', 409],
])('%s: the server message, and the sheet closes', async (code, status) => {
  const { sheet, fake } = await openAmend(recorded(registerView()), {
    [AMEND]: () => ({ status, body: errorBody(code, 'The window closed on 1 Oct.') }),
  });
  fill(sheet);
  await eventually(() => expect(fake.calls.some((c) => c.path.endsWith('/amend'))).toBe(true));
  await eventually(() => expect(screen.queryByTestId('amendMark')).toBeNull());
});

test('the outcome table in words', () => {
  const { ApiError } = jest.requireActual<typeof import('@asms/shared')>('@asms/shared');
  const err = (status: number, code: string, details: unknown = null) =>
    new ApiError(status, code as never, 'Server says no.', details, null);
  expect(describeAmendError(err(403, 'PERMISSION_DENIED'))).toEqual({
    kind: 'denied',
    message: 'You cannot amend this mark. Ask the principal.',
  });
  expect(
    describeAmendError(
      err(422, 'VALIDATION_FAILED', {
        fields: [{ path: 'arrivedAt', code: 'x', message: 'Bad time' }],
      }),
    ),
  ).toMatchObject({ kind: 'invalid', fields: { arrivedAt: 'Bad time' } });
  expect(describeAmendError(new TypeError('Network request failed'))).toEqual({
    kind: 'network',
    message: 'No connection. Amending needs a connection.',
  });
});

test('offline: the action is disabled with "Needs a connection" — never queued', async () => {
  const view = recorded(registerView());
  await renderSignedIn(
    <RegisterScreen sectionId="12" date={TODAY} period={1} secure />,
    teacherMe(),
    {
      [GET]: () => ({ status: 200, body: view }),
    },
  );
  await screen.findByTestId('register.roster');
  setOnline(false);
  fireEvent(screen.getByTestId('register.chip.102'), 'longPress');
  const rowSheet = await screen.findByTestId('register.rowSheet');
  expect(within(rowSheet).getByTestId('register.rowSheet.amend')).toBeDisabled();
  expect(within(rowSheet).getByText('Needs a connection')).toBeOnTheScreen();
  expect(await listUnfinished()).toEqual([]);
});
