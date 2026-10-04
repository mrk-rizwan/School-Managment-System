import { containsPhone, errorFields, scrub, scrubText } from './scrub';
import { clearLog, log, logLines, LOG_CAPACITY, logText } from './log';
import { meFixture } from '../test/fake-api';
import { IDENTITY_PATTERN, PHONE_PATTERN, TOKEN_PATTERN } from '../test/patterns';

// slice-15 §10 (R155, R16 with the phone pattern).

describe('scrubText', () => {
  test.each([
    ['dashed CNIC', 'cnic 35201-1234567-1 here', 'cnic [id] here'],
    ['13 digits', 'username=3520112345671', 'username=[id]'],
    ['14 digits', 'x 35201123456712 y', 'x [id] y'],
    ['phone 03xx', 'call 03001234567 now', 'call [phone] now'],
    ['phone +92', 'call +923001234567', 'call [phone]'],
    ['phone with dash', 'call 0300-1234567', 'call [phone]'],
    ['phone with space', 'call 0300 1234567', 'call [phone]'],
    ['+92, space after the code', 'call +92 3001234567', 'call [phone]'],
    ['+92 300 1234567', 'call +92 300 1234567 now', 'call [phone] now'],
    ['+92-300-1234567', 'call +92-300-1234567', 'call [phone]'],
    ['92 300 1234567', 'call 92 300 1234567', 'call [phone]'],
    ['email', 'sent to ayesha.khan+x@example.com.pk ok', 'sent to [email] ok'],
    ['bearer token', `Bearer ${'a'.repeat(43)}`, 'Bearer [token]'],
    ['token in a URL', `https://x.test/reset#${'Z9_-'.repeat(11)}`, 'https://x.test/reset#[token]'],
    ['ordinary text', 'Sign-in failed. Try again.', 'Sign-in failed. Try again.'],
    ['short numbers', 'status 401 in 12 ms', 'status 401 in 12 ms'],
  ])('%s', (_name, input, expected) => {
    expect(scrubText(input)).toBe(expected);
  });
});

describe('scrub', () => {
  test('drops the secret keys outright, at any depth, case-insensitively', () => {
    const out = scrub({
      password: 'p',
      currentPassword: 'p',
      newPassword: 'p',
      token: 't',
      bearerToken: 't',
      pushToken: 't',
      Authorization: 'Bearer x',
      username: '3520112345671',
      body: '{"a":1}',
      text: 'message body',
      email: 'a@b.pk',
      fullName: 'Ayesha Khan',
      name: 'Ayesha',
      note: 'free text',
      remark: 'Weak in maths',
      cnic: '35201-1234567-1',
      identity: '3520112345671',
      nested: { deeper: { pushToken: 'fcm', keep: 'yes' } },
      status: 401,
    });
    expect(out).toEqual({ nested: { deeper: { keep: 'yes' } }, status: 401 });
  });

  test('scrubs strings inside arrays and nested objects', () => {
    expect(
      scrub({ list: ['35201-1234567-1', { phone: '03001234567' }], n: 3, ok: true, none: null }),
    ).toEqual({
      list: ['[id]', { phone: '[phone]' }],
      n: 3,
      ok: true,
      none: null,
    });
  });

  test('an Error is reduced to name, code, status and a scrubbed message', () => {
    const error = Object.assign(new Error('bad 3520112345671'), {
      code: 'X',
      status: 500,
      secret: 'no',
    });
    expect(scrub({ error })).toEqual({
      error: { errorName: 'Error', code: 'X', status: 500, message: 'bad [id]' },
    });
    expect(errorFields('nope')).toEqual({ errorName: 'string' });
  });

  test('stops at a depth limit instead of recursing forever', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 20; i++) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    expect(JSON.stringify(scrub(deep))).toContain('[deep]');
  });
});

describe('the log ring buffer', () => {
  beforeEach(clearLog);

  test('keeps the last 200 lines', () => {
    for (let i = 0; i < LOG_CAPACITY + 50; i++) log('info', 'tick', { i });
    const lines = logLines();
    expect(lines).toHaveLength(LOG_CAPACITY);
    expect(lines[0]?.fields).toEqual({ i: 50 });
  });

  test('every field passes the scrubber before it is kept', () => {
    log('warn', 'auth.sign_in 35201-1234567-1', {
      username: '3520112345671',
      note: 'phone 03001234567',
      url: `http://x/${'b'.repeat(43)}`,
      fullName: meFixture().fullName,
      user: { name: meFixture().fullName, email: meFixture().email },
      said: `mail ${meFixture().email} or +92 300 1234567`,
    });
    const text = logText();
    expect(text).not.toContain(meFixture().fullName);
    expect(text).not.toContain(meFixture().email!);
    expect(text).not.toMatch(/\+92[\s-]?3\d{2}[\s-]?\d{7}/);
    expect(text).not.toMatch(IDENTITY_PATTERN);
    expect(text).not.toMatch(PHONE_PATTERN);
    expect(text).not.toMatch(TOKEN_PATTERN);
  });
});

describe('slice-16 §3.7: the typed text and arrays of slice 16 are dropped by key', () => {
  test.each([
    'topic',
    'assignment',
    'learningOutcome',
    'reason',
    'title',
    'studentFullName',
    'fullName',
    'viaStudents',
    'marks',
    'audiences',
  ])('%s', (key) => {
    expect(scrub({ [key]: 'anything', sectionId: '12' })).toEqual({ sectionId: '12' });
  });

  test('a marks array that slips into a log line is dropped whole; the count stays', () => {
    const fields = {
      sectionId: '12',
      count: 2,
      marks: [
        { enrolmentId: '101', status: 'absent', studentFullName: 'Ali Raza' },
        { enrolmentId: '102', status: 'present', note: 'Father 0300 1234567' },
      ],
    };
    expect(scrub(fields)).toEqual({ sectionId: '12', count: 2 });
  });

  test('containsPhone finds a Pakistani mobile in typed text', () => {
    expect(containsPhone('Call 0300 1234567')).toBe(true);
    expect(containsPhone('Pages 12–14, roll 30')).toBe(false);
  });
});
