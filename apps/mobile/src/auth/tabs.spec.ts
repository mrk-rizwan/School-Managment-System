import { Capability, SYSTEM_ROLE_DEFAULTS } from '@asms/shared';
import type { MeAssignmentDto } from '../api/contracts';
import { hasScreen, SCREEN_REGISTRY } from './screen-registry';
import { composeTabs, layoutTabs, type TabSource } from './tabs';

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
  principal: {
    me: { capacities: ['staff'], capabilities: principal, assignments: [] },
    tabs: ['home', 'today', 'announce', 'inbox', 'calendar', 'account'],
    bar: ['home', 'today', 'announce', 'inbox', 'more'],
    more: ['calendar', 'account'],
  },
  'office clerk (role default)': {
    me: { capacities: ['staff'], capabilities: office, assignments: [] },
    tabs: ['home', 'today', 'inbox', 'calendar', 'account'],
    bar: ['home', 'today', 'inbox', 'calendar', 'account'],
    more: [],
  },
  'class teacher': {
    me: {
      capacities: ['staff'],
      capabilities: teacher,
      assignments: [assignment('class_teacher')],
    },
    tabs: ['home', 'classes', 'inbox', 'calendar', 'account'],
    bar: ['home', 'classes', 'inbox', 'calendar', 'account'],
    more: [],
  },
  'subject teacher': {
    me: {
      capacities: ['staff'],
      capabilities: teacher,
      assignments: [assignment('subject_teacher')],
    },
    tabs: ['home', 'classes', 'inbox', 'calendar', 'account'],
    bar: ['home', 'classes', 'inbox', 'calendar', 'account'],
    more: [],
  },
  'cover teacher only': {
    me: { capacities: ['staff'], capabilities: teacher, assignments: [assignment('cover')] },
    tabs: ['home', 'classes', 'inbox', 'calendar', 'account'],
    bar: ['home', 'classes', 'inbox', 'calendar', 'account'],
    more: [],
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
    tabs: ['home', 'classes', 'children', 'inbox', 'calendar', 'account'],
    bar: ['home', 'classes', 'children', 'inbox', 'more'],
    more: ['calendar', 'account'],
  },
  'principal-parent': {
    me: { capacities: ['staff', 'guardian'], capabilities: principal, assignments: [] },
    tabs: ['home', 'today', 'announce', 'children', 'inbox', 'calendar', 'account'],
    bar: ['home', 'today', 'announce', 'children', 'more'],
    more: ['inbox', 'calendar', 'account'],
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

describe('the screen registry (slice 15)', () => {
  test('ships Home, Calendar and Account only', () => {
    expect([...SCREEN_REGISTRY].sort()).toEqual(['account', 'calendar', 'home']);
  });

  test('a principal sees Home, Calendar, Account in this build', () => {
    expect(composeTabs(fixtures.principal!.me).filter(hasScreen)).toEqual([
      'home',
      'calendar',
      'account',
    ]);
  });
});
