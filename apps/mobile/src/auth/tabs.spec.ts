import { Capability, SYSTEM_ROLE_DEFAULTS } from '@asms/shared';
import type { MeAssignmentDto } from '../api/contracts';
import { hasScreen, SCREEN_REGISTRY } from './screen-registry';
import { composeTabs, layoutTabs, TAB_ORDER, type TabSource } from './tabs';

// slice-15 §5: every fixture asserts the exact ordered list and the five-slot layout.

const C = Capability;

function assignment(role: MeAssignmentDto['role']): MeAssignmentDto {
  return {
    id: '1',
    role,
    academicYearId: '1',
    classId: '1',
    className: 'Class 5',
    sectionId: '1',
    sectionName: 'A',
    subjectId: role === 'subject_teacher' ? '3' : null,
    subjectName: role === 'subject_teacher' ? 'Maths' : null,
    attendanceMode: 'daily',
    startsOn: '2026-04-01',
    endsOn: null,
  };
}

const principal = [...SYSTEM_ROLE_DEFAULTS.principal];
const office = [...SYSTEM_ROLE_DEFAULTS.office_staff];
const teacher = [...SYSTEM_ROLE_DEFAULTS.teacher];

const fixtures: Record<string, { me: TabSource; tabs: string[]; bar: string[]; more: string[] }> = {
  // Slice 27: Approvals second, so Inbox moves under More with Calendar and Account.
  principal: {
    me: { capacities: ['staff'], capabilities: principal, assignments: [] },
    tabs: ['home', 'approvals', 'today', 'announce', 'inbox', 'calendar', 'account'],
    bar: ['home', 'approvals', 'today', 'announce', 'more'],
    more: ['inbox', 'calendar', 'account'],
  },
  'office clerk (role default)': {
    me: { capacities: ['staff'], capabilities: office, assignments: [] },
    tabs: ['home', 'today', 'inbox', 'calendar', 'account'],
    bar: ['home', 'today', 'inbox', 'calendar', 'account'],
    more: [],
  },
  'office clerk granted payment.verify (slice 27)': {
    me: { capacities: ['staff'], capabilities: [...office, C.PAYMENT_VERIFY], assignments: [] },
    tabs: ['home', 'approvals', 'today', 'inbox', 'calendar', 'account'],
    bar: ['home', 'approvals', 'today', 'inbox', 'more'],
    more: ['calendar', 'account'],
  },
  'class teacher': {
    me: {
      capacities: ['staff'],
      capabilities: teacher,
      assignments: [assignment('class_teacher')],
    },
    // Slice 30: Marks after Classes, so Calendar and Account move under More.
    tabs: ['home', 'classes', 'marks', 'inbox', 'calendar', 'account'],
    bar: ['home', 'classes', 'marks', 'inbox', 'more'],
    more: ['calendar', 'account'],
  },
  'subject teacher': {
    me: {
      capacities: ['staff'],
      capabilities: teacher,
      assignments: [assignment('subject_teacher')],
    },
    // Slice 30: Marks after Classes, so Calendar and Account move under More.
    tabs: ['home', 'classes', 'marks', 'inbox', 'calendar', 'account'],
    bar: ['home', 'classes', 'marks', 'inbox', 'more'],
    more: ['calendar', 'account'],
  },
  'cover teacher only': {
    me: { capacities: ['staff'], capabilities: teacher, assignments: [assignment('cover')] },
    // Slice 30: Marks after Classes, so Calendar and Account move under More.
    tabs: ['home', 'classes', 'marks', 'inbox', 'calendar', 'account'],
    bar: ['home', 'classes', 'marks', 'inbox', 'more'],
    more: ['calendar', 'account'],
  },
  'teacher with ended assignments (capability, no assignment → no Classes)': {
    me: { capacities: ['staff'], capabilities: teacher, assignments: [] },
    tabs: ['home', 'inbox', 'calendar', 'account'],
    bar: ['home', 'inbox', 'calendar', 'account'],
    more: [],
  },
  parent: {
    me: { capacities: ['guardian'], capabilities: [], assignments: [] },
    tabs: ['home', 'children', 'inbox', 'calendar', 'account'],
    bar: ['home', 'children', 'inbox', 'calendar', 'account'],
    more: [],
  },
  student: {
    me: { capacities: ['student'], capabilities: [], assignments: [] },
    tabs: ['home', 'student', 'inbox', 'calendar', 'account'],
    bar: ['home', 'student', 'inbox', 'calendar', 'account'],
    more: [],
  },
  'teacher-parent': {
    me: {
      capacities: ['staff', 'guardian'],
      capabilities: teacher,
      assignments: [assignment('class_teacher')],
    },
    tabs: ['home', 'classes', 'marks', 'children', 'inbox', 'calendar', 'account'],
    bar: ['home', 'classes', 'marks', 'children', 'more'],
    more: ['inbox', 'calendar', 'account'],
  },
  'principal-parent': {
    me: { capacities: ['staff', 'guardian'], capabilities: principal, assignments: [] },
    tabs: ['home', 'approvals', 'today', 'announce', 'children', 'inbox', 'calendar', 'account'],
    bar: ['home', 'approvals', 'today', 'announce', 'more'],
    more: ['children', 'inbox', 'calendar', 'account'],
  },
  'no capacity': {
    me: { capacities: [], capabilities: [], assignments: [] },
    tabs: [],
    bar: [],
    more: [],
  },
};

