import { Injectable } from '@nestjs/common';
import { sessionLifetime } from '../common/auth/school-session';
import { DeviceRepository, type LiveDevice } from '../repositories/device.repository';
import {
  MessageRecipientRepository,
  type GuardianContact,
} from '../repositories/message-recipient.repository';
import type { SchoolId } from '../tenancy/school-id';
import type { PersonClass } from './routing';
import type { Recipient } from './types';

/**
 * A person as messaging sees them now (contracts/slice-9.md §7.1, §7.3): the routing class, the
 * login that push goes to, the current phone and a verified email. Read at write time by
 * NotificationService and again at attempt time by the processor, through this one resolver, so
 * the two never disagree about who a person is or how to reach them.
 */
export interface Contact {
  recipient: Recipient;
  person: PersonClass;
  /** The active login push goes to (with the capacity matching the person). */
  userId: bigint | null;
  /** The login also carries a staff record: push uses the staff idle window (§1.5). */
  userHasStaff: boolean;
  /** Guardians and staff; never a student's (the phone on record is a guardian's). */
  phone: string | null;
  /** A verified staff address only (predicate E). */
  email: string | null;
  /** A guardian folded into another (rule 12); senders address the survivor (§7.1). */
  merged: boolean;
}

export const recipientKey = (r: Recipient): string =>
  'guardianId' in r ? `g${r.guardianId}` : 'staffId' in r ? `s${r.staffId}` : `t${r.studentId}`;

/** A merge chain longer than this is a data fault; its guardian is dropped, not followed. */
const MAX_MERGE_HOPS = 10;

@Injectable()
export class ContactResolver {
  constructor(
    private readonly people: MessageRecipientRepository,
    private readonly devices: DeviceRepository,
  ) {}

  /**
   * Each recipient's contact, keyed by recipientKey; a recipient not in this school is absent.
   * Three set-based reads, one per kind. `studentLoginEnabled` is the school's setting.
   */
  async resolve(
    schoolId: SchoolId,
    recipients: readonly Recipient[],
    studentLoginEnabled: boolean,
  ): Promise<Map<string, Contact>> {
    const guardianIds = recipients.flatMap((r) => ('guardianId' in r ? [r.guardianId] : []));
    const staffIds = recipients.flatMap((r) => ('staffId' in r ? [r.staffId] : []));
    const studentIds = recipients.flatMap((r) => ('studentId' in r ? [r.studentId] : []));
    const contacts = new Map<string, Contact>();
    for (const g of await this.people.guardians(schoolId, guardianIds)) {
      const recipient = { guardianId: g.id };
      contacts.set(recipientKey(recipient), {
        recipient,
        person: `guardian_${g.contactCapability}`,
        userId: g.userId,
        userHasStaff: g.userHasStaff,
        phone: g.phone,
        email: null,
        merged: g.status === 'merged',
      });
    }
    for (const s of await this.people.staff(schoolId, staffIds)) {
      const recipient = { staffId: s.id };
      contacts.set(recipientKey(recipient), {
        recipient,
        person: 'staff',
        userId: s.userId,
        userHasStaff: true,
        phone: s.phone,
        email: s.verifiedEmail,
        merged: false,
      });
    }
    for (const t of await this.people.students(schoolId, studentIds, studentLoginEnabled)) {
      const recipient = { studentId: t.id };
      // Students never get WhatsApp, SMS or email: the phone on record is a guardian's.
      contacts.set(recipientKey(recipient), {
        recipient,
        person: 'student',
        userId: t.userId,
        userHasStaff: t.userHasStaff,
        phone: null,
        email: null,
        merged: false,
      });
    }
    return contacts;
  }

  /**
   * The live push devices of these people's logins (§1.5, R115): a device whose session is live
   * within the idle window of the login's capacities (staff or not).
   */
  async liveDevices(
    schoolId: SchoolId,
    contacts: readonly Pick<Contact, 'userId' | 'userHasStaff'>[],
    now: Date,
  ): Promise<LiveDevice[]> {
    const found: LiveDevice[] = [];
    for (const staff of [true, false]) {
      const userIds = [
        ...new Set(contacts.flatMap((c) => (c.userId !== null && c.userHasStaff === staff ? [c.userId] : []))),
      ];
      const { idleMs } = sessionLifetime('bearer', { staff });
      found.push(...(await this.devices.liveForUsers(schoolId, userIds, idleMs, now)));
    }
    return found;
  }

  /**
   * The people to address now for people addressed before (a follow-up such as a holiday's
   * cancellation, contracts/slice-10.md §4.6): a guardian merged since becomes the survivor (the
   * merged_into_id chain followed); staff who have left and people no longer in the school are
   * dropped; duplicates collapse. Order is kept, by first appearance.
   */
  async survivors(schoolId: SchoolId, recipients: readonly Recipient[]): Promise<Recipient[]> {
    const guardianIds = recipients.flatMap((r) => ('guardianId' in r ? [r.guardianId] : []));
    const survivorOf = await this.guardianSurvivors(schoolId, guardianIds);
    const staffIds = recipients.flatMap((r) => ('staffId' in r ? [r.staffId] : []));
    const reachableStaff = new Set(
      (await this.people.staff(schoolId, staffIds)).filter((s) => s.status !== 'left').map((s) => s.id),
    );
    const out = new Map<string, Recipient>();
    for (const r of recipients) {
      let next: Recipient | null = r;
      if ('guardianId' in r) {
        const survivor = survivorOf.get(r.guardianId);
        next = survivor === undefined ? null : { guardianId: survivor };
      } else if ('staffId' in r) {
        next = reachableStaff.has(r.staffId) ? r : null;
      }
      if (next !== null && !out.has(recipientKey(next))) out.set(recipientKey(next), next);
    }
    return [...out.values()];
  }

  /** Guardian id -> its active survivor (itself when not merged); absent when unresolvable. */
  private async guardianSurvivors(schoolId: SchoolId, ids: readonly bigint[]): Promise<Map<bigint, bigint>> {
    const result = new Map<bigint, bigint>();
    // Each original id points at the guardian it currently resolves to.
    let pointing = new Map<bigint, bigint>(ids.map((id) => [id, id]));
    for (let hop = 0; hop <= MAX_MERGE_HOPS && pointing.size > 0; hop++) {
      const rows = new Map<bigint, GuardianContact>(
        (await this.people.guardians(schoolId, [...new Set(pointing.values())])).map((g) => [g.id, g]),
      );
      const next = new Map<bigint, bigint>();
      for (const [original, current] of pointing) {
        const row = rows.get(current);
        if (!row) continue;
        if (row.status !== 'merged') result.set(original, row.id);
        else if (row.mergedIntoId !== null) next.set(original, row.mergedIntoId);
      }
      pointing = next;
    }
    return result;
  }
}
