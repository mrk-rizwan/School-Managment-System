import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type {
  MessageType,
  SmsProvider,
  SmsProviderChoice,
  WhatsAppProvider,
  WhatsAppProviderChoice,
} from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import { OwnSchoolRepository } from './own-school.repository';
import type { PrismaTxAdapter } from './prisma';
import { SchoolSettingsRepository } from './school-settings.repository';

// The messaging settings a school's own code reads (contracts/slice-9.md §5, §7), composed from
// the school's own row (OwnSchoolRepository: name, time zone, SMS cap, provider choices), its
// settings row (SchoolSettingsRepository: SMS allow list, student login) and the platform-wide
// defaults those choices may defer to (the one `platform_settings` row, which holds no school's
// data and is the only table read here). Read-only: the platform sets the cap and providers (§6),
// the school its allow list (§4).

export interface SchoolMessagingSettings {
  name: string;
  timezone: string;
  smsMonthlyCap: number;
  whatsappProvider: WhatsAppProviderChoice;
  smsProvider: SmsProviderChoice;
  /** The school's choice, or the platform default when it chose `platform_default`. */
  effectiveWhatsappProvider: WhatsAppProvider;
  effectiveSmsProvider: SmsProvider;
  smsAllowedTypes: readonly MessageType[];
  /** Students receive push only while student login is on (§7.3). */
  studentLoginEnabled: boolean;
}

@Injectable()
export class SchoolMessagingRepository {
  constructor(
    private readonly txHost: TransactionHost<PrismaTxAdapter>,
    private readonly ownSchool: OwnSchoolRepository,
    private readonly schoolSettings: SchoolSettingsRepository,
  ) {}

  async find(schoolId: SchoolId): Promise<SchoolMessagingSettings | null> {
    const school = await this.ownSchool.find(schoolId);
    if (!school) return null;
    const defaults = await this.platformDefaults();
    const settings = await this.schoolSettings.find(schoolId);
    return {
      name: school.name,
      timezone: school.timezone,
      smsMonthlyCap: school.smsMonthlyCap,
      whatsappProvider: school.whatsappProvider,
      smsProvider: school.smsProvider,
      effectiveWhatsappProvider:
        school.whatsappProvider === 'platform_default'
          ? defaults.defaultWhatsappProvider
          : school.whatsappProvider,
      effectiveSmsProvider:
        school.smsProvider === 'platform_default' ? defaults.defaultSmsProvider : school.smsProvider,
      smsAllowedTypes: settings?.smsAllowedTypes ?? [],
      studentLoginEnabled: settings?.studentLoginEnabled ?? false,
    };
  }

  /** The one platform_settings row (seeded by migration; never deleted). */
  private async platformDefaults(): Promise<{
    defaultWhatsappProvider: WhatsAppProvider;
    defaultSmsProvider: SmsProvider;
  }> {
    const row = await this.txHost.tx.platformSettings.findFirst({
      where: { id: 1n },
      select: { defaultWhatsappProvider: true, defaultSmsProvider: true },
    });
    return row ?? { defaultWhatsappProvider: 'waha', defaultSmsProvider: 'sendpk' };
  }

  /** The worker's database health probe: one cheap read of a row that always exists. */
  async ping(): Promise<void> {
    await this.txHost.tx.platformSettings.findFirst({ where: { id: 1n }, select: { id: true } });
  }
}
