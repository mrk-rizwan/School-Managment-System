import { Injectable } from '@nestjs/common';
import { ANNOUNCEMENT_SMS_MAX_SEGMENTS, ErrorCode, messageTypeOf, type AnnouncementPriority } from '@asms/shared';
import { ApiException } from '../../common/errors/api-exception';
import { yearMonthIn } from '../../common/school-clock';
import { recipientKey } from '../../messaging/contacts';
import { NotificationService, type PlannedSend } from '../../messaging/notification.service';
import { isAfterFailureSms } from '../../messaging/routing';
import { composeAnnouncement, smsSegments, smsTextOf } from '../../messaging/templates';
import type { Recipient } from '../../messaging/types';
import { AnnouncementRecipientRepository } from '../../repositories/announcement-recipient.repository';
import { AnnouncementRepository, type AnnouncementRecord } from '../../repositories/announcement.repository';
import { MessageUsageRepository } from '../../repositories/message-usage.repository';
import {
  SchoolMessagingRepository,
  type SchoolMessagingSettings,
} from '../../repositories/school-messaging.repository';
import { WhatsAppNumberRepository } from '../../repositories/whatsapp-number.repository';
import type { SchoolId } from '../../tenancy/school-id';
import {
  AudienceResolver,
  AudienceRules,
  type AudienceItem,
  type Resolution,
  type ResolvedPerson,
  type SenderReach,
} from './audiences';

/** What the SMS facts of §4.5 are computed on. */
export interface SmsSubject {
  priority: AnnouncementPriority;
  holidayId: bigint | null;
  title: string;
  body: string;
  hasAttachment: boolean;
}

/** contracts/slice-14.md §4.5 (R109, R110): one computation for preview, create, patch and send. */
export interface SmsFacts {
  allowed: boolean;
  /** smsSegments(toGsm7(composed) [+ attachment line]). */
  segments: number;
  /**
   * Persons with an always-SMS leg (after-failure legs are not units); 0 when not allowed or
   * nobody is resolved; null when not counted (create and patch, a holiday publish, and a send now
   * whose upper bound already fits what the month has left).
   */
  legs: number | null;
  units: number | null;
  remaining: number;
  cap: number;
}

/**
 * How much of the channel plan a resolution computes. The plan resolves every person's contact
 * and live devices, so it is computed once per flow and only where it is used:
 * - `count`: the preview, when the type may travel by SMS (its legs are shown);
 * - `cap`: send now, only when the upper bound (every guardian and staff member on SMS) does not
 *   fit what the month has left, so the refusal is exact and the common case reads nothing more;
 * - `deliver`: the job, always: deliver() writes this plan as it stands;
 * - `none`: the holiday publish (counts for its audit; the job sends).
 */
export type PlanMode = 'count' | 'cap' | 'deliver' | 'none';

export interface DispatchInput {
  items: readonly AudienceItem[];
  /**
   * §4.2 against `reach`: `refuse` for a caller (create, patch, send, preview), `drop` for the
   * creator on the firing day (the scheduled job). Null: no check (a holiday notice, whose
   * authority is holiday.manage, and a send now the request already checked).
   */
  scope: { reach: SenderReach | null; mode: 'refuse' | 'drop' } | null;
  subject: SmsSubject;
  /** The resolution date (§4.3). */
  on: Date;
  plan: PlanMode;
  now?: Date;
}

/** One announcement resolved for a send: the kept items, the persons, the SMS facts and the plan. */
export interface Dispatch {
  items: AudienceItem[];
  /** Items the scope check dropped (`drop` mode only). */
  dropped: number;
  resolution: Resolution;
  facts: SmsFacts;
  /** The plan the legs were counted on, which deliver() writes; null when none was computed. */
  planned: PlannedSend | null;
}

export interface Delivered {
  dedupedByPhone: number;
  smsLegs: number;
  smsSegments: number;
}

const recipientOf = (p: ResolvedPerson): Recipient => p.person;

/** Persons whose plan has an SMS leg that is not the after-failure one (§4.5's units). */
const alwaysSmsLegs = (planned: PlannedSend): number =>
  planned.plans.filter((plan) =>
    plan.legs.some((leg, i) => leg === 'sms' && !isAfterFailureSms(planned.priority, plan.legs, i)),
  ).length;

/**
 * The parts of an announcement's send that the preview, send now, the job and the holiday notice
 * share: the scope check, resolution, the SMS facts (§4.5) and the write of §5.5 step 4.
 */
@Injectable()
export class AnnouncementDispatch {
  constructor(
    private readonly school: SchoolMessagingRepository,
    private readonly usage: MessageUsageRepository,
    private readonly notifications: NotificationService,
    private readonly announcements: AnnouncementRepository,
    private readonly recipients: AnnouncementRecipientRepository,
    private readonly numbers: WhatsAppNumberRepository,
    private readonly rules: AudienceRules,
    private readonly resolver: AudienceResolver,
  ) {}

  /** The school's live WhatsApp number is connected (R112: otherwise guardians go to the fallback). */
  async whatsappConnected(schoolId: SchoolId): Promise<boolean> {
    return (await this.numbers.findLive(schoolId))?.status === 'connected';
  }

  settings(schoolId: SchoolId): Promise<SchoolMessagingSettings> {
    return this.school.find(schoolId).then((settings) => {
      if (!settings) throw new Error('school row missing for a resolved tenant');
      return settings;
    });
  }

