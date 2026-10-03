// contracts/slice-9.md §7.6 attempt budgets and permanent failures; §7.10 poll points; §9 the
// Sendpk response forms (assumed until the vendor answers, recorded in the contract).
import type { DeliveryRecord } from '../repositories/message-delivery.repository';
import { crossesPollPoint } from './delivery-sweeps';
import { sendpkSendOutcome, sendpkStatus } from './drivers/sms';
import { legState } from './legs';
import { rollUp } from './message-processor';

const T0 = new Date('2026-10-04T05:00:00Z');
const MIN = 60_000;
let id = 1n;
const row = (over: Partial<DeliveryRecord>): DeliveryRecord => ({
  id: id++,
  messageId: 1n,
  channel: 'whatsapp',
  attempt: 1,
  status: 'failed',
  errorCode: 'timeout',
  suppressedReason: null,
  attemptedAt: T0,
  failedAt: T0,
  ...over,
});

describe('leg state (§7.6)', () => {
  it('R112: WhatsApp gets three attempts over fifteen minutes, then the leg ends failed', () => {
    expect(legState('whatsapp', []).finished).toBe(false);
    expect(legState('whatsapp', [row({})]).dueAt).toEqual(new Date(T0.getTime() + 5 * MIN));
    expect(legState('whatsapp', [row({}), row({ attempt: 2 })]).dueAt).toEqual(new Date(T0.getTime() + 15 * MIN));
    const spent = legState('whatsapp', [row({}), row({ attempt: 2 }), row({ attempt: 3 })]);
    expect(spent).toMatchObject({ finished: true, succeeded: false });
  });

  it.each([
    ['whatsapp', 'not_on_whatsapp'],
    ['whatsapp', 'session_down'],
    ['sms', 'dnd_blocked'],
    ['push', 'unregistered_device'],
    ['email', 'rejected'],
  ] as const)('a %s %s failure is permanent', (channel, errorCode) => {
    expect(legState(channel, [row({ channel, errorCode })])).toMatchObject({ finished: true, succeeded: false });
  });

  it('a transient failure is retried; an accepted attempt ends the leg', () => {
    expect(legState('sms', [row({ channel: 'sms', errorCode: 'provider_unavailable' })]).finished).toBe(false);
    expect(legState('sms', [row({ channel: 'sms', status: 'accepted', errorCode: null, failedAt: null })]).succeeded).toBe(true);
  });

  it('R112: an accepted WhatsApp attempt later reported failed ends the leg (no retry)', () => {
    const reported = row({ status: 'failed', errorCode: 'rejected', failedAt: new Date(T0.getTime() + MIN) });
    expect(legState('whatsapp', [reported])).toMatchObject({ finished: true, succeeded: false });
    const transientReported = row({ errorCode: 'unknown', failedAt: new Date(T0.getTime() + MIN) });
    expect(legState('whatsapp', [transientReported]).finished).toBe(true);
  });

  it('roll-up: delivered beats sent beats failed beats suppressed (first suppressed reason)', () => {
    expect(rollUp([row({}), row({ status: 'delivered', channel: 'sms' })]).status).toBe('delivered');
    expect(rollUp([row({}), row({ status: 'accepted' })]).status).toBe('sent');
    expect(rollUp([row({})]).status).toBe('failed');
    expect(rollUp([row({ status: 'suppressed', suppressedReason: 'cap_reached', errorCode: null })])).toEqual({
      status: 'suppressed',
      reason: 'cap_reached',
    });
  });
});

describe('SMS poll points (§7.10)', () => {
  it.each([
    [0, 2, true],
    [2, 4, false],
    [8, 10, true],
    [28, 30, true],
    [118, 120, true],
    [200, 202, false],
    [238, 240, true],
    [358, 360, true],
  ])('a window (%i, %i] min crosses a poll point: %s', (from, to, expected) => {
    expect(crossesPollPoint(from * MIN, to * MIN)).toBe(expected);
  });
});

describe('Sendpk response forms (§9; vendor answers pending, assumptions recorded)', () => {
  it('only `OK ID:<n>` is accepted, with <n> as the reference', () => {
    expect(sendpkSendOutcome('OK ID:123456')).toEqual({ kind: 'accepted', ref: '123456' });
    expect(sendpkSendOutcome('  OK ID: 99 \n')).toEqual({ kind: 'accepted', ref: '99' });
  });

  it('anything else is a hard failure; the documented key error is auth_failed', () => {
    expect(sendpkSendOutcome('Invalid API Key')).toEqual({ kind: 'failed', error: 'auth_failed' });
    expect(sendpkSendOutcome('ERROR: insufficient balance')).toEqual({ kind: 'failed', error: 'rejected' });
    expect(sendpkSendOutcome('')).toEqual({ kind: 'failed', error: 'rejected' });
  });

  it('delivery words map forward-only to DeliveryStatus / DeliveryErrorCode', () => {
    expect(sendpkStatus('Delivered')).toEqual({ kind: 'delivered' });
    expect(sendpkStatus('UNDELIVERED')).toEqual({ kind: 'failed', error: 'rejected' });
    expect(sendpkStatus('Expired')).toEqual({ kind: 'failed', error: 'expired' });
    expect(sendpkStatus('DND blocked')).toEqual({ kind: 'failed', error: 'dnd_blocked' });
    expect(sendpkStatus('Submitted')).toEqual({ kind: 'pending' });
  });
});
