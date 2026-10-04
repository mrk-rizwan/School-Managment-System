import { Injectable } from '@nestjs/common';
import {
  MESSAGE_TYPE_TABLE,
  type MessageChannel,
  type MessageType,
  type SuppressionReason,
} from '@asms/shared';
import { MessageDeliveryRepository, type NewDelivery } from '../repositories/message-delivery.repository';
import { MessageRepository, personOf, type NewMessage } from '../repositories/message.repository';
import {
  SchoolMessagingRepository,
  type SchoolMessagingSettings,
} from '../repositories/school-messaging.repository';
import { WhatsAppNumberRepository } from '../repositories/whatsapp-number.repository';
import type { SchoolId } from '../tenancy/school-id';
import { ContactResolver, recipientKey as keyOf, type Contact } from './contacts';
import { OutboxDispatcher } from './outbox-dispatcher';
import { externalLegs, planChannels, type ChannelPlan } from './routing';
import { renderMessage } from './templates';
import type { Recipient, SendInput, SendResult, TemplateVarsMap } from './types';

/** A Pakistani mobile: the only numbers an SMS leg is planned for (predicate P, §7.3). */
export const PK_MOBILE = /^\+923[0-9]{9}$/;

/** The channel a messaging test asks for (contracts/slice-9.md §5.1). */
export type TestChannel = 'whatsapp' | 'sms' | 'push';

/** What send() would write for each person (NotificationService.plan). */
export interface PlannedSend {
  priority: Exclude<NewMessage['priority'], 'platform'>;
  people: Contact[];
  /** Parallel to `people`. */
  plans: ChannelPlan[];
  smsAllowed: boolean;
  whatsappConnected: boolean;
  dedupedByPhone: number;
}

type PlanInput = Pick<SendInput<MessageType>, 'type' | 'recipients' | 'dedupePhones'>;

const PHONE_LEGS: ReadonlySet<MessageChannel> = new Set(['whatsapp', 'sms']);

/**
 * contracts/slice-14.md §4.3 step 3, §4.4: among people sharing one phone, one keeps the phone. The
 * keeper is the first (input order) whose plan carries a WhatsApp leg, else the first with an SMS
 * leg; the others lose only the phone legs the keeper carries, so a shared phone is never left with
 * no outside message (a keypad parent first on a type SMS may not carry does not starve a WhatsApp
 * parent after them). Nobody carrying a phone leg: nothing is stripped. One left with no leg at all
 * is suppressed `duplicate_phone` with a delivery row on the stripped channel, so the row always
 * names a phone that was in fact messaged ("two guardians on one phone: one WhatsApp, two inbox
 * rows"). A person with a login keeps push and the inbox. Students have no phone on record.
 * Replaces entries of `plans`; returns how many people lost a leg.
 */
function dedupePhones(people: readonly Contact[], plans: ChannelPlan[]): number {
  const sharers = new Map<string, number[]>();
  people.forEach((person, i) => {
    if (person.phone === null) return;
    const list = sharers.get(person.phone) ?? [];
    list.push(i);
    sharers.set(person.phone, list);
  });
  const carries = (i: number, leg: MessageChannel): boolean => plans[i]?.legs.includes(leg) ?? false;
  let deduped = 0;
  for (const indices of sharers.values()) {
    if (indices.length < 2) continue;
    const keeper = indices.find((i) => carries(i, 'whatsapp')) ?? indices.find((i) => carries(i, 'sms'));
    if (keeper === undefined) continue;
    const kept = new Set((plans[keeper]?.legs ?? []).filter((leg) => PHONE_LEGS.has(leg)));
    for (const i of indices) {
      const plan = plans[i];
      if (i === keeper || plan === undefined) continue;
      const stripped = plan.legs.filter((leg) => kept.has(leg));
      if (stripped.length === 0) continue;
      deduped++;
      const legs = plan.legs.filter((leg) => !kept.has(leg));
      const channel: MessageChannel = stripped.includes('whatsapp') ? 'whatsapp' : 'sms';
      plans[i] = { legs, suppressed: legs.length === 0 ? [{ channel, reason: 'duplicate_phone' }] : [] };
    }
  }
  return deduped;
}

/**
 * The only way a message reaches a person (plan rule 0.11, contracts/slice-9.md §7.1). Runs inside
 * the sender's @Transactional(): writes one `messages` row per person, idempotent per subject
 * (R107: INSERT ... ON CONFLICT DO NOTHING on the partial uniques), with the body rendered and the
 * channel plan computed now (R106), and registers external legs for enqueue after commit (R105).
 * The phone is not stored: the processor reads the person's current phone at attempt time.
 */
@Injectable()
export class NotificationService {
  constructor(
    private readonly outbox: OutboxDispatcher,
    private readonly school: SchoolMessagingRepository,
    private readonly numbers: WhatsAppNumberRepository,
    private readonly contacts: ContactResolver,
    private readonly messages: MessageRepository,
    private readonly deliveries: MessageDeliveryRepository,
  ) {}

