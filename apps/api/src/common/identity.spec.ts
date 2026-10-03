import { randomBytes } from 'node:crypto';
import { identityHash, maskIdentityNumber } from './identity';

describe('identity numbers', () => {
  const key = randomBytes(32).toString('base64');

  it('hashes deterministically per key and differently across keys', () => {
    const digits = '3520112345671';
    expect(identityHash(digits, key)).toMatch(/^[0-9a-f]{64}$/);
    expect(identityHash(digits, key)).toBe(identityHash(digits, key));
    expect(identityHash(digits, randomBytes(32).toString('base64'))).not.toBe(identityHash(digits, key));
  });

  it('refuses anything but 13 normalised digits', () => {
    expect(() => identityHash('35201-1234567-1', key)).toThrow();
    expect(() => maskIdentityNumber('123')).toThrow();
  });

  it('masks the middle seven digits', () => {
    expect(maskIdentityNumber('3520112345671')).toBe('35201-*****-1');
  });
});
