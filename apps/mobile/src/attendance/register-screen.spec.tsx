import { amendmentLines, nextStatus } from './register-model';
import { retainedDetails } from '../outbox/outcome';
import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { preventScreenCaptureAsync } from 'expo-screen-capture';
import type { RegisterSubmitResultDto, RegisterViewDto } from '../api/contracts';
import { queryClient } from '../api/query-client';
import { getDb } from '../db/database';
import { listByState } from '../db/outbox.repository';
import { readRegister } from '../db/local.repository';
import { logText } from '../platform/log';
import { errorBody, resetDevice, type Handler } from '../test/fake-api';
import { recorded, registerView, teacherMe, TODAY } from '../test/fixtures';
import { IDENTITY_PATTERN, PHONE_PATTERN } from '../test/patterns';
import { eventually, renderSignedIn, setOnline, settleOutbox } from '../test/screen';
import { RegisterScreen } from './RegisterScreen';

// slice-16 §4.2, §15.1 (attendance/register-screen.spec.tsx): the real screen, session, SQLite,
// outbox worker and client against the fake API.

const GET = 'GET /api/v1/sections/12/register';
const SUBMIT = 'POST /api/v1/sections/12/submit-register';

function submitResult(
  view: RegisterViewDto,
  body: { marks: { status: string }[] },
): RegisterSubmitResultDto {
  const r = recorded(view);
  const count = (s: string) => body.marks.filter((m) => m.status === s).length;
  return {
    alerts: {
      absenceBackdated: 0,
      absencePending: 0,
      cancelled: 0,
      corrections: 0,
      lateAdvicePending: 0,
    },
    created: true,
    marks: [],
    register: r.register!,
    summary: {
      roster: view.roster.length,
      marked: body.marks.length,
      present: count('present'),
      absent: count('absent'),
      late: count('late'),
      onLeave: count('on_leave'),
    },
  };
}

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});

afterEach(() => queryClient.clear());

async function mount(view: RegisterViewDto, routes: Record<string, Handler> = {}) {
  const result = await renderSignedIn(
    <RegisterScreen sectionId="12" date={TODAY} period={1} secure />,
    teacherMe(),
    {
      [GET]: () => ({ status: 200, body: view }),
      ...routes,
    },
  );
  await screen.findByTestId('register.roster');
  return result;
}

const chip = (enrolmentId: string) => screen.getByTestId(`register.chip.${enrolmentId}`);
const word = (enrolmentId: string) => chip(enrolmentId).props.accessibilityLabel as string;

test('a fresh register is pre-filled present; a tap cycles present → absent → late → on leave → present', async () => {
  await mount(registerView());
  expect(['101', '102', '103'].map(word)).toEqual(['Present', 'Present', 'Present']);
  expect(screen.getByTestId('register.counts')).toHaveTextContent('P 3 · A 0 · L 0 · O 0');
  const seen: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    fireEvent.press(chip('101'));
    seen.push(word('101'));
  }
  expect(seen).toEqual(['Absent', 'Late', 'On leave', 'Present']);
  fireEvent.press(chip('102'));
  expect(screen.getByTestId('register.counts')).toHaveTextContent('P 2 · A 1 · L 0 · O 0');
});

test('long-press opens the row: a note, and an arrival time when late', async () => {
  await mount(registerView());
  fireEvent.press(chip('101'));
  fireEvent.press(chip('101')); // late
  fireEvent(chip('101'), 'longPress');
  const sheet = await screen.findByTestId('register.rowSheet');
  fireEvent.changeText(within(sheet).getByTestId('register.rowSheet.note'), 'Bus was late');
  fireEvent.changeText(within(sheet).getByTestId('register.rowSheet.arrivedAt'), '08:40');
  fireEvent.press(within(sheet).getByTestId('register.rowSheet.close'));
  setOnline(false);
  fireEvent.press(screen.getByTestId('register.save'));
  await eventually(async () => expect(await listByState('pending')).toHaveLength(1));
  const [item] = await listByState('pending');
  const body = JSON.parse(item!.body) as { marks: Record<string, unknown>[] };
  expect(body.marks[0]).toEqual({
    enrolmentId: '101',
    status: 'late',
    note: 'Bus was late',
    arrivedAt: '08:40',
  });
});

test('saved offline: one outbox row, the local register, "Saved on device"; a second edit coalesces', async () => {
  await mount(registerView());
  setOnline(false);
  fireEvent.press(chip('102'));
  fireEvent.press(screen.getByTestId('register.save'));
  expect(await screen.findByTestId('register.stateLine')).toHaveTextContent('Saved on device');
  fireEvent.press(chip('103'));
  fireEvent.press(screen.getByTestId('register.save'));
  await eventually(async () => {
    const local = await readRegister('12', TODAY, 1);
    expect(local?.marks.find((m) => m.enrolmentId === '103')?.status).toBe('absent');
  });
  const pending = await listByState('pending');
  expect(pending).toHaveLength(1);
  const body = JSON.parse(pending[0]!.body) as { marks: { enrolmentId: string; status: string }[] };
  expect(body.marks.map((m) => [m.enrolmentId, m.status])).toEqual([
    ['101', 'present'],
    ['102', 'absent'],
    ['103', 'absent'],
  ]);
  const db = await getDb();
  expect(await db.getFirstAsync('SELECT COUNT(*) AS n FROM local_registers')).toEqual({ n: 1 });
  expect(screen.getByTestId('register.stateLine')).toHaveTextContent('Saved on device');
  // The log has the count, never the marks or a name.
  expect(logText()).toContain('register.saved_on_device');
  expect(logText()).not.toMatch(/Sara|Bilal/);
});

