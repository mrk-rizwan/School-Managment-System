import { Global, Module } from '@nestjs/common';
import { isEmail } from 'class-validator';
import { z } from 'zod';

// The only place that reads process.env. Everything else injects ENV, so a missing or
// malformed key stops the process at boot instead of failing on the first request that needs it.

const base64Key32 = (value: string): boolean => Buffer.from(value, 'base64').length === 32;

const secret = z.string().refine(base64Key32, 'must be 32 bytes, base64-encoded');

// `id:base64,id:base64` - the first entry encrypts, every entry decrypts (key rotation).
const keyring = z.string().refine(
  (value) =>
    value.split(',').every((entry) => {
      const [id, key, extra] = entry.split(':');
      return !!id && /^[A-Za-z0-9_-]+$/.test(id) && !!key && extra === undefined && base64Key32(key);
    }),
  'must be a comma-separated list of id:base64 entries, each key 32 bytes',
);

/**
 * Platform admin emails: any address with a local part and a domain. No TLD is required, so the
 * development default `admin@localhost` is valid. The login DTO uses the same options.
 */
export const PLATFORM_EMAIL_OPTIONS = { require_tld: false } as const;

/** Trimmed and lower-cased: how a platform email is stored and looked up (contract slice-1 §7). */
export const normaliseEmail = (value: string): string => value.trim().toLowerCase();

/** Contract slice-1: platform passwords are 12-128 characters. */
export const PLATFORM_PASSWORD_MIN = 12;
export const PLATFORM_PASSWORD_MAX = 128;

const port = z.coerce.number().int().min(1).max(65535);

/** Unset or empty is absent; anything else must pass `inner`. */
const optional = <T extends z.ZodType>(inner: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), inner.optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  API_PORT: port,
  APP_URL: z.url({ protocol: /^https?$/ }),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  // CI's Redis service has no password; local and production do. Both forms are valid.
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  IDENTITY_HASH_KEY: secret,
  FIELD_ENCRYPTION_KEYS: keyring,
  PASSWORD_PEPPER: secret,
  // S3 and SMTP are format-checked only; nothing in slice 0 connects to them.
  S3_ENDPOINT: z.url({ protocol: /^https?$/ }),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: port,
  SMTP_FROM: z.string().min(1),
  // Read only by the seed script (pnpm seed:platform-admin), which requires them through
  // seedAdminCredentials(); the running API never needs them, so a server can drop the password
  // after seeding. Format-checked at boot when set, so a bad value is found early. Empty (as in
  // .env.example) counts as unset.
  PLATFORM_ADMIN_EMAIL: optional(
    z
      .string()
      .refine(
        (value) =>
          normaliseEmail(value).length <= 254 &&
          isEmail(normaliseEmail(value), PLATFORM_EMAIL_OPTIONS),
        'must be an email address',
      ),
  ),
  PLATFORM_ADMIN_PASSWORD: optional(
    z
      .string()
      .refine(
        (value) => value.length >= PLATFORM_PASSWORD_MIN && value.length <= PLATFORM_PASSWORD_MAX,
        `must be ${PLATFORM_PASSWORD_MIN}-${PLATFORM_PASSWORD_MAX} characters`,
      ),
  ),
  // The one ops mailbox for platform alerts such as whatsapp_session_down (contracts/slice-9.md,
  // decision 6). Optional until slice 9 sends the first alert.
  PLATFORM_ALERT_EMAIL: optional(
    z
      .string()
      .refine(
        (value) =>
          normaliseEmail(value).length <= 254 &&
          isEmail(normaliseEmail(value), PLATFORM_EMAIL_OPTIONS),
        'must be an email address',
      ),
  ),
  // `1` only in the worker process (src/worker.ts sets it): queue consumers and scheduled jobs run
  // there and never in the HTTP process (Phase 2 plan §2, §3).
  WORKER: z
    .enum(['0', '1'])
    .default('0')
    .transform((value) => value === '1'),
});

export type Env = Readonly<z.infer<typeof schema>>;

export class EnvError extends Error {}

/** Validates the environment. The error names each bad key and never echoes a value. */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = schema.safeParse(source);
  if (result.success) return Object.freeze(result.data);
  const lines = result.error.issues.map((issue) => {
    const key = String(issue.path[0]);
    return source[key] === undefined || source[key] === ''
      ? `  ${key}: missing`
      : `  ${key}: ${issue.message}`;
  });
  throw new EnvError(`Invalid environment, refusing to start:\n${[...new Set(lines)].join('\n')}`);
}

/**
 * The seed's credentials, which only the seed path requires. Their format was checked by
 * parseEnv; a missing one is reported the same way, by key name only.
 */
export function seedAdminCredentials(env: Env): { email: string; password: string } {
  const { PLATFORM_ADMIN_EMAIL: email, PLATFORM_ADMIN_PASSWORD: password } = env;
  if (email === undefined || password === undefined) {
    const missing = [
      ...(email === undefined ? ['  PLATFORM_ADMIN_EMAIL: missing'] : []),
      ...(password === undefined ? ['  PLATFORM_ADMIN_PASSWORD: missing'] : []),
    ];
    throw new EnvError(`Invalid environment, refusing to seed:\n${missing.join('\n')}`);
  }
  return { email, password };
}

/** The only read of process.env in the API. */
export const loadEnv = (): Env => parseEnv(process.env);

export const ENV = Symbol('ENV');

// A factory provider, not a value computed at import time: the OpenAPI script builds the
// app in preview mode, where factories never run, so it needs no secrets.
@Global()
@Module({
  providers: [{ provide: ENV, useFactory: loadEnv }],
  exports: [ENV],
})
export class EnvModule {}