describe('composeTabs', () => {
  test.each(Object.entries(fixtures))('%s', (_name, fixture) => {
    const tabs = composeTabs(fixture.me);
    expect(tabs).toEqual(fixture.tabs);
    const layout = layoutTabs(tabs);
    expect(layout.bar).toEqual(fixture.bar);
    expect(layout.more).toEqual(fixture.more);
    expect(layout.bar.length).toBeLessThanOrEqual(5);
  });

  test('a .scope-only announcer gets no Announce tab in Phase 2', () => {
    const tabs = composeTabs({
      capacities: ['staff'],
      capabilities: [C.ANNOUNCEMENT_SEND_SCOPE],
      assignments: [],
    });
    expect(tabs).not.toContain('announce');
  });

  test('Classes needs one of mark, diary or remark as well as an assignment', () => {
    const me = {
      capacities: ['staff'] as TabSource['capacities'],
      assignments: [assignment('class_teacher')],
    };
    expect(composeTabs({ ...me, capabilities: [] })).not.toContain('classes');
    expect(composeTabs({ ...me, capabilities: [C.DIARY_WRITE] })).toContain('classes');
    expect(composeTabs({ ...me, capabilities: [C.REMARK_WRITE] })).toContain('classes');
  });

  test('a guardian holding a capability gets nothing staff-only', () => {
    const tabs = composeTabs({
      capacities: ['guardian'],
      capabilities: principal,
      assignments: [assignment('class_teacher')],
    });
    expect(tabs).toEqual(['home', 'children', 'inbox', 'calendar', 'account']);
  });

  test('home is first and account last whenever anything is shown', () => {
    for (const fixture of Object.values(fixtures)) {
      const tabs = composeTabs(fixture.me);
      if (tabs.length === 0) continue;
      expect(tabs[0]).toBe('home');
      expect(tabs[tabs.length - 1]).toBe('account');
    }
  });
});

describe('the screen registry (slice 16b)', () => {
  test('ships every tab', () => {
    expect([...SCREEN_REGISTRY].sort()).toEqual([...TAB_ORDER].sort());
  });

  test('a principal sees Home, Approvals, Today, Announce and More (Inbox, Calendar, Account)', () => {
    const tabs = composeTabs(fixtures.principal!.me).filter(hasScreen);
    expect(tabs).toEqual(['home', 'approvals', 'today', 'announce', 'inbox', 'calendar', 'account']);
    expect(layoutTabs(tabs)).toEqual({
      bar: ['home', 'approvals', 'today', 'announce', 'more'],
      more: ['inbox', 'calendar', 'account'],
    });
  });

  test('Approvals needs one of the four decision keys and a staff capacity (R227)', () => {
    const staff = { capacities: ['staff'] as TabSource['capacities'], assignments: [] };
    expect(composeTabs({ ...staff, capabilities: office })).not.toContain('approvals');
    for (const key of [C.PAYMENT_VERIFY, C.COLLECTION_HANDOVER_CONFIRM, C.EXPENSE_APPROVE, C.STAFF_LEAVE_APPROVE]) {
      expect(composeTabs({ ...staff, capabilities: [key] })).toContain('approvals');
    }
  });
});