  /**
   * `planned`, when given, is plan() of this same input computed earlier in the caller's
   * transaction (the announcement send counts its SMS units on it); it is written as it stands
   * instead of resolving the contacts and devices a second time.
   */
  async send<T extends MessageType>(
    schoolId: SchoolId,
    input: SendInput<T>,
    planned?: PlannedSend,
  ): Promise<SendResult> {
    this.outbox.requireTransaction();
    const spec = MESSAGE_TYPE_TABLE[input.type];
    if (spec.priority === 'platform') {
      throw new Error(`${input.type} has no messages row; it is not sent through send()`);
    }
    if (!spec.subjectTypes.includes(input.subject.type)) {
      throw new Error(`${input.type} cannot carry subject type ${input.subject.type}`);
    }
    // contracts/slice-14.md §4.4: only an announcement-carried message has its own title or
    // shares phones across recipients.
    if ((input.title !== undefined || input.dedupePhones) && input.subject.type !== 'announcement') {
      throw new Error('title and dedupePhones are for announcement-carried messages only');
    }
    const settings = await this.school.find(schoolId);
    if (!settings) throw new Error('school row missing for a resolved tenant');
    const body = this.render(input.type, input.vars, settings, input.subject.type, input.body);
    const plan = planned ?? (await this.planFor(schoolId, settings, input));
    if (plan.people.length !== new Set(input.recipients.map(keyOf)).size) {
      throw new Error('a precomputed plan is not of these recipients');
    }
    const written = await this.write(schoolId, {
      type: input.type,
      priority: plan.priority,
      subject: input.subject,
      body,
      title: input.title ?? null,
      mediaObjectKey: input.media?.objectKey ?? null,
      firstChannel: spec.channels[0] ?? 'push',
      people: plan.people,
      plans: plan.plans,
    });
    return { ...written, dedupedByPhone: plan.dedupedByPhone };
  }

  /**
   * The channel plan send() would write for these recipients now, writing nothing: the
   * announcement preview and send-time SMS count use the real predicates per person
   * (contracts/slice-14.md §4.5). Usable outside a transaction.
   */
  async plan(schoolId: SchoolId, input: PlanInput): Promise<PlannedSend> {
    const settings = await this.school.find(schoolId);
    if (!settings) throw new Error('school row missing for a resolved tenant');
    return this.planFor(schoolId, settings, input);
  }

  /**
   * POST /messaging/test (§5.1): a `messaging_test` to the caller's own staff record on the
   * requested channel. The plan overrides §7.3: push -> [push] (no live device -> suppressed
   * no_channel); sms -> [sms]; whatsapp -> [whatsapp, sms after failure]. It bypasses the allow
   * list and counts against the cap (the processor's SMS leg).
   */
  async sendTest(
    schoolId: SchoolId,
    input: {
      staffId: bigint;
      channel: TestChannel;
      auditId: bigint;
      vars: TemplateVarsMap['messaging_test'];
    },
  ): Promise<{ messageId: bigint }> {
    this.outbox.requireTransaction();
    const settings = await this.school.find(schoolId);
    if (!settings) throw new Error('school row missing for a resolved tenant');
    const body = this.render('messaging_test', input.vars, settings, 'messaging_test');
    const [person] = await this.resolve(schoolId, settings, [{ staffId: input.staffId }]);
    if (!person) throw new Error('test recipient missing');
    let legs: MessageChannel[];
    if (input.channel === 'push') {
      const withDevice = await this.usersWithDevice(schoolId, [person]);
      legs = person.userId !== null && withDevice.has(person.userId) ? ['push'] : [];
    } else {
      legs = input.channel === 'sms' ? ['sms'] : ['whatsapp', 'sms'];
    }
    await this.write(schoolId, {
      type: 'messaging_test',
      priority: 'normal',
      subject: { type: 'messaging_test', id: input.auditId },
      body,
      title: null,
      mediaObjectKey: null,
      firstChannel: input.channel,
      people: [person],
      plans: [{ legs, suppressed: [] }],
    });
    const [row] = await this.messages.findBySubject(schoolId, 'messaging_test', input.auditId);
    if (!row) throw new Error('test message not written');
    return { messageId: row };
  }

  private async planFor(
    schoolId: SchoolId,
    settings: SchoolMessagingSettings,
    input: PlanInput,
  ): Promise<PlannedSend> {
    const priority = MESSAGE_TYPE_TABLE[input.type].priority;
    if (priority === 'platform') throw new Error(`${input.type} is not planned per person`);
    const people = await this.resolve(schoolId, settings, input.recipients);
    const live = await this.numbers.findLive(schoolId);
    const whatsappConnected = live?.status === 'connected';
    const smsAllowed = settings.smsAllowedTypes.includes(input.type);
    const withDevice = await this.usersWithDevice(schoolId, people);

    const plans = people.map((p) =>
      planChannels({
        priority,
        person: p.person,
        hasDevice: p.userId !== null && withDevice.has(p.userId),
        hasLogin: p.userId !== null,
        hasPhone: p.phone !== null,
        hasSmsPhone: p.phone !== null && PK_MOBILE.test(p.phone),
        whatsappConnected,
        smsAllowed,
        hasVerifiedEmail: p.email !== null,
      }),
    );
    const dedupedByPhone = input.dedupePhones ? dedupePhones(people, plans) : 0;
    return { priority, people, plans, smsAllowed, whatsappConnected, dedupedByPhone };
  }

