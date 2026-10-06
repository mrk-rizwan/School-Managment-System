import { Inject, Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { diffFields } from '../../../common/diff';
import { ENV, type Env } from '../../../config/env';
import { refuseDisabledWhatsappProvider } from '../whatsapp-providers';
import { PlatformAuditRepository } from '../../../repositories/platform/platform-audit.repository';
import {
  PlatformSettingsRepository,
  type PlatformSettingsRecord,
} from '../../../repositories/platform/platform-settings.repository';
import type { PlatformSettingsDto, UpdatePlatformSettingsDto } from './platform-settings.dto';

const EDITABLE = ['defaultWhatsappProvider', 'defaultSmsProvider', 'invoiceDueDay', 'graceDays'] as const;

@Injectable()
export class PlatformSettingsService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly settings: PlatformSettingsRepository,
    private readonly audit: PlatformAuditRepository,
  ) {}

  private toDto(row: PlatformSettingsRecord): PlatformSettingsDto {
    return { ...row, enabledWhatsappProviders: [...this.env.WHATSAPP_PROVIDERS_ENABLED] };
  }

  async get(): Promise<PlatformSettingsDto> {
    return this.toDto(await this.settings.get());
  }

  /** Row locked; no change -> 200 without an audit row. */
  @Transactional()
  async update(actorId: bigint, dto: UpdatePlatformSettingsDto): Promise<PlatformSettingsDto> {
    refuseDisabledWhatsappProvider(this.env, 'defaultWhatsappProvider', dto.defaultWhatsappProvider);
    const current = await this.settings.lock();
    const { data, changes } = diffFields(current, dto, EDITABLE);
    if (Object.keys(changes).length === 0) return this.toDto(current);
    const updated = await this.settings.update(data);
    await this.audit.record({
      actorPlatformUserId: actorId,
      schoolId: null,
      action: 'platform_settings.updated',
      subjectType: 'platform_settings',
      subjectId: 1n,
      metadata: { changes },
    });
    return this.toDto(updated);
  }
}
