// The routing matrix (contracts/slice-9.md §7.3, normative; R106): a pure function from the
// message's priority, the person's class and the write-time predicates to the ordered channel
// plan. Every cell has a test (src/messaging/routing.spec.ts). The SMS cap is not an input: it
// is checked atomically when an SMS leg runs (§7.7).
import {
  EXTERNAL_CHANNELS,
  type MessageChannel,
  type MessagePriority,
  type SuppressionReason,
} from '@asms/shared';

/** The person's routing class: a guardian by contact capability (rule 17), staff or student. */
export type PersonClass =
  | 'guardian_whatsapp'
  | 'guardian_smartphone_data'
  | 'guardian_keypad'
  | 'staff'
  | 'student';

export interface RoutingInput {
  priority: Exclude<MessagePriority, 'platform'>;
  person: PersonClass;
  /** D: the person's user has a live device (§1.5 join). */
  hasDevice: boolean;
  /** L: a login with the matching capacity. */
  hasLogin: boolean;
  /** The person has a phone (WhatsApp needs any; with `whatsappConnected` it is predicate W). */
  hasPhone: boolean;
  /** P for SMS: a Pakistani mobile (+923...). */
  hasSmsPhone: boolean;
  /** The school's live WhatsApp row is `connected`. */
  whatsappConnected: boolean;
  /** A: the type is in the school's smsAllowedTypes. */
  smsAllowed: boolean;
  /** E: a verified email (staff only). */
  hasVerifiedEmail: boolean;
}

export interface ChannelPlan {
  /** The legs in order; `in_app` marks inbox visibility and never produces a delivery row. */
  legs: MessageChannel[];
  /**
   * Legs refused at write time, recorded as `suppressed` delivery rows (§7.4): an SMS leg the
   * allow list removed when it was the person's only external leg.
   */
  suppressed: { channel: MessageChannel; reason: SuppressionReason }[];
}

const EXTERNAL: ReadonlySet<MessageChannel> = new Set(EXTERNAL_CHANNELS);

/** The plan's legs that leave the platform (everything but `in_app`). */
export const externalLegs = (legs: readonly MessageChannel[]): MessageChannel[] =>
  legs.filter((leg) => EXTERNAL.has(leg));

/**
 * A plan is built from candidate legs: each is present when its predicate holds. An SMS leg whose
 * only failing predicate is A is noted, and recorded as `suppressed: not_allowed` when the plan is
 * left with no other external leg (§7.4).
 */
export function planChannels(input: RoutingInput): ChannelPlan {
  const { hasDevice: D, hasLogin: L, hasSmsPhone: P, smsAllowed: A, hasVerifiedEmail: E } = input;
  const W = input.whatsappConnected && input.hasPhone;
  const legs: MessageChannel[] = [];
  let smsRefused = false;
  /** An SMS leg whose other conditions are `others`. */
  const sms = (others: boolean): void => {
    if (!others || !P) return;
    if (A) legs.push('sms');
    else smsRefused = true;
  };
  const add = (channel: MessageChannel, when: boolean): void => {
    if (when) legs.push(channel);
  };

  const { priority, person } = input;
  switch (person) {
    case 'guardian_whatsapp':
      if (priority === 'urgent') {
        add('whatsapp', W);
        sms(true);
        add('push', D);
        add('in_app', L);
      } else if (priority === 'normal') {
        if (W) {
          // sms after whatsapp in a normal plan is the after-failure leg (sms*).
          add('whatsapp', true);
          add('push', D);
          add('in_app', L);
          sms(true);
        } else {
          add('push', D);
          add('in_app', L);
          sms(true);
        }
      } else if (priority === 'low') {
        add('push', D);
        add('in_app', L);
      }
      break;
    case 'guardian_smartphone_data':
      if (priority === 'urgent') {
        add('push', D);
        sms(true);
        add('in_app', L);
      } else if (priority === 'normal') {
        add('push', D);
        add('in_app', L);
        sms(!D);
      } else if (priority === 'low') {
        add('push', D);
        add('in_app', L);
      }
      break;
    case 'guardian_keypad':
      if (priority === 'urgent' || priority === 'normal') sms(true);
      break;
    case 'staff':
      if (priority === 'urgent') {
        add('push', D);
        sms(true);
        add('in_app', L);
      } else if (priority === 'normal') {
        add('push', D);
        add('in_app', L);
        sms(!D);
      } else if (priority === 'low') {
        add('push', D);
        add('in_app', L);
      } else {
        add('push', D);
        add('email', !D && E);
        add('in_app', L);
      }
      break;
    case 'student':
      // Students never receive WhatsApp, SMS or email; internal notices are staff-only.
      if (priority !== 'internal') {
        add('push', D);
        add('in_app', L);
      }
      break;
  }

  const suppressed: ChannelPlan['suppressed'] =
    smsRefused && externalLegs(legs).length === 0
      ? [{ channel: 'sms', reason: 'not_allowed' }]
      : [];
  return { legs, suppressed };
}

/**
 * Whether `leg` at `index` is the after-failure SMS leg (sms*): an SMS leg that follows a
 * WhatsApp leg in a `normal` plan. Derived, never stored (§7.3).
 */
export function isAfterFailureSms(
  priority: MessagePriority,
  legs: readonly MessageChannel[],
  index: number,
): boolean {
  return (
    legs[index] === 'sms' && priority === 'normal' && legs.slice(0, index).includes('whatsapp')
  );
}