test('"Saved on server" appears only after the server answers 201', async () => {
  let release: (() => void) | null = null;
  const view = registerView();
  await mount(view, {
    [SUBMIT]: (request) =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            status: 201,
            body: submitResult(view, request.body as { marks: { status: string }[] }),
          });
      }),
  });
  fireEvent.press(chip('101'));
  fireEvent.press(screen.getByTestId('register.save'));
  await eventually(() => expect(release).not.toBeNull());
  await eventually(() =>
    expect(screen.getByTestId('register.stateLine')).toHaveTextContent('Sending'),
  );
  expect(screen.queryByText(/Saved on server/)).toBeNull();
  await act(async () => {
    release!();
    await Promise.resolve();
  });
  await settleOutbox();
  await eventually(() =>
    expect(screen.getByTestId('register.stateLine')).toHaveTextContent(
      /^Saved on server at \d\d:\d\d$/,
    ),
  );
  expect(screen.getByTestId('register.summary')).toHaveTextContent('P 2 · A 1 · L 0 · O 0');
  const local = await readRegister('12', TODAY, 1);
  expect(local?.serverRegisterId).toBe('900');
});

test('offline save reaches the server when the connection returns', async () => {
  const view = registerView();
  const fake = await mount(view, {
    [SUBMIT]: (request) => ({
      status: 201,
      body: submitResult(view, request.body as { marks: { status: string }[] }),
    }),
  });
  setOnline(false);
  fireEvent.press(screen.getByTestId('register.save'));
  expect(await screen.findByTestId('register.stateLine')).toHaveTextContent('Saved on device');
  expect(fake.fake.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  setOnline(true);
  await settleOutbox();
  await eventually(() =>
    expect(screen.getByTestId('register.stateLine')).toHaveTextContent(/Saved on server/),
  );
  expect(
    fake.fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('submit-register')),
  ).toHaveLength(1);
});

test('amend mode: Save needs a reason, lists the change, and sends only the changed rows', async () => {
  setOnline(true);
  await mount(recorded(registerView()));
  setOnline(false);
  expect(screen.getByTestId('register.recordedBy')).toHaveTextContent(
    'Recorded by Nadia Teacher at 08:10',
  );
  fireEvent.press(chip('102'));
  fireEvent.press(screen.getByTestId('register.save'));
  const sheet = await screen.findByTestId('reasonSheet');
  expect(within(sheet).getByText('Sara Khan: present → absent')).toBeOnTheScreen();
  fireEvent.press(within(sheet).getByTestId('reasonSheet.confirm'));
  expect(within(sheet).getByTestId('reasonSheet.reason.error')).toBeOnTheScreen();
  expect(await listByState('pending')).toHaveLength(0);
  fireEvent.changeText(within(sheet).getByTestId('reasonSheet.reason'), 'Marked by mistake');
  fireEvent.press(within(sheet).getByTestId('reasonSheet.confirm'));
  await eventually(async () => expect(await listByState('pending')).toHaveLength(1));
  const [item] = await listByState('pending');
  expect(JSON.parse(item!.body)).toEqual({
    date: TODAY,
    period: 1,
    marks: [{ enrolmentId: '102', status: 'absent' }],
    reason: 'Marked by mistake',
  });
});

test.each([
  ['the window closed', { amendable: false }, 'The amendment window closed. Ask the principal.'],
  ['not a teaching day', { teachingDay: false }, 'Not a teaching day.'],
])('read-only when %s: a banner, no Save, taps do nothing', async (_name, patch, banner) => {
  await mount({ ...recorded(registerView()), ...patch });
  expect(screen.getByTestId('register.banner')).toHaveTextContent(banner);
  expect(screen.queryByTestId('register.save')).toBeNull();
  fireEvent.press(chip('101'));
  expect(word('101')).toBe('Present');
});

test('a viewer (view_all only) has no Save', async () => {
  await mount(registerView({ canSubmit: false, callerRole: 'viewer' }));
  expect(screen.queryByTestId('register.save')).toBeNull();
  expect(screen.getByText('Viewing only')).toBeOnTheScreen();
  expect(word('101')).toBe('Not recorded');
});

