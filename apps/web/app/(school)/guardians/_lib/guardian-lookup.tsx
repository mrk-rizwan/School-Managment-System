'use client';

import { normaliseIdentityDigits, normalisePhone } from '@asms/shared';
import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { unwrap } from '@/lib/api/client';
import { describeApiError } from '@/lib/api/errors';
import {
  guardiansApi,
  type GuardianLookupBody,
  type GuardianLookupResultDto,
} from '@/lib/api/school-guardians-contract';
import { describeStudents, formatIdentityInput } from './guardians-ui';

/** POST /guardians/lookup (contracts/slice-5.md §3.6). Never audited; throttled per user. */
export function lookupGuardians(body: GuardianLookupBody) {
  return unwrap(guardiansApi.POST('/api/v1/guardians/lookup', { body }));
}

/** The hits of a lookup: survivors only, each with its students and a note when merged. */
export function LookupHits({ result }: { result: GuardianLookupResultDto }) {
  return (
    <ul className="grid gap-2" aria-label="Guardians found">
      {result.data.map(({ guardian, resolvedFromId, students }) => {
        const family = describeStudents(students);
        return (
          <li key={guardian.id} className="rounded-lg border p-3 text-sm">
            <Link
              href={`/guardians/${guardian.id}`}
              className="font-medium underline-offset-4 hover:underline"
            >
              {guardian.fullName}
            </Link>
            {family && <span className="text-muted-foreground"> — {family}</span>}
            <p className="mt-1 text-xs text-muted-foreground">
              {[guardian.cnicMasked, guardian.phone].filter(Boolean).join(' · ')}
            </p>
            {resolvedFromId && (
              <p className="mt-1 text-xs text-muted-foreground">
                The matching record was merged into this one.
              </p>
            )}
          </li>
        );
      })}
      {result.truncated && (
        <li className="text-xs text-muted-foreground">
          Only the first {result.data.length} matches are shown.
        </li>
      )}
    </ul>
  );
}

type Mode = 'cnic' | 'phone';

/**
 * "Find guardian" by CNIC or phone. The typed digits live only in this dialog's state and are
 * cleared as soon as the request is sent (§6); results never echo the CNIC.
 */
export function GuardianLookupDialog({
  open,
  onOpenChange,
  initialCnic,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Digits moved here from the list's search box, which never sends them. */
  initialCnic?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open && <LookupForm initialCnic={initialCnic} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function LookupForm({ initialCnic, onDone }: { initialCnic?: string; onDone: () => void }) {
  const modeId = useId();
  const valueId = useId();
  const [mode, setMode] = useState<Mode>('cnic');
  const [value, setValue] = useState(initialCnic ? formatIdentityInput(initialCnic) : '');
  const [searched, setSearched] = useState<Mode | null>(null);

  const lookup = useMutation({ mutationFn: lookupGuardians });

  const cnic = mode === 'cnic' ? normaliseIdentityDigits(value) : null;
  const phone = mode === 'phone' ? normalisePhone(value) : null;
  const ready = cnic !== null || phone !== null;

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || lookup.isPending) return;
        lookup.mutate(cnic !== null ? { cnic } : { phone: phone! });
        setSearched(mode);
        setValue('');
      }}
    >
      <DialogHeader>
        <DialogTitle>Find guardian</DialogTitle>
        <DialogDescription>
          Search before adding a guardian, so a family is never recorded twice.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
        <div className="grid gap-1.5">
          <Label htmlFor={modeId}>Find by</Label>
          <NativeSelect
            id={modeId}
            value={mode}
            onChange={(event) => {
              setMode(event.target.value as Mode);
              setValue('');
            }}
          >
            <option value="cnic">CNIC</option>
            <option value="phone">Phone</option>
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={valueId}>{mode === 'cnic' ? 'CNIC' : 'Mobile phone'}</Label>
          <Input
            id={valueId}
            value={value}
            autoComplete="off"
            autoFocus
            inputMode={mode === 'cnic' ? 'numeric' : 'tel'}
            maxLength={mode === 'cnic' ? 15 : 20}
            placeholder={mode === 'cnic' ? '35201-1234567-1' : '0300 1234567'}
            onChange={(event) =>
              setValue(mode === 'cnic' ? formatIdentityInput(event.target.value) : event.target.value)
            }
          />
        </div>
      </div>
      {lookup.error && (
        <p role="alert" className="text-sm text-destructive">
          {describeApiError(lookup.error)}
        </p>
      )}
      {lookup.data && (
        <div className="grid gap-2" role="status">
          {lookup.data.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No guardian has this {searched === 'phone' ? 'phone number' : 'CNIC'}.
            </p>
          ) : (
            <LookupHits result={lookup.data} />
          )}
        </div>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Close
        </Button>
        <Button type="submit" disabled={!ready || lookup.isPending}>
          {lookup.isPending ? 'Searching…' : 'Search'}
        </Button>
      </DialogFooter>
    </form>
  );
}
