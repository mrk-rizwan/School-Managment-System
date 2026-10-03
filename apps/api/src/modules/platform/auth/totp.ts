import { generateSecret, verify } from 'otplib';

// RFC 6238 as authenticator apps implement it: SHA-1, 6 digits, 30-second steps. A code from the
// previous or next step is accepted (clock drift); a step at or below the last accepted one is a
// replay and refused.

/**
 * AAD binding the encrypted secret to its column and its row (§3.6, contract slice-1 §2): a
 * secret copied onto another platform user's row fails to decrypt there.
 */
export const totpSecretAad = (platformUserId: bigint): string =>
  `platform|platform_users|totp_secret|${platformUserId}`;

const ISSUER = 'ASMS Platform';
const PERIOD_SECONDS = 30;

/** 20 random bytes, base32. */
export function newTotpSecret(): string {
  return generateSecret({ length: 20 });
}

export function otpauthUri(email: string, secret: string): string {
  const issuer = encodeURIComponent(ISSUER);
  return (
    `otpauth://totp/${issuer}:${encodeURIComponent(email)}?secret=${secret}` +
    `&issuer=${issuer}&algorithm=SHA1&digits=6&period=${PERIOD_SECONDS}`
  );
}

/**
 * The time step the code belongs to, or null if it is wrong, outside ±1 step, or not later than
 * `lastStep`. Never throws on a malformed code.
 */
export async function verifyTotp(
  secret: string,
  code: string,
  lastStep: bigint | null,
  nowMs: number = Date.now(),
): Promise<bigint | null> {
  if (!/^[0-9]{6}$/.test(code)) return null;
  try {
    const result = await verify({
      secret,
      token: code,
      algorithm: 'sha1',
      digits: 6,
      period: PERIOD_SECONDS,
      epoch: Math.floor(nowMs / 1000),
      epochTolerance: PERIOD_SECONDS,
      ...(lastStep === null ? {} : { afterTimeStep: Number(lastStep) }),
    });
    if (!result.valid || !('timeStep' in result)) return null;
    const step = BigInt(result.timeStep);
    return lastStep !== null && step <= lastStep ? null : step;
  } catch {
    return null;
  }
}
