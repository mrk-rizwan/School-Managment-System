// Exhaustive unit tests of the pure EffectivePermissions function (plan §5 slice 7; R50, R52,
// R59, R79, R45/R75 on read).
import {
  Capability,
  customRoleKeyProblem,
  SYSTEM_ROLE_DEFAULTS,
  SYSTEM_ROLES,
  type SystemRole,
} from '@asms/shared';
import {
  capabilityOrder,
  delegableCapabilities,
  delegableCapability,
  effectivePermissions,
  type CustomRoleInput,
  type GrantInput,
  type PermissionInputs,
} from './effective-permissions';

const ALL = Object.values(Capability);
const base: PermissionInputs = { staffCapacity: true, systemRoles: [], customRoles: [], grants: [] };
const keys = (input: Partial<PermissionInputs>) =>
  effectivePermissions({ ...base, ...input }).map((line) => line.capability);
const line = (input: Partial<PermissionInputs>, capability: Capability) =>
  effectivePermissions({ ...base, ...input }).find((l) => l.capability === capability);

let nextId = 1n;
const grant = (capabilityKey: string, effect: GrantInput['effect'] = 'grant'): GrantInput => ({
  grantId: nextId++,
  capabilityKey,
  effect,
});
const custom = (capabilityKeys: string[], status: CustomRoleInput['status'] = 'active'): CustomRoleInput => ({
  customRoleId: nextId++,
  name: 'Accounts clerk',
  status,
  capabilityKeys,
});

