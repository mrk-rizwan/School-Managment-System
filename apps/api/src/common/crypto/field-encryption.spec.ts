import { randomBytes } from 'node:crypto';
import { FieldCipher, FieldDecryptionError } from './field-encryption';

const key = () => randomBytes(32).toString('base64');
const AAD = 'platform|platform_users|totp_secret|1';

describe('FieldCipher (AES-256-GCM, §3.6)', () => {
  const k1 = `k1:${key()}`;
  const cipher = new FieldCipher(k1);

  it('round-trips and writes v1:<keyId>:<iv>:<tag>:<ct> with a 12-byte IV and 16-byte tag', () => {
    const stored = cipher.encrypt('JBSWY3DPEHPK3PXP', AAD);
    expect(cipher.decrypt(stored, AAD)).toBe('JBSWY3DPEHPK3PXP');
    const [version, keyId, iv, tag] = stored.split(':');
    expect(version).toBe('v1');
    expect(keyId).toBe('k1');
    expect(Buffer.from(iv!, 'base64url')).toHaveLength(12);
    expect(Buffer.from(tag!, 'base64url')).toHaveLength(16);
  });

  it('uses a fresh IV every time', () => {
    expect(cipher.encrypt('same', AAD)).not.toBe(cipher.encrypt('same', AAD));
  });

  it('refuses a tampered tag, a tampered ciphertext and a truncated tag', () => {
    const [v, id, iv, tag, ct] = cipher.encrypt('secret', AAD).split(':') as [string, string, string, string, string];
    const flip = (b64: string) => {
      const bytes = Buffer.from(b64, 'base64url');
      bytes[0] = bytes[0]! ^ 1;
      return bytes.toString('base64url');
    };
    expect(() => cipher.decrypt([v, id, iv, flip(tag), ct].join(':'), AAD)).toThrow(FieldDecryptionError);
    expect(() => cipher.decrypt([v, id, iv, tag, flip(ct)].join(':'), AAD)).toThrow(FieldDecryptionError);
    const short = Buffer.from(tag, 'base64url').subarray(0, 12).toString('base64url');
    expect(() => cipher.decrypt([v, id, iv, short, ct].join(':'), AAD)).toThrow(FieldDecryptionError);
  });

  it('refuses the right ciphertext under the wrong AAD (another column, table or school)', () => {
    const stored = cipher.encrypt('secret', AAD);
    expect(() => cipher.decrypt(stored, 'platform|platform_users|password_hash')).toThrow(FieldDecryptionError);
  });

  it('refuses an unknown key id and a malformed value', () => {
    const stored = cipher.encrypt('secret', AAD).replace(/^v1:k1:/, 'v1:k9:');
    expect(() => cipher.decrypt(stored, AAD)).toThrow(FieldDecryptionError);
    for (const bad of ['', 'plain', 'v2:k1:a:b:c', `${cipher.encrypt('x', AAD)}:extra`]) {
      expect(() => cipher.decrypt(bad, AAD)).toThrow(FieldDecryptionError);
    }
  });

  it('rotation: a new first key encrypts, and values under the older key still decrypt', () => {
    const old = cipher.encrypt('before rotation', AAD);
    const rotated = new FieldCipher(`k2:${key()},${k1}`);
    expect(rotated.decrypt(old, AAD)).toBe('before rotation');
    const fresh = rotated.encrypt('after rotation', AAD);
    expect(fresh.startsWith('v1:k2:')).toBe(true);
    // The old ring alone cannot read the new key's values.
    expect(() => cipher.decrypt(fresh, AAD)).toThrow(FieldDecryptionError);
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => new FieldCipher(`k1:${randomBytes(16).toString('base64')}`)).toThrow();
  });
});
