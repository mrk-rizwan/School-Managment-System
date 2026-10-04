import {
  assertSeedAllowed,
  CI_PRINCIPAL_DIGITS,
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