  /** §4.2 then §4.3 then §4.5, with as much of the plan as `input.plan` asks for. */
  async resolve(schoolId: SchoolId, input: DispatchInput): Promise<Dispatch> {
    const { kept, dropped } =
      input.scope === null
        ? { kept: [...input.items], dropped: 0 }
        : await this.rules.check(schoolId, input.items, input.scope.reach, input.scope.mode);
    const resolution = await this.resolver.resolve(schoolId, kept, input.on);
    const settings = await this.settings(schoolId);
    const type = messageTypeOf(input.subject);
    const { allowed, segments } = this.lengthOf(settings, input.subject);
    const cap = settings.smsMonthlyCap;
    const used = await this.usage.smsUsed(schoolId, yearMonthIn(settings.timezone, input.now ?? new Date()));
    const remaining = Math.max(cap - used, 0);

    const { persons } = resolution;
    // Students never have an SMS leg, so guardians and staff bound the legs from above.
    const bound = resolution.counts.guardians + resolution.counts.staff;
    const plan =
      persons.length > 0 &&
      (input.plan === 'deliver' ||
        (allowed && (input.plan === 'count' || (input.plan === 'cap' && bound * segments > remaining))));
    const planned = plan
      ? await this.notifications.plan(schoolId, { type, recipients: persons.map(recipientOf), dedupePhones: true })
      : null;
    const legs = !allowed || persons.length === 0 ? 0 : planned === null ? null : alwaysSmsLegs(planned);
    return {
      items: kept,
      dropped,
      resolution,
      facts: { allowed, segments, legs, units: legs === null ? null : legs * segments, remaining, cap },
      planned,
    };
  }

  /** §4.5's length facts without an audience (create, patch): the units are not known yet. */
  async smsFacts(schoolId: SchoolId, subject: SmsSubject): Promise<Pick<SmsFacts, 'allowed' | 'segments'>> {
    return this.lengthOf(await this.settings(schoolId), subject);
  }

  /** R110: an SMS-allowed type over three segments is 409 SMS_TOO_LONG (create, patch, send). */
  assertSmsLength(facts: Pick<SmsFacts, 'allowed' | 'segments'>): void {
    if (facts.allowed && facts.segments > ANNOUNCEMENT_SMS_MAX_SEGMENTS) {
      throw new ApiException(
        409,
        ErrorCode.SMS_TOO_LONG,
        `This announcement needs ${facts.segments} SMS segments; at most ${ANNOUNCEMENT_SMS_MAX_SEGMENTS} are allowed. Shorten it.`,
        { segments: facts.segments, maxSegments: ANNOUNCEMENT_SMS_MAX_SEGMENTS },
      );
    }
  }

  /**
   * §5.5 step 4 on a row already `sending`, in the job's transaction: one message per person
   * through NotificationService with the plan `resolve` computed (phones deduped), the recipient
   * rows carrying each person's message id, then `sent`. Jobs are enqueued after commit (R105).
   * The recipients are written after the messages instead of being back-filled: an UPDATE of
   * 3,000 rows through their freeze triggers cost seconds.
   */
  async deliver(
    schoolId: SchoolId,
    row: AnnouncementRecord,
    dispatch: Dispatch,
    now: Date = new Date(),
  ): Promise<{ sent: AnnouncementRecord; delivered: Delivered }> {
    const { persons } = dispatch.resolution;
    const { planned } = dispatch;
    if (persons.length > 0 && planned === null) throw new Error('deliver needs the plan resolve() computed');
    const settings = await this.settings(schoolId);
    const type = messageTypeOf(row);
    const body = composeAnnouncement(settings.name, row.title, row.body);
    const media =
      row.attachmentObjectKey === null || row.attachmentMime === null
        ? undefined
        : { objectKey: row.attachmentObjectKey, mime: row.attachmentMime };
    const result =
      planned === null
        ? null
        : await this.notifications.send(
            schoolId,
            {
              type,
              subject: { type: 'announcement', id: row.id },
              recipients: persons.map(recipientOf),
              vars: type === 'holiday_notice' ? HOLIDAY_VARS_UNUSED : {},
              body,
              title: row.title,
              ...(media === undefined ? {} : { media }),
              dedupePhones: true,
            },
            planned,
          );
    const messageOf = new Map((result?.messages ?? []).map((m) => [recipientKey(m.person), m.id]));
    await this.recipients.insert(
      schoolId,
      row.id,
      persons.map((p) => ({ ...p, messageId: messageOf.get(recipientKey(p.person)) ?? null })),
    );
    const sent = await this.announcements.markSent(schoolId, row.id, persons.length, now);
    return {
      sent,
      delivered: {
        dedupedByPhone: result?.dedupedByPhone ?? 0,
        smsLegs: planned === null ? 0 : alwaysSmsLegs(planned),
        smsSegments: smsSegments(smsTextOf(body, media !== undefined)),
      },
    };
  }

  private lengthOf(settings: SchoolMessagingSettings, subject: SmsSubject): Pick<SmsFacts, 'allowed' | 'segments'> {
    return {
      allowed: settings.smsAllowedTypes.includes(messageTypeOf(subject)),
      segments: smsSegments(
        smsTextOf(composeAnnouncement(settings.name, subject.title, subject.body), subject.hasAttachment),
      ),
    };
  }
}

/** The SMS facts' subject of a stored row. */
export const subjectOf = (row: AnnouncementRecord): SmsSubject => ({
  priority: row.priority,
  holidayId: row.holidayId,
  title: row.title,
  body: row.body,
  hasAttachment: row.attachmentObjectKey !== null,
});

/**
 * The holiday_notice template's vars are never rendered for an announcement-carried notice (the
 * composed body is given); the type still asks for them.
 */
const HOLIDAY_VARS_UNUSED = { name: '', startsOn: new Date(0), endsOn: new Date(0) };
