import { Module } from '@nestjs/common';
import { FieldEncryption } from './field-encryption';
import { PasswordHasher } from './password';

/** Password hashing and field encryption over the validated environment's keys (§3.6). */
@Module({
  providers: [PasswordHasher, FieldEncryption],
  exports: [PasswordHasher, FieldEncryption],
})
export class CryptoModule {}
