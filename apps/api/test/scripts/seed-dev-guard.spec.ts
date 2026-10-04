import {
  assertSeedAllowed,
  CI_GUARDIAN_DIGITS,
  CI_IDENTITY_DIGITS,
  CI_PRINCIPAL_DIGITS,
  CI_TEACHER_DIGITS,
  readClassroomSettings,
  readSeedSettings,
  SeedRefusal,
} from '../../scripts/seed-dev-guard';

// Security review of slice 15, M2 and L4: seed-dev-school.ts runs only against a developer's own
// database. One test per refusal, and one per condition that allows it. No database is touched.

const OWN = '3520112345671';
const local = (host: string) => `postgresql://dev:pw@${host}:5432/asms`; // pragma: allowlist secret
const REMOTE = local('db.staging.example.pk');

describe('refusals', () => {
  test('NODE_ENV=production, even on a loopback host with the flag', () => {
    expect(() =>
      assertSeedAllowed(
        { NODE_ENV: 'production', DATABASE_URL: local('localhost'), ALLOW_DEV_SEED: '1' },
        OWN,
      ),
    ).toThrow(new SeedRefusal('Refusing to seed a development school in production'));
  });

  test('a non-loopback host without ALLOW_DEV_SEED=1', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'development', DATABASE_URL: REMOTE }, OWN)).toThrow(
      /db\.staging\.example\.pk is not loopback.*ALLOW_DEV_SEED=1/,
    );
  });

  test('ALLOW_DEV_SEED set to anything but 1 does not count', () => {
    expect(() =>
      assertSeedAllowed(
        { NODE_ENV: 'development', DATABASE_URL: REMOTE, ALLOW_DEV_SEED: 'true' },
        OWN,
      ),
    ).toThrow(SeedRefusal);
  });

  test('an unparseable or missing DATABASE_URL is not loopback', () => {
    expect(() =>
      assertSeedAllowed({ NODE_ENV: 'development', DATABASE_URL: 'nonsense' }, OWN),
    ).toThrow(SeedRefusal);
    expect(() => assertSeedAllowed({ NODE_ENV: 'development' }, OWN)).toThrow(SeedRefusal);
  });

  test('the CI identity number on a non-loopback host, even with ALLOW_DEV_SEED=1', () => {
    expect(() =>
      assertSeedAllowed(
        { NODE_ENV: 'development', DATABASE_URL: REMOTE, ALLOW_DEV_SEED: '1' },
        CI_PRINCIPAL_DIGITS,
      ),
    ).toThrow(/CI identity number/);
  });

  test('a missing principal phone (no live-looking default)', () => {
    expect(() => readSeedSettings({ DEV_SCHOOL_PRINCIPAL_CNIC: OWN })).toThrow(
      new SeedRefusal('DEV_SCHOOL_PRINCIPAL_PHONE: required'),
    );
    expect(() =>
      readSeedSettings({ DEV_SCHOOL_PRINCIPAL_CNIC: OWN, DEV_SCHOOL_PRINCIPAL_PHONE: '  ' }),
    ).toThrow(SeedRefusal);
    expect(() =>
      readSeedSettings({ DEV_SCHOOL_PRINCIPAL_CNIC: OWN, DEV_SCHOOL_PRINCIPAL_PHONE: 'call me' }),
    ).toThrow(new SeedRefusal('DEV_SCHOOL_PRINCIPAL_PHONE: not a phone number'));
  });

  test('a missing or malformed identity number', () => {
    expect(() => readSeedSettings({ DEV_SCHOOL_PRINCIPAL_PHONE: '+920000000000' })).toThrow(
      /DEV_SCHOOL_PRINCIPAL_CNIC/,
    );
  });
});

describe('what allows it, printed', () => {
  test.each([['localhost'], ['127.0.0.1'], ['[::1]']])('a loopback host (%s)', (host) => {
    expect(assertSeedAllowed({ NODE_ENV: 'development', DATABASE_URL: local(host) }, OWN)).toMatch(
      /is loopback$/,
    );
  });

  test('the CI identity number on a loopback host (the CI job itself)', () => {
    expect(
      assertSeedAllowed(
        { NODE_ENV: 'development', DATABASE_URL: local('127.0.0.1') },
        CI_PRINCIPAL_DIGITS,
      ),
    ).toBe('the database host 127.0.0.1 is loopback');
  });

  test('ALLOW_DEV_SEED=1 on a remote development database, the password never printed', () => {
    const reason = assertSeedAllowed(
      { NODE_ENV: 'development', DATABASE_URL: REMOTE, ALLOW_DEV_SEED: '1' },
      OWN,
    );
    expect(reason).toBe('ALLOW_DEV_SEED=1 is set (database host db.staging.example.pk)');
    expect(reason).not.toContain('pw');
  });

  test('settings: the phone and identity number as given, defaults for the rest', () => {
    expect(
      readSeedSettings({
        DEV_SCHOOL_PRINCIPAL_CNIC: '35201-1234567-1',
        DEV_SCHOOL_PRINCIPAL_PHONE: '0300 0000000',
      }),
    ).toEqual({
      cnic: OWN,
      shortCode: 'demo',
      name: 'Demo School',
      fullName: 'Demo Principal',
      phone: '+923000000000',
    });
  });
});

