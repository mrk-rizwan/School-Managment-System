import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';

// §3.6: AES-256-GCM, a fresh 12-byte IV per encryption, the 16-byte tag enforced on decrypt, and
// AAD naming where the value lives, so a ciphertext copied to another row, column or school
// fails to decrypt. Stored as `v1:<keyId>:<iv>:<tag>:<ciphertext>`, each part base64url.

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class FieldDecryptionError extends Error {
  override readonly name = 'FieldDecryptionError';
}

/**
 * The keyring from FIELD_ENCRYPTION_KEYS (`id:base64,id:base64`, validated at boot): the first
 * key encrypts, every key decrypts, so a rotation adds a new first key and the old ones keep
 * reading existing values until re-encrypted.
 */
export class FieldCipher {
  readonly #keys: ReadonlyMap<string, Buffer>;
  readonly #currentId: string;

  constructor(keyring: string) {
    const entries = keyring.split(',').map((entry): [string, Buffer] => {
      const [id, key] = entry.split(':');
      const bytes = Buffer.from(key ?? '', 'base64');
      if (!id || bytes.length !== 32) throw new Error('invalid field encryption keyring');
      return [id, bytes];
    });
    const first = entries[0];
    if (!first) throw new Error('invalid field encryption keyring');
    this.#currentId = first[0];
    this.#keys = new Map(entries);
  }

  encrypt(plaintext: string, aad: string): string {
    const key = this.#keys.get(this.#currentId);
    if (!key) throw new Error('invalid field encryption keyring');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      VERSION,
      this.#currentId,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join(':');
  }

  /** Throws FieldDecryptionError for any malformed, tampered, mis-bound or unknown-key value. */
  decrypt(stored: string, aad: string): string {
    const [version, keyId, iv64, tag64, ct64, extra] = stored.split(':');
    if (
      version !== VERSION ||
      keyId === undefined ||
      iv64 === undefined ||
      tag64 === undefined ||
      ct64 === undefined ||
      extra !== undefined
    ) {
      throw new FieldDecryptionError('malformed encrypted value');
    }
    const key = this.#keys.get(keyId);
    if (!key) throw new FieldDecryptionError('unknown key id');
    const iv = Buffer.from(iv64, 'base64url');
    const tag = Buffer.from(tag64, 'base64url');
    // GCM accepts a truncated tag unless told otherwise; a short tag is easier to forge.
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new FieldDecryptionError('malformed encrypted value');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(ct64, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new FieldDecryptionError('encrypted value failed authentication');
    }
  }
}

/** The application's FieldCipher over the configured keyring. */
@Injectable()
export class FieldEncryption extends FieldCipher {
  constructor(@Inject(ENV) env: Env) {
    super(env.FIELD_ENCRYPTION_KEYS);
  }
}
