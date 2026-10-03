'use client';

import { SearchIcon } from 'lucide-react';
import { useId } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { cn } from '@/lib/utils';

// The filter row above a list: a search box and labelled selects, the same on every screen.

/** A list's search box. `hint` is shown under it (a too-short term, an identity number, ...). */
export function SearchField({
  value,
  onChange,
  placeholder,
  hint,
  hintTone = 'muted',
  maxLength = 100,
  className = 'sm:w-72',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  hint?: React.ReactNode;
  hintTone?: 'muted' | 'destructive';
  maxLength?: number;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('grid w-full gap-1.5', className)}>
      <Label htmlFor={id}>Search</Label>
      <div className="relative">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          id={id}
          type="search"
          value={value}
          maxLength={maxLength}
          autoComplete="off"
          placeholder={placeholder}
          className="pl-8"
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      {hint && (
        <p
          id={`${id}-hint`}
          className={cn('text-xs', hintTone === 'destructive' ? 'text-destructive' : 'text-muted-foreground')}
        >
          {hint}
        </p>
      )}
    </div>
  );
}

/** A labelled filter select. `T` is the union of its option values, `''` for "any". */
export function FilterSelect<T extends string>({
  label,
  value,
  onChange,
  children,
  disabled,
  className = 'sm:w-40',
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  children: React.ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('grid w-full gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {children}
      </NativeSelect>
    </div>
  );
}
