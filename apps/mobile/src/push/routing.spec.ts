import { MESSAGE_SUBJECT_TYPES } from '@asms/shared';
import type { TabId } from '../auth/tabs';
import { HOME_ROUTE, routeForNotification } from './routing';

// slice-15 §8 and slice-16 §2: the routing table is normative; every row is a test.

const everyScreen = () => true;
/** 16a: every screen but the three 16b tabs. */
const slice16a = (tab: TabId) => !['inbox', 'today', 'announce'].includes(tab);

const data = (subjectType: string) => ({
  type: 'announcement',
  subjectType,
  subjectId: '12',
  messageId: '345',
});

const parent: TabId[] = ['home', 'children', 'inbox', 'calendar', 'account'];
const student: TabId[] = ['home', 'student', 'inbox', 'calendar', 'account'];
const teacher: TabId[] = ['home', 'classes', 'inbox', 'calendar', 'account'];
const principal: TabId[] = ['home', 'today', 'announce', 'inbox', 'calendar', 'account'];

describe('inbox types → the inbox item when the inbox screen exists and the user has it', () => {
  test.each(['announcement', 'holiday', 'holiday_cancellation', 'sms_cap', 'messaging_test'])(
    '%s',
    (subjectType) => {
      expect(routeForNotification(data(subjectType), everyScreen, parent)).toBe('/inbox/345');
      expect(routeForNotification(data(subjectType), slice16a, parent)).toBe(HOME_ROUTE);
      expect(routeForNotification(data(subjectType), everyScreen, ['home'])).toBe(HOME_ROUTE);
    },
  );
});

describe('child-linked types', () => {
  test.each(['attendance_alert', 'diary_entry', 'remark'])('%s → the inbox item (16b)', (s) => {
    expect(routeForNotification(data(s), everyScreen, parent)).toBe('/inbox/345');
  });

  test.each(['attendance_alert', 'diary_entry', 'remark'])(
    '%s, 16a interim: a guardian → /children',
    (s) => {
      expect(routeForNotification(data(s), slice16a, parent)).toBe('/children');
    },
  );

  test.each([
    ['attendance_alert', '/student/attendance'],
    ['diary_entry', '/student/diary'],
    ['remark', '/student/remarks'],
  ])('%s, 16a interim: only a student → %s', (s, route) => {
    expect(routeForNotification(data(s), slice16a, student)).toBe(route);
  });

  test('16a interim: neither guardian nor student → home', () => {
    expect(routeForNotification(data('remark'), slice16a, teacher)).toBe(HOME_ROUTE);
  });
});

test('register_deadline → /today when registered and held, else home', () => {
  expect(routeForNotification(data('register_deadline'), everyScreen, principal)).toBe('/today');
  expect(routeForNotification(data('register_deadline'), slice16a, principal)).toBe(HOME_ROUTE);
  expect(routeForNotification(data('register_deadline'), everyScreen, teacher)).toBe(HOME_ROUTE);
});

test('teacher_assignment (cover_assigned) → /classes when the user has it, else home', () => {
  expect(routeForNotification(data('teacher_assignment'), slice16a, teacher)).toBe('/classes');
  expect(routeForNotification(data('teacher_assignment'), slice16a, principal)).toBe(HOME_ROUTE);
});

test('every subject type routes somewhere the user has', () => {
  for (const subjectType of MESSAGE_SUBJECT_TYPES) {
    for (const tabs of [parent, student, teacher, principal]) {
      const route = routeForNotification(data(subjectType), everyScreen, tabs);
      const tab = route.split('/')[1] as TabId;
      expect(tabs).toContain(tab);
    }
  }
});

test.each([
  ['null', null],
  ['a string', 'hello'],
  ['an unknown subject type', data('wormhole')],
  ['a non-numeric message id', { ...data('announcement'), messageId: '../../etc' }],
  ['a missing message id', { type: 'x', subjectType: 'announcement', subjectId: '1' }],
  ['an empty object', {}],
])('malformed (%s) → home', (_name, payload) => {
  expect(routeForNotification(payload, everyScreen, parent)).toBe(HOME_ROUTE);
});
