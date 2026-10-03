import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';
import type { StaffStatusValue } from './user.repository';

export interface StaffSummary {
  id: bigint;
  fullName: string;
  status: StaffStatusValue;
}

export interface NewStaff {
  fullName: string;
  /** `v1:...` ciphertext with AAD `schoolId|staff|cnic`. */
  cnic: string;
  cnicHash: string;
  /** E.164. */
  phone: string;
  designation: string;
  /** A date (time part ignored by the DATE column). */
  joinedOn: Date;
}

const SUMMARY = { id: true, fullName: true, status: true } as const;

/** staff (tenant), minimal for slice 2; slice 4 extends it. */
@Injectable()
export class StaffRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  findByCnicHash(schoolId: SchoolId, cnicHash: string): Promise<StaffSummary | null> {
    return this.txHost.tx.staff.findFirst({ where: { schoolId, cnicHash }, select: SUMMARY });
  }

  async create(schoolId: SchoolId, staff: NewStaff): Promise<bigint> {
    const row = await this.txHost.tx.staff.create({
      data: { schoolId, ...staff, status: 'active' },
      select: { id: true },
    });
    return row.id;
  }
}
