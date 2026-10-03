import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';
import { ENV, type Env } from '../../config/env';

// §3.6: argon2id over HMAC-SHA256(PASSWORD_PEPPER, password). Without the pepper a database dump
// is not brute-forceable; school default passwords are 13-digit numbers, which would be.
const ARGON2_OPTIONS = { algorithm: Algorithm.Argon2id } as const;

/** At most this many argon2 operations run at once; the rest queue (§3.6: verifications are capped). */
const MAX_CONCURRENT = 4;

// Hex, not raw bytes: @node-rs/argon2's verify() rejects a password that is not valid UTF-8.
function peppered(pepper: Buffer, password: string): string {
  return createHmac('sha256', pepper).update(password, 'utf8').digest('hex');
}

@Injectable()
export class PasswordHasher {
  readonly #pepper: Buffer;
  #running = 0;
  readonly #waiting: (() => void)[] = [];
  #dummyHash: Promise<string> | undefined;

  constructor(@Inject(ENV) env: Env) {
    this.#pepper = Buffer.from(env.PASSWORD_PEPPER, 'base64');
  }

  hash(password: string): Promise<string> {
    return this.#limited(() => hash(peppered(this.#pepper, password), ARGON2_OPTIONS));
  }

  /** False for a wrong password and for a malformed stored hash; never throws on either. */
  verify(passwordHash: string, password: string): Promise<boolean> {
    return this.#limited(async () => {
      try {
        return await verify(passwordHash, peppered(this.#pepper, password));
      } catch {
        return false;
      }
    });
  }

  /**
   * Spends the same time as a real verification and returns false. Used when the account does
   * not exist, so response timing does not reveal which emails are registered.
   */
  async verifyDummy(password: string): Promise<false> {
    this.#dummyHash ??= this.hash('asms-dummy-password-for-timing');
    await this.verify(await this.#dummyHash, password);
    return false;
  }

  async #limited<T>(work: () => Promise<T>): Promise<T> {
    // A finishing operation hands its slot straight to the next waiter, so the count never
    // exceeds the cap even when a new caller arrives in between.
    if (this.#running < MAX_CONCURRENT) this.#running++;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    try {
      return await work();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#running--;
    }
  }
}
