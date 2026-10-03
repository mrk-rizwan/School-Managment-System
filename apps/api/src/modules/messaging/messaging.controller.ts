import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import { RequireCapability } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { ApiErrors } from '../../common/openapi';
import { perUserThrottle } from '../../common/rate-limit';
import { NoQueryDto } from '../../common/validation';
import {
  MessagingAdminService,
  type WhatsAppNumberView,
  type WhatsAppSettingsView,
} from '../../messaging/messaging-admin.service';
import {
  ConnectCloudApiDto,
  DisableWhatsAppDto,
  MessagingTestDto,
  MessagingTestResultDto,
  MessagingUsageDto,
  WhatsAppNumberDto,
  WhatsAppPairDto,
  WhatsAppPairingDto,
  WhatsAppSettingsDto,
} from './messaging.dto';

// contracts/slice-9.md §1.6.
export const MessagingTestThrottleGuard = perUserThrottle('messaging-test', 5, 30);
export const WhatsAppPairThrottleGuard = perUserThrottle('whatsapp-pair', 10, 60);
export const WhatsAppConnectThrottleGuard = perUserThrottle('whatsapp-connect', 5, 20);

const toNumberDto = (n: WhatsAppNumberView): WhatsAppNumberDto => ({ ...n, id: n.id.toString() });
const toSettingsDto = (v: WhatsAppSettingsView): WhatsAppSettingsDto => ({
  effectiveProvider: v.effectiveProvider,
  number: v.number ? toNumberDto(v.number) : null,
});

const actorOf = (s: SchoolSessionContext) => ({ schoolId: s.schoolId, userId: s.access.userId });

/**
 * The school's messaging settings (contracts/slice-9.md §5): test message, usage, and the school's
 * own WhatsApp number. Every route needs school.settings.manage.
 */
@ApiTags('messaging')
@Controller('messaging')
@RequireCapability(Capability.SCHOOL_SETTINGS_MANAGE)
export class MessagingController {
  constructor(private readonly admin: MessagingAdminService) {}

  @Post('test')
  @HttpCode(200)
  @UseGuards(MessagingTestThrottleGuard)
  @ApiOkResponse({ type: MessagingTestResultDto })
  @ApiErrors(401, 403, 409, 422, 429)
  async test(
    @Body() body: MessagingTestDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<MessagingTestResultDto> {
    const { messageId } = await this.admin.sendTest(actorOf(session), body.channel);
    return { messageId: messageId.toString() };
  }

  @Get('usage')
  @ApiOkResponse({ type: MessagingUsageDto })
  @ApiErrors(401, 403, 422)
  usage(
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<MessagingUsageDto> {
    return this.admin.usageView(actorOf(session));
  }

  @Get('whatsapp')
  @ApiOkResponse({ type: WhatsAppSettingsDto })
  @ApiErrors(401, 403, 422)
  async whatsapp(
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<WhatsAppSettingsDto> {
    return toSettingsDto(await this.admin.whatsappView(actorOf(session)));
  }

  @Post('whatsapp/pair')
  @HttpCode(200)
  @UseGuards(WhatsAppPairThrottleGuard)
  @ApiOkResponse({ type: WhatsAppPairingDto })
  @ApiErrors(401, 403, 409, 422, 429, 503)
  pair(
    @Body() body: WhatsAppPairDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<WhatsAppPairingDto> {
    return this.admin.pair(actorOf(session), body.phone);
  }

  @Post('whatsapp/connect-cloud-api')
  @HttpCode(200)
  @UseGuards(WhatsAppConnectThrottleGuard)
  @ApiOkResponse({ type: WhatsAppSettingsDto })
  @ApiErrors(401, 403, 409, 422, 429, 503)
  async connectCloudApi(
    @Body() body: ConnectCloudApiDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<WhatsAppSettingsDto> {
    return toSettingsDto(await this.admin.connectCloudApi(actorOf(session), body));
  }

  @Post('whatsapp/disable')
  @HttpCode(200)
  @ApiOkResponse({ type: WhatsAppSettingsDto })
  @ApiErrors(401, 403, 422)
  async disable(
    @Body() body: DisableWhatsAppDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<WhatsAppSettingsDto> {
    return toSettingsDto(await this.admin.disable(actorOf(session), body.reason));
  }
}
