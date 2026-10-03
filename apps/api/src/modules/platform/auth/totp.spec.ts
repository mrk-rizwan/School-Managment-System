import { randomBytes } from 'node:crypto';
import { generate } from 'otplib';
import { FieldCipher, FieldDecryptionError } from '../../../common/crypto/field-encryption';
import { totpSecretAad, verifyTotp } from './totp';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
// 15 seconds into a 30-second step, so ±1 step is unambiguous.
const NOW_MS = 1_800_000_015_000;
const STEP = BigInt(Math.floor(NOW_MS / 30_000));

/** The code for the step `offset` steps from NOW_MS. */
const codeAt = (offset: number): Promise<string> =>
  generate({ secret: SECRET, epoch: Math.floor(NOW_MS / 1000) + offset * 30 });

describe('verifyTotp (RFC 6238, ±1 step, replay refused)', () => {
  it('accepts the previous, current and next step and returns that step', async () => {
    for (const offset of [-1, 0, 1]) {
      await expect(verifyTotp(SECRET, await codeAt(offset), null, NOW_MS)).resolves.toBe(
        STEP + BigInt(offset),
      );
    }
  });

  it('refuses codes two steps away in either direction', async () => {
    for (const offset of [-2, 2]) {
      await expect(verifyTotp(SECRET, await codeAt(offset), null, NOW_MS)).resolves.toBeNull();
    }
  });

  it('refuses a step at or below the last accepted one (replay), accepts a later one', async () => {
    const current = await codeAt(0);
    await expect(verifyTotp(SECRET, current, STEP, NOW_MS)).resolves.toBeNull();
    await expect(verifyTotp(SECRET, current, STEP + 1n, NOW_MS)).resolves.toBeNull();
    await expect(verifyTotp(SECRET, await codeAt(-1), STEP - 1n, NOW_MS)).resolves.toBeNull();
    await expect(verifyTotp(SECRET, current, STEP - 1n, NOW_MS)).resolves.toBe(STEP);
  });

  it('refuses a malformed code without throwing', async () => {
    for (const code of ['', '12345', '1234567', 'abcdef']) {
      await expect(verifyTotp(SECRET, code, null, NOW_MS)).resolves.toBeNull();
    }
  });
});

describe('totpSecretAad binds the ciphertext to the user row', () => {
  const cipher = new FieldCipher(`k1:${randomBytes(32).toString('base64')}`);

  it('a secret encrypted for user A decrypts as A and fails as user B', () => {
    const stored = cipher.encrypt(SECRET, totpSecretAad(1n));
    expect(cipher.decrypt(stored, totpSecretAad(1n))).toBe(SECRET);
    expect(() => cipher.decrypt(stored, totpSecretAad(2n))).toThrow(FieldDecryptionError);
    expect(totpSecretAad(42n)).toBe('platform|platform_users|totp_secret|42');
  });
});
