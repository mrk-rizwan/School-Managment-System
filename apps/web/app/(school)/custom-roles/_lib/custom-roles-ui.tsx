'use client';

import { ErrorCode, type Capability } from '@asms/shared';
import { useId } from 'react';
import { Badge } from '@/components/ui/badge';
import { ApiError, refusalMessage } from '@/lib/api/errors';
import type {
  CapabilityNotHeldDetails,
  CustomRoleInUseDetails,
  CustomRoleStatus,
  StaffNotActiveDetails,
} from '@/lib/api/school-roles-contract';
import { CAPABILITY_LABELS, GRANTABLE_GROUPS } from '@/lib/capability-labels';
import { cn } from '@/lib/utils';

// Pieces shared by the custom-role screens and the staff permissions tab (contracts/slice-7.md §9).

export const accessKeys = {
  customRoles: ['school', 'custom-roles'] as const,
  customRoleList: ['school', 'custom-roles', 'list'] as const,
  customRole: (id: string) => ['school', 'custom-roles', 'detail', id] as const,
  /** Every user's permissions view: invalidate after any change to roles, grants, staff status or a custom role's keys. */
  allPermissions: ['school', 'permissions'] as const,
  permissions: (userId: string) => ['school', 'permissions', userId] as const,
};

export const CUSTOM_ROLE_STATUS_LABELS: Record<CustomRoleStatus, string> = {
  active: 'Active',
  archived: 'Archived',
};

export function CustomRoleStatusBadge({ status }: { status: CustomRoleStatus }) {
  return (
    <Badge variant={status === 'active' ? 'secondary' : 'outline'}>{CUSTOM_ROLE_STATUS_LABELS[status]}</Badge>
  );
}

/** A capability as its plain name with the dotted key beside it. */
export function CapabilityName({ capability }: { capability: Capability }) {
  return (
    <span>
      {CAPABILITY_LABELS[capability]}{' '}
      <span className="font-mono text-xs text-muted-foreground">{capability}</span>
    </span>
  );
}

/** Why a principal's permissions view has no grant or revoke action (slice-7 §4.1). */
export const PRINCIPAL_PERMISSIONS_NOTE =
  'Principals hold every permission; their permissions cannot be changed individually.';

const listOf = (keys: readonly Capability[]) => keys.map((k) => CAPABILITY_LABELS[k] ?? k).join(', ');

/**
 * One sentence for a refusal on this slice's routes (contract §7), in words the principal can act
 * on; anything else is `refusalMessage`.
 */
export function accessErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.fieldErrors.length === 0) {
    const details = error.details as Record<string, unknown> | null;
    switch (error.code) {
      case ErrorCode.PERMISSION_DENIED:
        if (details?.reason === 'capability_not_held') {
          const keys = (details as CapabilityNotHeldDetails).capabilities ?? [];
          return `You can only give capabilities you hold yourself${keys.length ? `: ${listOf(keys)}` : ''}.`;
        }
        break;
      case ErrorCode.SELF_ACTION_FORBIDDEN:
        return 'You cannot change your own permissions. Ask another principal.';
      case ErrorCode.STAFF_NOT_ACTIVE:
        return (details as StaffNotActiveDetails | null)?.reason === 'no_staff_role'
          ? 'This person has no staff role at present. Give them a role first.'
          : 'Only an active staff member can be given this.';
      case ErrorCode.CUSTOM_ROLE_ARCHIVED:
        return 'This custom role is archived. It can no longer be changed or given.';
      case ErrorCode.CUSTOM_ROLE_IN_USE: {
        const count = (details as CustomRoleInUseDetails | null)?.holderCount ?? 0;
        return `${count} ${count === 1 ? 'person holds' : 'people hold'} this role, including any suspended or departed staff. Remove it from each of them first.`;
      }
      case ErrorCode.GRANT_EXISTS:
        return 'This person already has the same change in force.';
      case ErrorCode.TARGET_IS_PRINCIPAL:
        return PRINCIPAL_PERMISSIONS_NOTE;
    }
  }
  return refusalMessage(error, 'account');
}

/**
 * The custom-role checklist (contract §9): grouped as plan §7, `role.manage` never shown. A key the
 * editor does not hold is disabled unless it is already in the role (R94: only added keys are
 * checked), and says why.
 */
export function CapabilityChecklist({
  value,
  onChange,
  held,
  existing = [],
  disabled = false,
  invalid,
}: {
  value: readonly Capability[];
  onChange: (next: Capability[]) => void;
  held: (capability: Capability) => boolean;
  /** Keys already in the role when it was loaded. */
  existing?: readonly Capability[];
  disabled?: boolean;
  invalid?: boolean;
}) {
  const id = useId();
  const selected = new Set(value);
  const toggle = (capability: Capability, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(capability);
    else next.delete(capability);
    // Registry order, as the API returns it.
    onChange(GRANTABLE_GROUPS.flatMap((g) => g.capabilities).filter((c) => next.has(c)));
  };

  return (
    <div className="grid gap-4 sm:grid-cols-2" aria-invalid={invalid || undefined}>
      {GRANTABLE_GROUPS.map(({ group, label, capabilities }) => (
        <fieldset key={group} className="rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">{label}</legend>
          <ul className="grid gap-2">
            {capabilities.map((capability) => {
              const inputId = `${id}-${capability}`;
              const notHeld = !held(capability) && !existing.includes(capability);
              const off = disabled || notHeld;
              return (
                <li key={capability} className="flex items-start gap-2">
                  <input
                    id={inputId}
                    type="checkbox"
                    className="mt-0.5 size-4 shrink-0 accent-primary"
                    checked={selected.has(capability)}
                    disabled={off}
                    aria-describedby={notHeld && !disabled ? `${inputId}-why` : undefined}
                    onChange={(event) => toggle(capability, event.target.checked)}
                  />
                  <label htmlFor={inputId} className={cn('grid text-sm', off && 'text-muted-foreground')}>
                    <span>{CAPABILITY_LABELS[capability]}</span>
                    <span className="font-mono text-xs text-muted-foreground">{capability}</span>
                    {notHeld && !disabled && (
                      <span id={`${inputId}-why`} className="text-xs text-muted-foreground">
                        You do not hold this, so you cannot add it.
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      ))}
    </div>
  );
}
