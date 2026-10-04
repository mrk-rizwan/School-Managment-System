import { MESSAGE_SUBJECT_TYPES } from '@asms/shared';
import { HOME_ROUTE, routeForNotification } from './routing';

const withInbox = () => true;
const slice15 = (tab: string) => tab !== 'inbox';

const data = (subjectType: string) => ({
  type: 'announcement',
  subjectType,
  subjectId: '12',
  messageId: '345',
});

describe('routeForNotification (slice-15 §8)', () => {
  test.each(MESSAGE_SUBJECT_TYPES.map((s) => [s]))(
    '%s → the inbox item when the inbox screen exists',
    (subjectType) => {
      expect(routeForNotification(data(subjectType), withInbox)).toBe('/inbox/345');
    },
  );

  test.each(MESSAGE_SUBJECT_TYPES.map((s) => [s]))(
    '%s → home until the inbox screen ships (slice 16)',
    (subjectType) => {
      expect(routeForNotification(data(subjectType), slice15)).toBe(HOME_ROUTE);
    },
  );

  test.each([
    ['null', null],
    ['a string', 'hello'],
    ['an unknown subject type', data('wormhole')],
    ['a non-numeric message id', { ...data('announcement'), messageId: '../../etc' }],
    ['a missing message id', { type: 'x', subjectType: 'announcement', subjectId: '1' }],
    ['an empty object', {}],
  ])('malformed (%s) → home', (_name, payload) => {
    expect(routeForNotification(payload, withInbox)).toBe(HOME_ROUTE);
  });
});
