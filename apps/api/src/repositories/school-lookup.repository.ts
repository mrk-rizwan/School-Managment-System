import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolStatus } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import { schoolIdFromLookup } from '../tenancy/school-id.mint';
import type { PrismaTxAdapter } from './prisma';

export interface LookedUpSchool {
  id: SchoolId;
  shortCode: string;
  status: SchoolStatus;
}

/**
 * CLAUDE.md named exception 2: the pre-auth school lookup at login, forgot-password and the token
 * pages, which carry the school code typed by the user. One method, returning id, short code and
 * status and nothing else.
 */
@Injectable()
export class SchoolLookupRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  /** `code` is already trimmed and lower-cased by the DTO. */
  async findByCode(code: string): Promise<LookedUpSchool | null> {
    const row = await this.txHost.tx.school.findUnique({
      where: { shortCode: code },
      select: { id: true, shortCode: true, status: true },
    });
    return row ? { id: schoolIdFromLookup(row), shortCode: row.shortCode, status: row.status } : null;
  }
}
