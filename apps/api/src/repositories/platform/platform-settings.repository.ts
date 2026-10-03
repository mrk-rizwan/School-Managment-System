import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SmsProvider, WhatsAppProvider } from '@asms/shared';
import type { PrismaTxAdapter } from '../prisma';

// The one platform_settings row (non-tenant; contracts/slice-9.md §6.2): platform-wide messaging
// defaults for schools on `platform_default`. Seeded by its migration (id 1), never deleted.
// Importable only from src/modules/platform/**.

export interface PlatformSettingsRecord {
  defaultWhatsappProvider: WhatsAppProvider;
  defaultSmsProvider: SmsProvider;
  updatedAt: Date;
}

const SELECT = { defaultWhatsappProvider: true, defaultSmsProvider: true, updatedAt: true } as const;

@Injectable()
export class PlatformSettingsRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async get(): Promise<PlatformSettingsRecord> {
    const row = await this.txHost.tx.platformSettings.findFirst({ where: { id: 1n }, select: SELECT });
    if (!row) throw new Error('platform_settings row missing (seeded by migration)');
    return row;
  }

  /** Locks the row for the rest of the transaction (a no-op UPDATE) and returns it. */
  async lock(): Promise<PlatformSettingsRecord> {
    const [row] = await this.txHost.tx.platformSettings.updateManyAndReturn({
      where: { id: 1n },
      data: { id: 1n },
      select: SELECT,
    });
    if (!row) throw new Error('platform_settings row missing (seeded by migration)');
    return row;
  }

  async update(data: {
    defaultWhatsappProvider?: WhatsAppProvider;
    defaultSmsProvider?: SmsProvider;
  }): Promise<PlatformSettingsRecord> {
    const [row] = await this.txHost.tx.platformSettings.updateManyAndReturn({
      where: { id: 1n },
      data,
      select: SELECT,
    });
    if (!row) throw new Error('platform_settings row missing (seeded by migration)');
    return row;
  }
}
