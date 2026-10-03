import { Injectable } from '@nestjs/common';
import { toPage, type Page } from '../../../common/pagination';
import { addDays, todayIn } from '../../../common/school-clock';
import {
  DeliveryHealthRepository,
  type HealthRow,
} from '../../../repositories/platform/delivery-health.repository';
import {
  HEALTH_CHANNELS,
  type DeliveryHealthQueryDto,
  type HealthDayChannelDto,
  type PlatformDeliveryHealthDto,
} from './delivery-health.dto';

function dayView(rows: readonly HealthRow[], day: Date): HealthDayChannelDto[] {
  return HEALTH_CHANNELS.map((channel) => {
    const row = rows.find((r) => r.day.getTime() === day.getTime() && r.channel === channel);
    return {
      channel,
      accepted: row?.accepted ?? 0,
      delivered: row?.delivered ?? 0,
      failed: row?.failed ?? 0,
      suppressed: row?.suppressed ?? 0,
    };
  });
}

@Injectable()
export class DeliveryHealthService {
  constructor(private readonly health: DeliveryHealthRepository) {}

  async list(query: DeliveryHealthQueryDto, now: Date = new Date()): Promise<Page<PlatformDeliveryHealthDto>> {
    const today = todayIn('Asia/Karachi', now);
    const yesterday = addDays(today, -1);
    const schools = await this.health.schools({
      ...(query.schoolStatus === undefined ? {} : { schoolStatus: query.schoolStatus }),
      ...(query.q === undefined ? {} : { q: query.q }),
    });
    const rows = await this.health.rows(
      schools.map((s) => s.id),
      [today, yesterday],
    );
    let views = schools.map((school): PlatformDeliveryHealthDto => {
      const own = rows.filter((r) => r.schoolId === school.id);
      const latest = [...own].sort((a, b) => b.computedAt.getTime() - a.computedAt.getTime())[0];
      return {
        schoolId: school.id.toString(),
        name: school.name,
        shortCode: school.shortCode,
        schoolStatus: school.status,
        whatsapp: {
          status: latest?.whatsappStatus ?? 'none',
          lastHealthyAt: latest?.whatsappLastHealthyAt ?? null,
          lastErrorCode: latest?.whatsappLastErrorCode ?? null,
        },
        today: dayView(own, today),
        yesterday: dayView(own, yesterday),
        sms: { used: latest?.smsUsed ?? 0, cap: school.smsMonthlyCap },
        computedAt: latest?.computedAt ?? null,
      };
    });
    if (query.whatsappStatus !== undefined) {
      views = views.filter((v) => v.whatsapp.status === query.whatsappStatus);
    }
    const failedToday = (v: PlatformDeliveryHealthDto) => v.today.reduce((n, c) => n + c.failed, 0);
    const byId = (a: PlatformDeliveryHealthDto, b: PlatformDeliveryHealthDto) =>
      BigInt(a.schoolId) < BigInt(b.schoolId) ? -1 : 1;
    const sort = query.sort ?? 'name';
    views.sort((a, b) => {
      const primary =
        sort === 'name'
          ? a.name.localeCompare(b.name)
          : sort === '-name'
            ? b.name.localeCompare(a.name)
            : sort === '-failedToday'
              ? failedToday(b) - failedToday(a)
              : b.sms.used - a.sms.used;
      return primary !== 0 ? primary : byId(a, b);
    });
    const start = (query.page - 1) * query.limit;
    return toPage(views.slice(start, start + query.limit), query, views.length);
  }
}
