import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PlatformSession } from '../../../common/auth/route-access';
import { ApiErrors } from '../../../common/openapi';
import { ApiPaginated, type Page } from '../../../common/pagination';
import { DeliveryHealthQueryDto, PlatformDeliveryHealthDto } from './delivery-health.dto';
import { DeliveryHealthService } from './delivery-health.service';

@ApiTags('platform: messaging')
@Controller('platform/messaging')
export class DeliveryHealthController {
  constructor(private readonly service: DeliveryHealthService) {}

  @Get('health')
  @PlatformSession('full')
  @ApiPaginated(PlatformDeliveryHealthDto)
  @ApiErrors(401, 403, 422, 429)
  health(@Query() query: DeliveryHealthQueryDto): Promise<Page<PlatformDeliveryHealthDto>> {
    return this.service.list(query);
  }
}
