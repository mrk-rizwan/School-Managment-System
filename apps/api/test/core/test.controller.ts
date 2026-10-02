// Test-only routes for exercising the cross-cutting pieces. Never imported by src.
import { Body, Controller, Get, Logger, Module, Post, Query, Req } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsArray, IsString, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { Public } from '../../src/common/auth/route-access';
import { ApiIdParam, IdParam, IsIdString } from '../../src/common/ids';
import { ApiErrors } from '../../src/common/openapi';
import { ApiPaginated, PageQueryDto, toPage } from '../../src/common/pagination';
import { NoQueryDto } from '../../src/common/validation';

class GuardianDto {
  @IsString()
  phone: string;
}

class ItemDto {
  @ApiProperty({ type: String })
  id: string;
}

class ThingDto {
  @IsString()
  name: string;

  @IsIdString()
  classId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GuardianDto)
  guardians: GuardianDto[];
}

@Controller('test')
export class TestController {
  private readonly logger = new Logger('TestController');

  @Public()
  @Post('things')
  create(@Body() body: ThingDto): ThingDto {
    return body;
  }

  @Public()
  @Get('things')
  @ApiPaginated(ItemDto)
  @ApiErrors(422)
  list(@Query() query: PageQueryDto) {
    return toPage([{ id: 9007199254740993n }], query, 1);
  }

  @Public()
  @Get('items/:id')
  @ApiIdParam()
  item(@IdParam() id: bigint, @Query() _query: NoQueryDto) {
    return { id, typeOfId: typeof id };
  }

  @Public()
  @Get('ip')
  ip(@Req() req: Request) {
    return { ip: req.ip };
  }

  @Public()
  @Get('boom')
  boom(): never {
    throw new Error('boom 3520212345671 internal detail');
  }

  @Public()
  @Post('log')
  log(): { ok: true } {
    this.logger.log({ user: { password: 'hunter2', cnic: '35202-1234567-1' } }, 'logging a user');
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  @Get('throttled')
  throttled(): { ok: true } {
    return { ok: true };
  }

  // Deliberately undecorated: the access guard must refuse it (R68).
  @Get('undecorated')
  undecorated(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [TestController] })
export class TestCoreModule {}
