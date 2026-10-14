import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import { DefaultPasswordInert, RequireCapability } from '../../common/auth/route-access';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { perUserThrottle } from '../../common/rate-limit';
import { NoQueryDto } from '../../common/validation';
import { AuditEntryDto, ListAuditLogQueryDto } from './audit.dto';
import { AuditService } from './audit.service';

// Phase 5 slice 46 (contracts/slice-46.md §1). Common to every route: 401, 403 PERMISSION_DENIED /
// DEFAULT_PASSWORD_BLOCKS_ACTION, 429.
const COMMON = [401, 403, 429];

/** phase-5-extended.md §4: `audit-reads` 60 a minute, 600 an hour per user. */
export const AuditReadsThrottleGuard = perUserThrottle('audit-reads', 60, 600);

/** The audit screen (rule 40, R354): audit.view, inert on a default password (R355). */
@ApiTags('audit')
@Controller('audit-log')
@UseGuards(AuditReadsThrottleGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequireCapability(Capability.AUDIT_VIEW)
  @DefaultPasswordInert('audit_log.view')
  @ApiPaginated(AuditEntryDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListAuditLogQueryDto): Promise<Page<AuditEntryDto>> {
    return this.audit.list(query);
  }

  /** 404 for another school's row and for the access-management family (§2.2). */
  @Get(':id')
  @RequireCapability(Capability.AUDIT_VIEW)
  @DefaultPasswordInert('audit_log.view_entry')
  @ApiIdParam()
  @ApiOkResponse({ type: AuditEntryDto })
  @ApiErrors(...COMMON, 404)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<AuditEntryDto> {
    return this.audit.get(id);
  }
}
