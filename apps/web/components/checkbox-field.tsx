'use client';

import { useId } from 'react';
import { Controller, type Control, type FieldPath, type FieldValues } from 'react-hook-form';

/**
 * A boolean form field: a checkbox with its label and a hint underneath, wired to
 * react-hook-form. `disabled` keeps the value but stops the user changing it (a rule fixes it).
 */
export function CheckboxField<T extends FieldValues>({
  control,
  name,
  label,
  hint,
  disabled,
}: {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
  hint: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <div className="flex items-start gap-3">
          <input
            id={id}
            type="checkbox"
            className="mt-0.5 size-4 accent-primary disabled:opacity-50"
            checked={Boolean(field.value)}
            disabled={disabled}
            onChange={(event) => field.onChange(event.target.checked)}
            onBlur={field.onBlur}
            ref={field.ref}
            aria-describedby={`${id}-hint`}
          />
          <div className="grid gap-0.5">
            <label htmlFor={id} className="text-sm font-medium">
              {label}
            </label>
            <p id={`${id}-hint`} className="text-xs text-muted-foreground">
              {hint}
            </p>
          </div>
        </div>
      )}
    />
  );
}
