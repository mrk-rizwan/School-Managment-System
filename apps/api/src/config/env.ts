import { Global, Module } from '@nestjs/common';
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

const port = z.coerce.number().int().min(1).max(65535);

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
