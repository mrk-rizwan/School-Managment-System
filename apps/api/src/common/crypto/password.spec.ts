import { randomBytes } from 'node:crypto';
import type { Env } from '../../config/env';
import { PasswordHasher } from './password';

const pepper = () => randomBytes(32).toString('base64');
const hasherWith = (PASSWORD_PEPPER: string) => new PasswordHasher({ PASSWORD_PEPPER } as Env);

describe('PasswordHasher (argon2id over a peppered HMAC, §3.6)', () => {
  const hasher = hasherWith(pepper());

  it('produces an argon2id hash that verifies only the right password', async () => {
    const stored = await hasher.hash('correct horse battery');
    expect(stored.startsWith('$argon2id$')).toBe(true);
    await expect(hasher.verify(stored, 'correct horse battery')).resolves.toBe(true);
    await expect(hasher.verify(stored, 'correct horse batterY')).resolves.toBe(false);
  });

  it('the pepper is part of the hash: another pepper cannot verify it', async () => {
    const stored = await hasher.hash('correct horse battery');
    await expect(hasherWith(pepper()).verify(stored, 'correct horse battery')).resolves.toBe(false);
  });

  it('a malformed stored hash is false, not an exception', async () => {
    await expect(hasher.verify('not-a-hash', 'x')).resolves.toBe(false);
  });

  it('the dummy verification is false', async () => {
    await expect(hasher.verifyDummy('anything')).resolves.toBe(false);
  });

  it('runs many verifications at once without losing any (the concurrency cap queues them)', async () => {
    const stored = await hasher.hash('queued');
    const results = await Promise.all(Array.from({ length: 10 }, () => hasher.verify(stored, 'queued')));
    expect(results.every(Boolean)).toBe(true);
  });
});