describe('the classroom fixture (contracts/slice-16.md §15.3)', () => {
  const classroomEnv = {
    DEV_SCHOOL_CLASSROOM: '1',
    DEV_SCHOOL_TEACHER_CNIC: '35202-9999999-2',
    DEV_SCHOOL_TEACHER_PHONE: '0300 0000001',
    DEV_SCHOOL_GUARDIAN_CNIC: CI_GUARDIAN_DIGITS,
    DEV_SCHOOL_GUARDIAN_PHONE: '+923000000002',
  };

  test('off unless DEV_SCHOOL_CLASSROOM=1', () => {
    expect(readClassroomSettings({}, OWN)).toBeNull();
    expect(
      readClassroomSettings({ ...classroomEnv, DEV_SCHOOL_CLASSROOM: 'true' }, OWN),
    ).toBeNull();
  });

  test('the teacher and the guardian as given, normalised, with default names', () => {
    expect(readClassroomSettings(classroomEnv, OWN)).toEqual({
      teacher: { cnic: CI_TEACHER_DIGITS, phone: '+923000000001', fullName: 'Demo Teacher' },
      guardian: { cnic: CI_GUARDIAN_DIGITS, phone: '+923000000002', fullName: 'Demo Guardian' },
    });
  });

  test.each([
    [
      'DEV_SCHOOL_TEACHER_CNIC',
      { DEV_SCHOOL_TEACHER_CNIC: undefined },
      /DEV_SCHOOL_TEACHER_CNIC: missing/,
    ],
    [
      'DEV_SCHOOL_TEACHER_PHONE',
      { DEV_SCHOOL_TEACHER_PHONE: ' ' },
      /DEV_SCHOOL_TEACHER_PHONE: required/,
    ],
    [
      'DEV_SCHOOL_GUARDIAN_CNIC',
      { DEV_SCHOOL_GUARDIAN_CNIC: '123' },
      /DEV_SCHOOL_GUARDIAN_CNIC: missing/,
    ],
    [
      'DEV_SCHOOL_GUARDIAN_PHONE',
      { DEV_SCHOOL_GUARDIAN_PHONE: 'call me' },
      /DEV_SCHOOL_GUARDIAN_PHONE: not a phone/,
    ],
  ])('%s is required and checked (no live-looking default)', (_name, patch, message) => {
    expect(() => readClassroomSettings({ ...classroomEnv, ...patch }, OWN)).toThrow(message);
  });

  test('the principal, the teacher and the guardian are three different people', () => {
    expect(() =>
      readClassroomSettings({ ...classroomEnv, DEV_SCHOOL_TEACHER_CNIC: OWN }, OWN),
    ).toThrow(/three different identity numbers/);
  });

  test.each([
    ['teacher', CI_TEACHER_DIGITS],
    ['guardian', CI_GUARDIAN_DIGITS],
  ])(
    'the CI %s number is refused on a non-loopback host, even with ALLOW_DEV_SEED=1',
    (_who, digits) => {
      expect(() =>
        assertSeedAllowed(
          { NODE_ENV: 'development', DATABASE_URL: REMOTE, ALLOW_DEV_SEED: '1' },
          OWN,
          digits,
        ),
      ).toThrow(/CI identity number/);
    },
  );

  test('all three CI numbers on a loopback host (the mobile CI job)', () => {
    expect(
      assertSeedAllowed(
        { NODE_ENV: 'development', DATABASE_URL: local('127.0.0.1') },
        CI_PRINCIPAL_DIGITS,
        CI_TEACHER_DIGITS,
        CI_GUARDIAN_DIGITS,
      ),
    ).toBe('the database host 127.0.0.1 is loopback');
    expect([...CI_IDENTITY_DIGITS].sort()).toEqual(
      [CI_PRINCIPAL_DIGITS, CI_TEACHER_DIGITS, CI_GUARDIAN_DIGITS].sort(),
    );
  });
});