test('a row that left the roster says so and is never sent', async () => {
  const view = registerView();
  view.roster[2] = { ...view.roster[2]!, onRoster: false };
  await mount(view);
  expect(within(screen.getByTestId('register.row.103')).getByText('left')).toBeOnTheScreen();
  setOnline(false);
  fireEvent.press(chip('103'));
  expect(word('103')).toBe('Not recorded');
  fireEvent.press(screen.getByTestId('register.save'));
  await eventually(async () => expect(await listByState('pending')).toHaveLength(1));
  const body = JSON.parse((await listByState('pending'))[0]!.body) as {
    marks: { enrolmentId: string }[];
  };
  expect(body.marks.map((m) => m.enrolmentId)).toEqual(['101', '102']);
});

test('AMENDMENT_REASON_REQUIRED: "Add a reason and resend" makes a new pending row with the reason', async () => {
  const view = registerView();
  await mount(view, {
    [SUBMIT]: () => ({
      status: 409,
      body: errorBody('AMENDMENT_REASON_REQUIRED', 'Changed since you loaded. Give a reason.', {
        amendments: [{ enrolmentId: '101' }],
      }),
    }),
  });
  fireEvent.press(chip('101'));
  fireEvent.press(screen.getByTestId('register.save'));
  await settleOutbox();
  expect(await screen.findByTestId('register.remedy')).toHaveTextContent('Add a reason and resend');
  expect(screen.getByTestId('register.stateLine')).toHaveTextContent(
    'Not saved: Changed since you loaded. Give a reason.',
  );
  setOnline(false);
  fireEvent.press(screen.getByTestId('register.remedy'));
  const sheet = await screen.findByTestId('reasonSheet');
  fireEvent.changeText(within(sheet).getByTestId('reasonSheet.reason'), 'A colleague marked first');
  fireEvent.press(within(sheet).getByTestId('reasonSheet.confirm'));
  await eventually(async () => expect(await listByState('pending')).toHaveLength(1));
  const [pending] = await listByState('pending');
  expect((JSON.parse(pending!.body) as { reason: string }).reason).toBe('A colleague marked first');
  expect(await listByState('failed')).toHaveLength(1); // the failed row stays until its purge
  await eventually(() =>
    expect(screen.getByTestId('register.stateLine')).toHaveTextContent('Saved on device'),
  );
});

test('after a 401 wiped the roster cache, the unsent register shows counts and no names', async () => {
  await mount(registerView());
  setOnline(false);
  fireEvent.press(chip('102'));
  fireEvent.press(screen.getByTestId('register.save'));
  await screen.findByTestId('register.stateLine');
  // The session is lost: caches wiped, the pending row kept.
  const db = await getDb();
  await db.runAsync('DELETE FROM cache');
  queryClient.clear();
  screen.unmount();
  await renderSignedIn(
    <RegisterScreen sectionId="12" date={TODAY} period={1} secure />,
    teacherMe(),
    {
      [GET]: () => 'network',
    },
  );
  const nameless = await screen.findByTestId('register.nameless');
  expect(nameless).toHaveTextContent(
    /^3 marks saved on device \(1 absent, 0 late\) — sign in to see names/,
  );
  expect(screen.getByTestId('register.stateLine')).toHaveTextContent('Saved on device');
  expect(screen.queryByText(/Ali|Sara|Bilal/)).toBeNull();
  expect(JSON.stringify(screen.toJSON())).not.toMatch(IDENTITY_PATTERN);
  expect(JSON.stringify(screen.toJSON())).not.toMatch(PHONE_PATTERN);
});

test('never opened online: cannot be marked blind', async () => {
  await renderSignedIn(
    <RegisterScreen sectionId="12" date={TODAY} period={1} secure />,
    teacherMe(),
    {
      [GET]: () => 'network',
    },
  );
  expect(
    await screen.findByText('Cannot load this register offline. Open it once while connected.'),
  ).toBeOnTheScreen();
  expect(screen.queryByTestId('register.save')).toBeNull();
});

test('the register is a secure screen', async () => {
  await mount(registerView());
  expect(preventScreenCaptureAsync).toHaveBeenCalled();
});

describe('wave-F review fixes', () => {
  test('a tap on an unmarked row starts the cycle at present', () => {
    expect(nextStatus(null)).toBe('present');
    expect(nextStatus('present')).toBe('absent');
    expect(nextStatus('on_leave')).toBe('present');
  });

  test("the reason sheet lists the server's amendments, kept as ids and statuses only", () => {
    const details = retainedDetails('AMENDMENT_REASON_REQUIRED', {
      amendments: [
        { enrolmentId: '101', markId: 'm101', from: 'present', to: 'absent', noteChanged: false },
        { enrolmentId: '102', markId: null, from: null, to: 'late', noteChanged: true },
      ],
      studentFullName: 'Ali Raza',
    });
    expect(details).not.toMatch(/Ali|markId|noteChanged/);
    const names: Record<string, string> = { '101': 'Ali Raza', '102': 'Sara Khan' };
    expect(amendmentLines(details, (id) => names[id]!)).toEqual([
      'Ali Raza: present → absent',
      'Sara Khan: not marked → late',
    ]);
    expect(retainedDetails('ROSTER_INCOMPLETE', { amendments: [] })).toBeNull();
    expect(amendmentLines(null, () => '')).toBeNull();
  });
});