describe('effectivePermissions', () => {
  describe('role defaults', () => {
    it.each(SYSTEM_ROLES.map((r) => [r]))('%s alone gives exactly its §7 defaults, in registry order', (role: SystemRole) => {
      expect(keys({ systemRoles: [role] })).toEqual([...SYSTEM_ROLE_DEFAULTS[role]].sort(capabilityOrder));
    });

    it('several roles give the union, each key once, with every source listed', () => {
      const result = keys({ systemRoles: ['office_staff', 'teacher'] });
      const union = new Set([...SYSTEM_ROLE_DEFAULTS.office_staff, ...SYSTEM_ROLE_DEFAULTS.teacher]);
      expect(result).toEqual([...union].sort(capabilityOrder));
      expect(line({ systemRoles: ['office_staff', 'teacher'] }, Capability.STUDENT_VIEW)?.sources).toEqual([
        { kind: 'system_role', systemRole: 'office_staff' },
        { kind: 'system_role', systemRole: 'teacher' },
      ]);
    });

    it('lines are in registry order whatever the input order', () => {
      const result = keys({ grants: [grant('comms.x'), grant('payment.verify'), grant('class.manage')] });
      expect(result).toEqual([Capability.CLASS_MANAGE, Capability.PAYMENT_VERIFY]);
    });

    it('no roles and no grants: nothing', () => {
      expect(keys({})).toEqual([]);
    });
  });

  describe('R59: no staff capacity means no capability, whatever is stored', () => {
    it('returns nothing for a principal, a custom role and grants when staffCapacity is false', () => {
      expect(
        effectivePermissions({
          staffCapacity: false,
          systemRoles: ['principal'],
          customRoles: [custom(['payment.verify'])],
          grants: [grant('payroll.run')],
        }),
      ).toEqual([]);
    });
  });

  describe('custom roles (R52)', () => {
    it('an active custom role contributes its keys, sourced to the role', () => {
      const role = custom(['payment.verify', 'finance.report.view']);
      expect(keys({ customRoles: [role] })).toEqual([Capability.PAYMENT_VERIFY, Capability.FINANCE_REPORT_VIEW]);
      expect(line({ customRoles: [role] }, Capability.PAYMENT_VERIFY)?.sources).toEqual([
        { kind: 'custom_role', customRoleId: role.customRoleId, name: 'Accounts clerk' },
      ]);
    });

    it('R52: an archived custom role contributes nothing', () => {
      expect(keys({ customRoles: [custom(['payment.verify'], 'archived')] })).toEqual([]);
    });

    it('a duplicate key within one role is one source', () => {
      expect(line({ customRoles: [custom(['payment.verify', 'payment.verify'])] }, Capability.PAYMENT_VERIFY)?.sources).toHaveLength(1);
    });

    it('R45: role.manage stored in a custom role is ignored', () => {
      expect(keys({ customRoles: [custom(['role.manage'])] })).toEqual([]);
    });

    it('unknown keys stored in a custom role are ignored (Map lookup, no prototype keys)', () => {
      expect(keys({ customRoles: [custom(['payment.teleport', 'constructor', '__proto__', 'toString', ''])] })).toEqual([]);
    });
  });

  describe('grants and revokes (R50)', () => {
    it('a grant adds a key the roles do not give', () => {
      expect(keys({ systemRoles: ['teacher'], grants: [grant('payment.verify')] })).toContain(Capability.PAYMENT_VERIFY);
    });

    it('a revoke removes a system-role default', () => {
      const result = keys({ systemRoles: ['office_staff'], grants: [grant('payment.record', 'revoke')] });
      expect(result).not.toContain(Capability.PAYMENT_RECORD);
      expect(result).toHaveLength(SYSTEM_ROLE_DEFAULTS.office_staff.length - 1);
    });

    it('a revoke removes a custom-role default too (contracts/slice-7.md decision 1)', () => {
      expect(keys({ customRoles: [custom(['payment.verify'])], grants: [grant('payment.verify', 'revoke')] })).toEqual([]);
    });

    it('a revoke removes the key whichever roles give it', () => {
      const result = keys({
        systemRoles: ['office_staff', 'teacher'],
        customRoles: [custom(['student.view'])],
        grants: [grant('student.view', 'revoke')],
      });
      expect(result).not.toContain(Capability.STUDENT_VIEW);
    });

    it('a revoke of a key not held by default changes nothing', () => {
      expect(keys({ systemRoles: ['teacher'], grants: [grant('payroll.run', 'revoke')] })).toEqual(keys({ systemRoles: ['teacher'] }));
    });

    it('a revoke removes a default only: a grant of the same key wins, in either row order', () => {
      for (const grants of [
        [grant('payment.verify'), grant('payment.verify', 'revoke')],
        [grant('payment.verify', 'revoke'), grant('payment.verify')],
      ]) {
        const l = line({ systemRoles: ['principal'], grants }, Capability.PAYMENT_VERIFY);
        expect(l?.sources).toEqual([{ kind: 'grant', grantId: grants.find((g) => g.effect === 'grant')?.grantId }]);
      }
    });

    it('a grant of a key already held by default adds the grant as a further source', () => {
      const g = grant('student.view');
      expect(line({ systemRoles: ['office_staff'], grants: [g] }, Capability.STUDENT_VIEW)?.sources).toEqual([
        { kind: 'system_role', systemRole: 'office_staff' },
        { kind: 'grant', grantId: g.grantId },
      ]);
    });

    it('R45, R75: role.manage in a grant row is ignored; a revoke of it does not remove the principal default', () => {
      expect(keys({ systemRoles: ['teacher'], grants: [grant('role.manage')] })).not.toContain(Capability.ROLE_MANAGE);
      expect(keys({ systemRoles: ['principal'], grants: [grant('role.manage', 'revoke')] })).toContain(Capability.ROLE_MANAGE);
    });

    it('unknown keys in grant rows are ignored', () => {
      expect(keys({ grants: [grant('nope.nope'), grant('hasOwnProperty'), grant('__proto__', 'revoke')] })).toEqual([]);
    });

    it('grants count without any role default (capacity is decided by the caller)', () => {
      expect(keys({ grants: [grant('staff.view')] })).toEqual([Capability.STAFF_VIEW]);
    });
  });

  describe('scope follows the source (R79)', () => {
    it('teacher defaults alone are assigned_sections', () => {
      for (const l of effectivePermissions({ ...base, systemRoles: ['teacher'] })) {
        expect(l.scope).toBe('assigned_sections');
      }
    });

    it.each([
      ['principal', { systemRoles: ['teacher', 'principal'] as SystemRole[] }],
      ['office staff', { systemRoles: ['teacher', 'office_staff'] as SystemRole[] }],
      ['a custom role', { systemRoles: ['teacher'] as SystemRole[], customRoles: [custom(['student.view'])] }],
      ['a grant', { systemRoles: ['teacher'] as SystemRole[], grants: [grant('student.view')] }],
    ])('teacher plus %s: the widest (all) wins', (_name, input) => {
      expect(line(input, Capability.STUDENT_VIEW)?.scope).toBe('all');
    });

    it('a grant over a revoked teacher default is school-wide (only the grant is a source)', () => {
      const l = line(
        { systemRoles: ['teacher'], grants: [grant('student.view', 'revoke'), grant('student.view')] },
        Capability.STUDENT_VIEW,
      );
      expect(l?.scope).toBe('all');
    });
  });

  describe('exhaustive over every key and every row combination', () => {
    const combos: { roles: SystemRole[]; g: boolean; r: boolean; c: boolean }[] = [];
    for (const roles of [[], ['principal'], ['office_staff'], ['teacher'], ['office_staff', 'teacher']] as SystemRole[][]) {
      for (const g of [false, true]) for (const r of [false, true]) for (const c of [false, true]) combos.push({ roles, g, r, c });
    }

    it.each(ALL.map((key) => [key]))('%s follows (defaults − revoke) ∪ grant', (key: Capability) => {
      for (const { roles, g, r, c } of combos) {
        const grants = [...(g ? [grant(key)] : []), ...(r ? [grant(key, 'revoke')] : [])];
        const customRoles = c ? [custom([key])] : [];
        const held = keys({ systemRoles: roles, grants, customRoles }).includes(key);
        const delegable = key !== Capability.ROLE_MANAGE;
        const byDefault = roles.some((role) => SYSTEM_ROLE_DEFAULTS[role].includes(key)) || (c && delegable);
        const expected = (delegable && g) || (byDefault && !(r && delegable));
        expect({ key, roles, g, r, c, held }).toEqual({ key, roles, g, r, c, held: expected });
      }
    });
  });
});

