import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../../tenancy/school-id';
import { schoolIdsForFanOut } from '../../tenancy/school-id.mint';
import type { PrismaTxAdapter } from '../prisma';

/**
 * CLAUDE.md named exception 3, the scheduler fan-out: the one read of the schools table outside
 * the platform module, returning ids only. A scheduled job calls it to run once per school; each
 * run carries its SchoolId and uses ordinary tenant repositories. Imported only by the job files
 * listed in NAMED_EXCEPTION_SITES (eslint.config.mjs).
 */
@Injectable()
export class SchoolFanOutRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /**
   * Every school, whatever its status. Housekeeping such as the staged-upload sweep must reach
   * suspended and terminated schools too (R41, R90); a job that only serves live schools filters
   * on its own.
   */
  async listAllForFanOut(): Promise<SchoolId[]> {
    const rows = await this.txHost.tx.school.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return schoolIdsForFanOut(rows);
  }

  /**
   * Every school that is not terminated (Phase 2 messaging jobs, contracts/slice-9.md §7.8-§7.11):
   * a terminated school's rows are left as they are, and its jobs would be dropped anyway (R113).
   */
  async listLiveForFanOut(): Promise<SchoolId[]> {
    const rows = await this.txHost.tx.school.findMany({
      where: { status: { not: 'terminated' } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return schoolIdsForFanOut(rows);
  }
}
