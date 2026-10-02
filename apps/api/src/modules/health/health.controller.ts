import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/auth/route-access';
import { ApiErrors } from '../../common/openapi';
import { NoQueryDto } from '../../common/validation';

class HealthDto {
  @ApiProperty({ enum: ['ok'] })
  status: 'ok';
}

// Liveness only: no database or Redis call, so a dependency outage does not mark the
// process dead and get it restarted for nothing. Not throttled for the same reason: the
// throttler counts hits in Redis.
@SkipThrottle()
@Controller('health')
export class HealthController {
  @Get()
  @Public()
  @ApiOkResponse({ type: HealthDto })
  @ApiErrors()
  check(@Query() _query: NoQueryDto): HealthDto {
    return { status: 'ok' };
  }
}
