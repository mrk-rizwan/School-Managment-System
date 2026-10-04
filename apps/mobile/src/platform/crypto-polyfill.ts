import * as ExpoCrypto from 'expo-crypto';

// Hermes does not guarantee crypto.randomUUID, and @asms/shared's newIdempotencyKey() calls it.
// This module is the first import of the entry file (index.ts), so every later import — the
// shared package included — sees a working crypto. Slice-15 §2.4. Without it the first offline
// write would throw.

type CryptoLike = {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView | null>(array: T) => T;
};

export function installCryptoPolyfill(): void {
  const holder = globalThis as { crypto?: CryptoLike };
  const crypto: CryptoLike = holder.crypto ?? {};
  if (typeof crypto.randomUUID !== 'function') {
    crypto.randomUUID = () => ExpoCrypto.randomUUID();
  }
  if (typeof crypto.getRandomValues !== 'function') {
    crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
      ExpoCrypto.getRandomValues(array as unknown as Uint8Array);
      return array;
    };
  }
  if (holder.crypto === undefined) {
    Object.defineProperty(globalThis, 'crypto', {
      value: crypto,
      configurable: true,
      writable: true,
    });
  }
}

installCryptoPolyfill();
