import { randomUUID as nodeRandomUUID, getRandomValues as nodeGetRandomValues } from 'node:crypto';

// slice-15 §2.4: Hermes does not guarantee crypto.randomUUID; the polyfill installs expo-crypto's
// before anything imports @asms/shared, so newIdempotencyKey() works.

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('crypto polyfill', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    jest.resetModules();
  });

  test('with no global crypto, newIdempotencyKey() returns distinct dashed v4 UUIDs', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    jest.isolateModules(() => {
      jest.doMock('expo-crypto', () => ({
        randomUUID: () => nodeRandomUUID(),
        getRandomValues: (array: Uint8Array) => nodeGetRandomValues(array),
      }));
      require('./crypto-polyfill');
      const { newIdempotencyKey } = require('@asms/shared') as typeof import('@asms/shared');
      const a = newIdempotencyKey();
      const b = newIdempotencyKey();
      expect(a).toMatch(V4);
      expect(b).toMatch(V4);
      expect(a).not.toBe(b);
      const bytes = new Uint8Array(8);
      (
        globalThis as { crypto: { getRandomValues(a: Uint8Array): Uint8Array } }
      ).crypto.getRandomValues(bytes);
      expect(bytes.some((byte) => byte !== 0)).toBe(true);
    });
  });

  test('a crypto that already has randomUUID is left as it is', () => {
    const existing = {
      randomUUID: () => '00000000-0000-4000-8000-000000000000',
      getRandomValues: (a: Uint8Array) => a,
    };
    Object.defineProperty(globalThis, 'crypto', {
      value: existing,
      configurable: true,
      writable: true,
    });
    jest.isolateModules(() => {
      jest.doMock('expo-crypto', () => ({
        randomUUID: () => 'never',
        getRandomValues: () => undefined,
      }));
      require('./crypto-polyfill');
      expect((globalThis as { crypto: typeof existing }).crypto.randomUUID()).toBe(
        '00000000-0000-4000-8000-000000000000',
      );
    });
  });
});

describe('formats in Asia/Karachi (the moved shared helpers)', () => {
  test('a fixed instant formats in school time on this runtime', () => {
    const { formatDateTime, formatDay } = require('@asms/shared') as typeof import('@asms/shared');
    // 23:30 UTC on 3 October is 04:30 on 4 October in Karachi (UTC+5).
    expect(formatDateTime('2026-10-03T23:30:00.000Z')).toBe('4 Oct 2026, 04:30');
    expect(formatDay('2026-10-04')).toBe('4 Oct 2026');
  });
});
