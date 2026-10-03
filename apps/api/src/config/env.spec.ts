import { randomBytes } from 'node:crypto';
import { EnvError, parseEnv, seedAdminCredentials } from './env';

const key = () => randomBytes(32).toString('base64');

const valid = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  API_PORT: '3001',
  APP_URL: 'http://localhost:3000',
  // Credential-free URLs: the validator accepts them, and the pre-commit hook refuses
  // any URL that embeds a password, even a fake one.
  DATABASE_URL: 'postgresql://127.0.0.1:5432/asms',
  REDIS_URL: 'redis://127.0.0.1:6379',
  IDENTITY_HASH_KEY: key(),
  FIELD_ENCRYPTION_KEYS: `k2:${key()},k1:${key()}`,
  PASSWORD_PEPPER: key(),
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'asms-documents',
  S3_ACCESS_KEY_ID: 'placeholder',
  S3_SECRET_ACCESS_KEY: 'placeholder',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
  SMTP_FROM: 'ASMS <no-reply@localhost>',
  PLATFORM_ADMIN_EMAIL: 'admin@localhost',
  PLATFORM_ADMIN_PASSWORD: 'a-long-enough-password', // pragma: allowlist secret
});

describe('parseEnv', () => {
  it('accepts a complete environment and coerces ports', () => {
    expect(parseEnv(valid()).API_PORT).toBe(3001);
  });

  it('accepts a Redis URL without a password (CI) as well as with one', () => {
    expect(() => parseEnv({ ...valid(), REDIS_URL: 'redis://127.0.0.1:6379' })).not.toThrow();
  });

  it('accepts development, test and production', () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      expect(() => parseEnv({ ...valid(), NODE_ENV })).not.toThrow();
    }
  });

  it('names every missing or invalid key and never prints a value', () => {
    const secretValue = 'not-a-32-byte-key-SECRET';
    const env: NodeJS.ProcessEnv = { ...valid(), PASSWORD_PEPPER: '', IDENTITY_HASH_KEY: secretValue };
    delete env.DATABASE_URL;
    let message = '';
    try {
      parseEnv(env);
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      message = (error as Error).message;
    }
    expect(message).toContain('DATABASE_URL: missing');
    expect(message).toContain('PASSWORD_PEPPER: missing');
    expect(message).toContain('IDENTITY_HASH_KEY');
    expect(message).not.toContain(secretValue);
  });

  it('refuses a keyring entry that is not id:base64 of 32 bytes', () => {
    for (const FIELD_ENCRYPTION_KEYS of [key(), `k1:${randomBytes(16).toString('base64')}`, `k1:${key()}:x`, `:${key()}`]) {
      expect(() => parseEnv({ ...valid(), FIELD_ENCRYPTION_KEYS })).toThrow(/FIELD_ENCRYPTION_KEYS/);
    }
  });

  it('validates PLATFORM_ADMIN_EMAIL as an email (no TLD needed) and never prints the password', () => {
    expect(() => parseEnv({ ...valid(), PLATFORM_ADMIN_EMAIL: ' Admin@Example.COM ' })).not.toThrow();
    for (const PLATFORM_ADMIN_EMAIL of ['not-an-email', '@localhost', 'admin@']) {
      expect(() => parseEnv({ ...valid(), PLATFORM_ADMIN_EMAIL })).toThrow(/PLATFORM_ADMIN_EMAIL/);
    }
    for (const PLATFORM_ADMIN_PASSWORD of ['short-pass1', 'x'.repeat(129)]) {
      let message = '';
      try {
        parseEnv({ ...valid(), PLATFORM_ADMIN_PASSWORD });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('PLATFORM_ADMIN_PASSWORD');
      expect(message).not.toContain(PLATFORM_ADMIN_PASSWORD);
    }
    expect(() => parseEnv({ ...valid(), PLATFORM_ADMIN_PASSWORD: 'x'.repeat(12) })).not.toThrow();
  });

  it('PLATFORM_ALERT_EMAIL is optional and validated as an email; WORKER is 0 or 1, default 0', () => {
    expect(parseEnv(valid()).PLATFORM_ALERT_EMAIL).toBeUndefined();
    expect(parseEnv({ ...valid(), PLATFORM_ALERT_EMAIL: '' }).PLATFORM_ALERT_EMAIL).toBeUndefined();
    expect(() => parseEnv({ ...valid(), PLATFORM_ALERT_EMAIL: 'ops@asms.example' })).not.toThrow();
    expect(() => parseEnv({ ...valid(), PLATFORM_ALERT_EMAIL: 'ops' })).toThrow(/PLATFORM_ALERT_EMAIL/);
    expect(parseEnv(valid()).WORKER).toBe(false);
    expect(parseEnv({ ...valid(), WORKER: '1' }).WORKER).toBe(true);
    expect(() => parseEnv({ ...valid(), WORKER: 'yes' })).toThrow(/WORKER/);
  });

  it('boots without the seed credentials: the running API never needs the seed password', () => {
    const absent = valid();
    delete absent.PLATFORM_ADMIN_EMAIL;
    delete absent.PLATFORM_ADMIN_PASSWORD;
    expect(parseEnv(absent).PLATFORM_ADMIN_PASSWORD).toBeUndefined();
    // Empty, as .env.example ships them, is the same as unset.
    const empty = parseEnv({ ...valid(), PLATFORM_ADMIN_EMAIL: '', PLATFORM_ADMIN_PASSWORD: '' });
    expect(empty.PLATFORM_ADMIN_EMAIL).toBeUndefined();
    expect(empty.PLATFORM_ADMIN_PASSWORD).toBeUndefined();
  });

  it('the seed path requires both credentials and names only the missing keys', () => {
    expect(seedAdminCredentials(parseEnv(valid()))).toEqual({
      email: 'admin@localhost',
      password: 'a-long-enough-password', // pragma: allowlist secret
    });
    const noPassword = parseEnv({ ...valid(), PLATFORM_ADMIN_PASSWORD: '' });
    expect(() => seedAdminCredentials(noPassword)).toThrow(EnvError);
    expect(() => seedAdminCredentials(noPassword)).toThrow(/PLATFORM_ADMIN_PASSWORD: missing/);
    let message = '';
    try {
      seedAdminCredentials(noPassword);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('PLATFORM_ADMIN_EMAIL');
    expect(message).not.toContain('admin@localhost');
    const neither = parseEnv({ ...valid(), PLATFORM_ADMIN_EMAIL: '', PLATFORM_ADMIN_PASSWORD: '' });
    expect(() => seedAdminCredentials(neither)).toThrow(
      /PLATFORM_ADMIN_EMAIL: missing\n {2}PLATFORM_ADMIN_PASSWORD: missing/,
    );
  });
});
