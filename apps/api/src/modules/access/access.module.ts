import { Global, Module } from '@nestjs/common';
import { UserRepository } from '../../repositories/user.repository';
import { PermissionsService } from './permissions.service';

// Global for one export: the access guard (an APP_GUARD) and session resolution in src/tenancy
// need PermissionsService on every school route. Slice 7 adds custom roles and grants here.
@Global()
@Module({
  providers: [PermissionsService, UserRepository],
  exports: [PermissionsService],
})
export class AccessModule {}
