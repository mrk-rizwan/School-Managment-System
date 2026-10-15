import { Injectable, Logger } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode } from '@asms/shared';
import { FieldDecryptionError, FieldEncryption } from '../../../common/crypto/field-encryption';
import { ApiException } from '../../../common/errors/api-exception';
import { PlatformUserRepository } from '../../../repositories/platform/platform-user.repository';
import { totpSecretAad, verifyTotp } from './totp';

const totpInvalid = (): ApiException =>
  new ApiException(409, ErrorCode.TOTP_INVALID, 'That code is not valid. Try the current one.');

/**
 * A fresh second factor for one sensitive platform action (phase-5-extended.md §3.1: opening a
 * support session, contracts/slice-45.md §2.1). The code must verify against the caller's
 * enrolled secret and belong to a step later than the last accepted one; that step is then
 * stored, so a code used to sign in, or to open a session, cannot be replayed. Exported by the
 * (global) platform auth module so the support module needs no platform-user repository.
 */
@Injectable()
export class PlatformStepUp {
  private readonly logger = new Logger('PlatformStepUp');

  constructor(
    private readonly users: PlatformUserRepository,
    private readonly cipher: FieldEncryption,
  ) {}

  /** Commits the step on success; 409 TOTP_INVALID on a wrong, malformed or replayed code. */
  @Transactional()
  async verify(platformUserId: bigint, code: string): Promise<void> {
    const user = await this.users.lockById(platformUserId);
    if (user === null || user.status !== 'active' || user.totpEnrolledAt === null || user.totpSecret === null) {
      throw totpInvalid();
    }
    let secret: string;
    try {
      secret = this.cipher.decrypt(user.totpSecret, totpSecretAad(user.id));
    } catch (error) {
      if (!(error instanceof FieldDecryptionError)) throw error;
      this.logger.error({ platformUserId: user.id.toString() }, 'TOTP secret failed to decrypt');
      throw totpInvalid();
    }
    const step = await verifyTotp(secret, code, user.totpLastStep);
    if (step === null || !(await this.users.recordTotpStep(user.id, step))) throw totpInvalid();
  }
}
