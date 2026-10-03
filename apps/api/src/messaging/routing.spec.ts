// R106: the channel plan is a pure function of (type priority, contact capability, device,
// school WhatsApp status, SMS allowed); every cell of contracts/slice-9.md §7.3 is a row below.
// Predicates: D device, L login, W WhatsApp connected and a phone, P Pakistani mobile, A type in
// the allow list, E verified email. The cap is not an input (R109; the processor tests cover it).
import type { MessageChannel } from '@asms/shared';
import { isAfterFailureSms, planChannels, type PersonClass, type RoutingInput } from './routing';

type Flags = 'D' | 'L' | 'W' | 'P' | 'A' | 'E';

function input(person: PersonClass, priority: RoutingInput['priority'], flags: string): RoutingInput {
  const has = (f: Flags) => flags.includes(f);
  return {
    priority,
    person,
    hasDevice: has('D'),
    hasLogin: has('L'),
    // W needs a connected number and a phone; P implies a phone.
    hasPhone: has('W') || has('P'),
    hasSmsPhone: has('P'),
    whatsappConnected: has('W'),
    smsAllowed: has('A'),
    hasVerifiedEmail: has('E'),
  };
}

type Row = [PersonClass, RoutingInput['priority'], string, MessageChannel[], 'not_allowed' | null];

const ROWS: Row[] = [
  // guardian, whatsapp: urgent sends WhatsApp AND SMS together (R149), subject to A.
  ['guardian_whatsapp', 'urgent', 'DLWPA', ['whatsapp', 'sms', 'push', 'in_app'], null],
  ['guardian_whatsapp', 'urgent', 'LWPA', ['whatsapp', 'sms', 'in_app'], null],
  ['guardian_whatsapp', 'urgent', 'DLWP', ['whatsapp', 'push', 'in_app'], null],
  ['guardian_whatsapp', 'urgent', 'DLPA', ['sms', 'push', 'in_app'], null],
  ['guardian_whatsapp', 'urgent', 'P', [], 'not_allowed'],
  ['guardian_whatsapp', 'urgent', '', [], null],
  // normal, W: WhatsApp first, the sms* after-failure leg last.
  ['guardian_whatsapp', 'normal', 'DLWPA', ['whatsapp', 'push', 'in_app', 'sms'], null],
  ['guardian_whatsapp', 'normal', 'WP', ['whatsapp'], null],
  // normal, not W (number down, pending or absent): straight to the fallback (R112).
  ['guardian_whatsapp', 'normal', 'DLPA', ['push', 'in_app', 'sms'], null],
  ['guardian_whatsapp', 'normal', 'PA', ['sms'], null],
  ['guardian_whatsapp', 'normal', 'LP', ['in_app'], 'not_allowed'],
  ['guardian_whatsapp', 'normal', 'P', [], 'not_allowed'],
  // low never leaves the app (R138).
  ['guardian_whatsapp', 'low', 'DLWPA', ['push', 'in_app'], null],
  ['guardian_whatsapp', 'low', 'WPA', [], null],
  ['guardian_whatsapp', 'internal', 'DLWPAE', [], null],
  // guardian, smartphone_data.
  ['guardian_smartphone_data', 'urgent', 'DLPA', ['push', 'sms', 'in_app'], null],
  ['guardian_smartphone_data', 'urgent', 'DLP', ['push', 'in_app'], null],
  ['guardian_smartphone_data', 'normal', 'DLPA', ['push', 'in_app'], null],
  ['guardian_smartphone_data', 'normal', 'LPA', ['in_app', 'sms'], null],
  ['guardian_smartphone_data', 'normal', 'LP', ['in_app'], 'not_allowed'],
  ['guardian_smartphone_data', 'low', 'DLPA', ['push', 'in_app'], null],
  ['guardian_smartphone_data', 'low', 'PA', [], null],
  ['guardian_smartphone_data', 'internal', 'DLPAE', [], null],
  // guardian, keypad: SMS or nothing.
  ['guardian_keypad', 'urgent', 'DLWPA', ['sms'], null],
  ['guardian_keypad', 'urgent', 'DLWP', [], 'not_allowed'],
  ['guardian_keypad', 'normal', 'PA', ['sms'], null],
  ['guardian_keypad', 'normal', 'A', [], null],
  ['guardian_keypad', 'low', 'DLWPA', [], null],
  ['guardian_keypad', 'internal', 'DLWPAE', [], null],
  // staff.
  ['staff', 'urgent', 'DLPA', ['push', 'sms', 'in_app'], null],
  ['staff', 'urgent', 'LP', ['in_app'], 'not_allowed'],
  ['staff', 'normal', 'DLPA', ['push', 'in_app'], null],
  ['staff', 'normal', 'LPA', ['in_app', 'sms'], null],
  ['staff', 'low', 'DLPA', ['push', 'in_app'], null],
  ['staff', 'internal', 'DLPAE', ['push', 'in_app'], null],
  ['staff', 'internal', 'LPAE', ['email', 'in_app'], null],
  ['staff', 'internal', 'LPA', ['in_app'], null],
  ['staff', 'internal', '', [], null],
  // students never receive WhatsApp, SMS or email.
  ['student', 'urgent', 'DLWPAE', ['push', 'in_app'], null],
  ['student', 'normal', 'DLWPAE', ['push', 'in_app'], null],
  ['student', 'low', 'L', ['in_app'], null],
  ['student', 'internal', 'DLWPAE', [], null],
];

describe('R106: the routing matrix (contracts/slice-9.md §7.3)', () => {
  it.each(ROWS)('R106: %s x %s with [%s] plans %j', (person, priority, flags, legs, suppressed) => {
    const plan = planChannels(input(person, priority, flags));
    expect(plan.legs).toEqual(legs);
    expect(plan.suppressed).toEqual(
      suppressed === null ? [] : [{ channel: 'sms', reason: suppressed }],
    );
  });

  it('R106: every person class and priority has at least one row (no cell untested)', () => {
    const cells = new Set(ROWS.map(([p, pr]) => `${p}:${pr}`));
    for (const p of ['guardian_whatsapp', 'guardian_smartphone_data', 'guardian_keypad', 'staff', 'student']) {
      for (const pr of ['urgent', 'normal', 'low', 'internal']) expect(cells.has(`${p}:${pr}`)).toBe(true);
    }
  });

  it('R106: the plan is pure: the same inputs give the same plan', () => {
    const a = planChannels(input('guardian_whatsapp', 'normal', 'DLWPA'));
    const b = planChannels(input('guardian_whatsapp', 'normal', 'DLWPA'));
    expect(a).toEqual(b);
  });

  it('R112: sms after whatsapp in a normal plan is the after-failure leg; urgent SMS is always', () => {
    const normal = planChannels(input('guardian_whatsapp', 'normal', 'DLWPA')).legs;
    expect(isAfterFailureSms('normal', normal, normal.indexOf('sms'))).toBe(true);
    const urgent = planChannels(input('guardian_whatsapp', 'urgent', 'DLWPA')).legs;
    expect(isAfterFailureSms('urgent', urgent, urgent.indexOf('sms'))).toBe(false);
    const fallback = planChannels(input('guardian_whatsapp', 'normal', 'DLPA')).legs;
    expect(isAfterFailureSms('normal', fallback, fallback.indexOf('sms'))).toBe(false);
  });
});
