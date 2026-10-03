'use client';

import { useId } from 'react';
import {
  useController,
  type Control,
  type FieldPath,
  type FieldValues,
  type UseFormReturn,
} from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { ApiError, describeApiError } from '@/lib/api/errors';

/**
 * The one form field (plan §3.10): label, input, hint and error, wired to react-hook-form.
 * Errors come from the zod resolver or from the API via `applyApiError`.
 * With `options` it renders a native select instead of a text input; the value is a string.
 */
export type FormFieldOption = { value: string; label: string };

type FormFieldProps<T extends FieldValues> = {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
  hint?: string;
  options?: readonly FormFieldOption[];
} & Pick<
  React.ComponentProps<'input'>,
  'type' | 'autoComplete' | 'inputMode' | 'placeholder' | 'maxLength' | 'disabled' | 'autoFocus'
>;

export function FormField<T extends FieldValues>({
  control,
  name,
  label,
  hint,
  options,
  ...inputProps
}: FormFieldProps<T>) {
  const { field, fieldState } = useController({ control, name });
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const error = fieldState.error?.message;
  const describedBy = [hint && hintId, error && errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {options ? (
        <NativeSelect
          id={id}
          {...field}
          disabled={inputProps.disabled}
          autoFocus={inputProps.autoFocus}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
      ) : (
        <Input
          id={id}
          {...field}
          {...inputProps}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        />
      )}
      {hint && !error && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Shows a form-level error (one that belongs to no field), set as `root.server`. */
export function FormRootError<T extends FieldValues>({ form }: { form: UseFormReturn<T> }) {
  const message = form.formState.errors.root?.server?.message;
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      {message}
    </p>
  );
}

/**
 * Maps a 422 VALIDATION_FAILED response's `details.fields[{ path, code, message }]` onto the
 * form. A path that is not a field of this form (its value is undefined) goes to `root.server`,
 * so no message is silently lost. Returns false when the error is not a field-level 422 and the
 * caller must handle it some other way (a toast, ErrorState, ...).
 */
export function applyApiFieldErrors<T extends FieldValues>(
  form: UseFormReturn<T>,
  error: unknown,
): boolean {
  if (!(error instanceof ApiError)) return false;
  const fields = error.fieldErrors;
  if (fields.length === 0) return false;

  const values = form.getValues() as Record<string, unknown>;
  const unmatched: string[] = [];
  let focused = false;
  for (const { path, code, message } of fields) {
    if (valueAt(values, path) === undefined) {
      unmatched.push(message);
      continue;
    }
    form.setError(path as FieldPath<T>, { type: code, message }, { shouldFocus: !focused });
    focused = true;
  }
  if (unmatched.length > 0) {
    form.setError('root.server', { type: 'server', message: unmatched.join(' ') });
  }
  return true;
}

/**
 * Puts any API error on the form: field-level 422s on their fields (`applyApiFieldErrors`),
 * everything else as the form-level `root.server` message.
 */
export function applyApiError<T extends FieldValues>(form: UseFormReturn<T>, error: unknown): void {
  if (applyApiFieldErrors(form, error)) return;
  form.setError('root.server', { message: describeApiError(error) });
}

function valueAt(source: unknown, path: string): unknown {
  let current = source;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
