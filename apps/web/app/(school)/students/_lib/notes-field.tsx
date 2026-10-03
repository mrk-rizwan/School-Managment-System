'use client';

import { useId } from 'react';
import { useController, type Control, type FieldValues, type Path } from 'react-hook-form';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/** Student notes (0–2000 characters, §3.5) take several lines; FormField renders one. */
export function NotesField<T extends FieldValues & { notes: string }>({ control }: { control: Control<T> }) {
  const { field, fieldState } = useController({ control, name: 'notes' as Path<T> });
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>Notes (optional)</Label>
      <Textarea
        id={id}
        rows={3}
        maxLength={2000}
        {...field}
        aria-invalid={fieldState.error ? true : undefined}
        aria-describedby={fieldState.error ? `${id}-error` : undefined}
      />
      {fieldState.error && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {fieldState.error.message}
        </p>
      )}
    </div>
  );
}
