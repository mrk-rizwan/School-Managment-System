import { Capability } from '@asms/shared';
import { fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { MeDto } from '../api/contracts';
import { ComposeScreen } from '../announce/ComposeScreen';
import { signIn } from '../auth/sign-in';
import { saveDiaryEntry, saveRegister } from '../db/local.repository';
import * as outbox from '../db/outbox.repository';
import { onSaved, sendItem } from '../outbox/runtime';
import { OutboxWorker } from '../outbox/worker';
import { errorBody, installFakeApi, resetDevice, type Handler } from '../test/fake-api';
import { loginFixture, meFixture } from '../test/fixtures';
import { IDENTITY_PATTERN, PHONE_PATTERN, TOKEN_PATTERN } from '../test/patterns';
import { eventually, renderSignedIn, setOnline } from '../test/screen';
import { logLines, logText } from './log';

// R16 (Phase 2 slice 17, plan §9): the app's log sink holds no identity number, phone or token
// after the paths that handle them — sign-in, a register, a diary entry and an announcement —
// driven through the real client, outbox and screens with identity-shaped input and with
// failures whose text carries identity numbers and phones (a proxy's error page, a provider
// message echoed by a misbehaving server). scrub.spec.ts proves the scrubber on strings; this
// proves every path's log call goes through it.

const CNIC = '35202-7654321-3';
const CNIC_DIGITS = CNIC.replaceAll('-', '');
const PHONES = ['+923001234567', '03001234567', '0300 1234567', '+92 300 1234567'];
/** A failure's text as a broken network layer or proxy might word it. */
const LEAKY = `upstream refused user ${CNIC} (${CNIC_DIGITS}), contact ${PHONES.join(' / ')}`;
const TOKEN = 'T'.repeat(43);

/** A thrown, non-network failure inside fetch: not "No connection", so the app logs it. */
const throws: Handler = () => {
  throw new Error(LEAKY);
};

function assertClean(events: string[]) {
  const text = logText();
  const seen = logLines().map((l) => l.event);
  // Not vacuous: the paths under test wrote these lines.
  expect(seen).toEqual(expect.arrayContaining(events));
  expect(text).not.toMatch(IDENTITY_PATTERN);
  expect(text).not.toMatch(PHONE_PATTERN);
  expect(text).not.toMatch(TOKEN_PATTERN);
  expect(text).not.toContain(CNIC_DIGITS);
  for (const phone of PHONES) expect(text).not.toContain(phone);
}

beforeEach(async () => {
  await resetDevice();
});

test('sign-in: refusals, a fault and a success with identity-shaped input leave no identity in the log', async () => {
  let answer: Handler = () => ({ status: 401, body: errorBody('AUTH_FAILED', `No account ${CNIC_DIGITS}`) });
  installFakeApi({
    'POST /api/v1/auth/login': (request) => answer(request),
    'GET /api/v1/me': () => ({ status: 200, body: meFixture() }),
  });
  const attempt = () => signIn({ schoolCode: 'demo', identity: CNIC, password: CNIC_DIGITS });

  expect(await attempt()).toMatchObject({ ok: false, kind: 'auth_failed' });
  answer = () => ({
    status: 422,
    body: errorBody('VALIDATION_FAILED', LEAKY, {
      fields: [{ path: 'username', code: 'INVALID_VALUE', message: `${CNIC_DIGITS} is invalid` }],
    }),
  });
  expect(await attempt()).toMatchObject({ ok: false, kind: 'failed' });
  answer = () => 'network';
  expect(await attempt()).toMatchObject({ ok: false, kind: 'network' });
  answer = throws;
  expect(await attempt()).toMatchObject({ ok: false, kind: 'failed' });
  // An identity typed with the phone number by mistake is refused before any request.
  expect(await signIn({ schoolCode: 'demo', identity: PHONES[1]!, password: 'x' })).toMatchObject({
    ok: false,
    kind: 'invalid_identity',
  });
  answer = () => ({ status: 200, body: loginFixture(TOKEN) });
  expect(await attempt()).toMatchObject({ ok: true });

  assertClean([
    'auth.sign_in_refused',
    'auth.sign_in_unexpected_422',
    'auth.sign_in_network',
    'auth.sign_in_failed',
    'auth.signed_in',
  ]);
});

/** Signs in (the outbox needs an owned database), then returns a worker over the real outbox. */
async function signedInWorker(routes: Record<string, Handler>) {
  installFakeApi({
    'POST /api/v1/auth/login': () => ({ status: 200, body: loginFixture(TOKEN) }),
    ...routes,
  });
  expect(await signIn({ schoolCode: 'demo', identity: CNIC, password: CNIC_DIGITS })).toMatchObject({ ok: true });
  return new OutboxWorker({ store: outbox, send: sendItem, isOnline: () => true, onSaved });
}

test('register: identity-shaped notes are refused; a send that throws such text, then a refusal, leave none in the log', async () => {
  let answer: Handler = throws;
  const worker = await signedInWorker({ 'POST /api/v1/sections/12/submit-register': (r) => answer(r) });
  const register = (note?: string, reason?: string) =>
    saveRegister({
      sectionId: '12',
      date: '2026-10-05',
      period: 1,
      mode: 'new',
      marks: [
        { enrolmentId: '101', status: 'absent', ...(note === undefined ? {} : { note }) },
        { enrolmentId: '102', status: 'present' },
      ],
      ...(reason === undefined ? {} : { reason }),
    });

  // Refused before it is saved: never sent, never logged.
  await expect(register(`Father ${PHONES[2]}`)).rejects.toThrow();
  await expect(register(undefined, `Office ref ${CNIC}`)).rejects.toThrow();

  await register('Fever');
  await worker.trigger('enqueued');
  await worker.idle();
  answer = () => ({ status: 409, body: errorBody('REGISTER_CONFLICT', LEAKY) });
  await register('Fever, collected by father');
  await worker.trigger('enqueued');
  await worker.idle();
  worker.stop();

  assertClean(['outbox.send_threw', 'outbox.item']);
});

test('diary: a topic with an identity number is refused; a send that throws such text leaves none in the log', async () => {
  let answer: Handler = throws;
  const worker = await signedInWorker({ 'POST /api/v1/sections/12/diary-entries': (r) => answer(r) });
  await expect(
    saveDiaryEntry('12', { date: '2026-10-05', subjectId: '3', topic: `Ask ${CNIC_DIGITS}` }, null),
  ).rejects.toThrow();
  await saveDiaryEntry('12', { date: '2026-10-05', subjectId: '3', topic: 'Pages 12 to 14' }, null);
  await worker.trigger('enqueued');
  await worker.idle();
  answer = () => ({ status: 422, body: errorBody('VALIDATION_FAILED', LEAKY) });
  await saveDiaryEntry('12', { date: '2026-10-05', subjectId: '3', topic: 'Exercise 4' }, null);
  await worker.trigger('enqueued');
  await worker.idle();
  worker.stop();

  assertClean(['outbox.send_threw', 'outbox.item']);
});

test('announcement: a failed create that throws identity text, then a send, leave none in the log', async () => {
  setOnline(true);
  const principal: MeDto = meFixture({
    roles: ['principal'],
    capabilities: [Capability.ANNOUNCEMENT_SEND_SCHOOL] as MeDto['capabilities'],
  });
  let create: Handler = throws;
  const draft = {
    id: '800',
    title: 'Early closing',
    body: 'School closes at noon.',
    status: 'draft',
  };
  await renderSignedIn(<ComposeScreen />, principal, {
    'POST /api/v1/announcements/preview-audience': () => ({
      status: 200,
      body: {
        byAudience: [{ kind: 'everyone', persons: 3, targetId: null, targetName: null }],
        computedAt: '2026-10-04T04:00:00.000Z',
        recipients: { total: 3, guardians: 2, staff: 1, students: 0 },
        sms: { allowed: false, cap: 0, legs: 0, remaining: 0, segments: 1, units: 0 },
        warnings: [],
      },
    }),
    'POST /api/v1/announcements': (r) => create(r),
    'POST /api/v1/announcements/800/send': () => ({ status: 200, body: { ...draft, status: 'sending' } }),
  });
  // Identity-shaped text is refused on the form, before any request.
  fireEvent.changeText(screen.getByTestId('announce.title'), `Call ${PHONES[1]}`);
  fireEvent.changeText(screen.getByTestId('announce.body'), `Ref ${CNIC}`);
  fireEvent.press(screen.getByTestId('announce.send'));
  expect(await screen.findAllByText('Do not type an identity number or a phone number here.')).toHaveLength(2);

  fireEvent.changeText(screen.getByTestId('announce.title'), 'Early closing');
  fireEvent.changeText(screen.getByTestId('announce.body'), 'School closes at noon.');
  fireEvent.press(screen.getByTestId('announce.send'));
  fireEvent.press(await screen.findByTestId('announce.confirm.send'));
  await eventually(() => expect(screen.getByTestId('announce.confirm.message')).toBeOnTheScreen());
  create = () => ({ status: 201, body: draft });
  fireEvent.press(screen.getByTestId('announce.confirm.send'));
  await eventually(() => expect(router.back).toHaveBeenCalled());

  assertClean(['announcement.sent']);
});