describe('delegableCapability', () => {
  it('maps every registry key but role.manage to itself, and nothing else', () => {
    for (const key of ALL) {
      expect(delegableCapability(key)).toBe(key === Capability.ROLE_MANAGE ? undefined : key);
    }
    for (const key of ['', 'x', 'constructor', '__proto__', 'Payment.Verify', 'payment.verify ']) {
      expect(delegableCapability(key)).toBeUndefined();
    }
  });
});

describe('delegableCapabilities', () => {
  it('keeps the delegable keys once each, in registry order, and drops everything else', () => {
    expect(
      delegableCapabilities(['payroll.view', 'role.manage', 'staff.view', 'payment.teleport', 'staff.view']),
    ).toEqual([Capability.STAFF_VIEW, Capability.PAYROLL_VIEW].sort(capabilityOrder));
    expect(delegableCapabilities([])).toEqual([]);
  });
});

describe('customRoleKeyProblem (@asms/shared)', () => {
  it('one rule for API and web: format, reserved names, identity numbers', () => {
    expect(customRoleKeyProblem('accounts_clerk')).toBeNull();
    expect(customRoleKeyProblem('Bad Key')).toBe('format');
    expect(customRoleKeyProblem('x')).toBe('format');
    for (const key of ['principal', 'office_staff', 'teacher', 'parent', 'student']) {
      expect(customRoleKeyProblem(key)).toBe('reserved');
    }
    expect(customRoleKeyProblem('k1234567890123')).toBe('identity_number');
    expect(customRoleKeyProblem('k123456789012')).toBeNull();
  });
});