  /** The stored body: the sender's own (announcements) or the type's template. */
  private render<T extends MessageType>(
    type: T,
    vars: TemplateVarsMap[T],
    settings: { name: string; timezone: string },
    subjectType: SendInput<T>['subject']['type'],
    body?: string,
  ): string {
    if (body !== undefined) return body;
    return renderMessage(type, vars, { schoolName: settings.name, timezone: settings.timezone, subjectType }).body;
  }

  /** One contact per person (dedupe within the call), through the shared ContactResolver. */
  private async resolve(
    schoolId: SchoolId,
    settings: SchoolMessagingSettings,
    recipients: readonly Recipient[],
  ): Promise<Contact[]> {
    const unique = new Map<string, Recipient>();
    for (const r of recipients) unique.set(keyOf(r), r);
    const all = [...unique.values()];
    const found = await this.contacts.resolve(schoolId, all, settings.studentLoginEnabled);
    return all.map((recipient): Contact => {
      const contact = found.get(keyOf(recipient));
      if (!contact) throw new Error('recipient not in this school');
      // Senders resolve survivors (§7.1): a merged guardian is a sender bug.
      if (contact.merged) throw new Error('a merged guardian cannot receive a message');
      return contact;
    });
  }

  /** Users with a live push device (§1.5 join; idle window by staff capacity). */
  private async usersWithDevice(schoolId: SchoolId, people: readonly Contact[]): Promise<Set<bigint>> {
    const devices = await this.contacts.liveDevices(schoolId, people, new Date());
    return new Set(devices.map((device) => device.userId));
  }

  private async write(
    schoolId: SchoolId,
    input: {
      type: MessageType;
      priority: NewMessage['priority'];
      subject: SendInput<MessageType>['subject'];
      body: string;
      title: string | null;
      mediaObjectKey: string | null;
      firstChannel: MessageChannel;
      people: readonly Contact[];
      plans: readonly ChannelPlan[];
    },
  ): Promise<Omit<SendResult, 'dedupedByPhone'>> {
    const now = new Date();
    const rows: NewMessage[] = input.people.map((p, i) => {
      const plan = input.plans[i] ?? { legs: [], suppressed: [] };
      const external = externalLegs(plan.legs);
      const suppressed: SuppressionReason | null =
        plan.legs.length === 0 ? (plan.suppressed[0]?.reason ?? 'no_channel') : null;
      return {
        type: input.type,
        priority: input.priority,
        subjectType: input.subject.type,
        subjectId: input.subject.id,
        guardianId: 'guardianId' in p.recipient ? p.recipient.guardianId : null,
        staffId: 'staffId' in p.recipient ? p.recipient.staffId : null,
        studentId: 'studentId' in p.recipient ? p.recipient.studentId : null,
        body: input.body,
        title: input.title,
        mediaObjectKey: input.mediaObjectKey,
        channelPlan: plan.legs,
        status: external.length > 0 ? 'queued' : suppressed ? 'suppressed' : 'sent',
        suppressedReason: suppressed,
        finishedAt: external.length > 0 ? null : now,
      };
    });
    const inserted = await this.messages.insertMany(schoolId, rows);

    // Write-time suppressions are delivery rows with their reason (§7.4).
    const planByPerson = new Map(input.people.map((p, i) => [keyOf(p.recipient), input.plans[i]]));
    const suppressedRows: NewDelivery[] = [];
    for (const row of inserted) {
      const plan = planByPerson.get(
        keyOf(
          row.guardianId !== null
            ? { guardianId: row.guardianId }
            : row.staffId !== null
              ? { staffId: row.staffId }
              : { studentId: row.studentId ?? 0n },
        ),
      );
      const legs = plan?.suppressed.length
        ? plan.suppressed
        : row.status === 'suppressed'
          ? [{ channel: input.firstChannel, reason: row.suppressedReason ?? 'no_channel' }]
          : [];
      for (const leg of legs) {
        if (leg.channel === 'in_app') continue;
        suppressedRows.push({
          messageId: row.id,
          channel: leg.channel,
          attempt: 1,
          status: 'suppressed',
          providerRefHash: null,
          pollRef: null,
          toMasked: null,
          errorCode: null,
          suppressedReason: leg.reason,
          segments: null,
          attemptedAt: now,
        });
      }
    }
    await this.deliveries.insertMany(schoolId, suppressedRows);
    this.outbox.messagesAfterCommit(
      schoolId,
      inserted.filter((row) => row.status === 'queued').map((row) => row.id),
    );
    return {
      created: inserted.length,
      existing: rows.length - inserted.length,
      messages: inserted.map((row) => ({ id: row.id, person: personOf(row) })),
    };
  }
}
