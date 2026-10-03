'use client';

import { useId } from 'react';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { RELATIONSHIPS } from '@asms/shared';
import type { Relationship } from '@/lib/api/school-students-contract';
import { RELATIONSHIP_LABELS } from './students-ui';

/** The flags of a link: relationship, primary contact, fee payer, may log in. */
export type LinkFlags = { relationship: Relationship | ''; isPrimaryContact: boolean; isFeePayer: boolean; canLogin: boolean };

export function LinkFlagFields({
  value,
  onChange,
  hasPhone,
  primaryLocked = false,
  disabled,
}: {
  value: LinkFlags;
  onChange: (value: LinkFlags) => void;
  hasPhone: boolean;
  /** The current primary contact: moved by making someone else primary, not by unticking. */
  primaryLocked?: boolean;
  disabled?: boolean;
}) {
  const ids = { relationship: useId(), primary: useId(), payer: useId(), login: useId() };
  const check = (key: 'isPrimaryContact' | 'isFeePayer' | 'canLogin', id: string, label: string, hint?: string, off?: boolean) => (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-4 accent-primary"
        checked={value[key]}
        disabled={disabled || off}
        onChange={(event) => onChange({ ...value, [key]: event.target.checked })}
      />
      <div className="grid gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor={ids.relationship}>Relationship</Label>
        <NativeSelect
          id={ids.relationship}
          value={value.relationship}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, relationship: event.target.value as Relationship | '' })}
        >
          <option value="">Choose…</option>
          {RELATIONSHIPS.map((r) => (
            <option key={r} value={r}>
              {RELATIONSHIP_LABELS[r]}
            </option>
          ))}
        </NativeSelect>
      </div>
      {check(
        'isPrimaryContact',
        ids.primary,
        'Primary contact',
        !hasPhone
          ? 'Needs a phone number on the guardian’s record.'
          : primaryLocked
            ? 'To move it, make another guardian the primary contact.'
            : 'The school contacts this guardian first. One per student.',
        !hasPhone || primaryLocked,
      )}
      {check('isFeePayer', ids.payer, 'Pays fees')}
      {check('canLogin', ids.login, 'May log in', 'Allows a parent login to be issued to this guardian.')}
    </div>
  );
}
