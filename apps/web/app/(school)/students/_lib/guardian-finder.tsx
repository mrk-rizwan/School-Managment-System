'use client';

import { normaliseIdentityDigits, normalisePhone } from '@asms/shared';
import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { describeApiError } from '@/lib/api/errors';
import type {
  GuardianLookupBody,
  GuardianLookupHitDto,
  GuardianLookupResultDto,
} from '@/lib/api/school-guardians-contract';
import { formatIdentityInput } from '@/lib/validation';
import { LookupHits, lookupGuardians } from '../../guardians/_lib/guardian-lookup';

/** What was searched, for pre-filling a new guardian when nobody matched. */
export type Searched = { cnic: string | null; phone: string | null };
type Stage = 'cnic' | 'phone' | 'done';

/**
 * The guardian match that cannot be skipped (plan §5 slice 6, contracts/slice-6.md §10): CNIC
 * first, then phone, through POST /guardians/lookup. Every phone hit is shown; a merged record
 * arrives as its survivor. Only after both searches (or "no CNIC" / "no phone") is a new guardian
 * offered. Requests are plain promises, not mutations, so the admission wizard's `lookup` can
 * re-authenticate in place without the console redirecting away from the wizard.
 */
export function GuardianFinder({
  onPick,
  pickedIds,
  onNoMatch,
  noMatchHint,
  lookup = lookupGuardians,
}: {
  onPick: (hit: GuardianLookupHitDto) => void;
  /** Guardians already chosen; their Link button is disabled. */
  pickedIds: ReadonlySet<string>;
  /** Offered once both searches are done. Without it, `noMatchHint` is shown instead. */
  onNoMatch?: (searched: Searched) => void;
  noMatchHint?: React.ReactNode;
  lookup?: (body: GuardianLookupBody) => Promise<GuardianLookupResultDto>;
}) {
  const id = useId();
  const [stage, setStage] = useState<Stage>('cnic');
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{ by: 'cnic' | 'phone'; data: GuardianLookupResultDto } | null>(
    null,
  );
  const searched = useRef<Searched>({ cnic: null, phone: null });

  const cnic = stage === 'cnic' ? normaliseIdentityDigits(value) : null;
  const phone = stage === 'phone' ? normalisePhone(value) : null;
  const ready = cnic !== null || phone !== null;

  const search = async () => {
    if (!ready || pending) return;
    const body: GuardianLookupBody = cnic !== null ? { cnic } : { phone: phone! };
    const by = cnic !== null ? 'cnic' : 'phone';
    setPending(true);
    setError(null);
    try {
      const data = await lookup(body);
      searched.current = { ...searched.current, [by]: cnic ?? phone };
      setResult({ by, data });
      // The digits leave the search box once sent; a miss moves on to the next search.
      setValue('');
      if (data.data.length === 0) setStage(by === 'cnic' ? 'phone' : 'done');
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };

  const skip = () => {
    setValue('');
    setResult(null);
    setError(null);
    setStage(stage === 'cnic' ? 'phone' : 'done');
  };

  const restart = () => {
    searched.current = { cnic: null, phone: null };
    setValue('');
    setResult(null);
    setError(null);
    setStage('cnic');
  };

  const hits = result && result.data.data.length > 0 ? result.data : null;
  const missText =
    result && result.data.data.length === 0
      ? `No guardian has this ${result.by === 'cnic' ? 'CNIC' : 'phone number'}.`
      : null;

  return (
    <div className="grid gap-3">
      {stage !== 'done' && (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <Label htmlFor={id}>
            {stage === 'cnic' ? 'Guardian’s CNIC' : 'Guardian’s mobile phone'}
          </Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id={id}
              value={value}
              autoComplete="off"
              className="w-full sm:w-64"
              inputMode={stage === 'cnic' ? 'numeric' : 'tel'}
              maxLength={stage === 'cnic' ? 15 : 20}
              placeholder={stage === 'cnic' ? '#####-#######-#' : '0300 1234567'}
              onChange={(event) =>
                setValue(stage === 'cnic' ? formatIdentityInput(event.target.value) : event.target.value)
              }
            />
            <Button type="submit" disabled={!ready || pending}>
              {pending ? 'Searching…' : stage === 'cnic' ? 'Search by CNIC' : 'Search by phone'}
            </Button>
            <Button type="button" variant="ghost" disabled={pending} onClick={skip}>
              {stage === 'cnic' ? 'No CNIC — search by phone' : 'No phone'}
            </Button>
          </div>
        </form>
      )}
      {Boolean(error) && (
        <p role="alert" className="text-sm text-destructive">
          {describeApiError(error)}
        </p>
      )}
      <div role="status" className="grid gap-2">
        {missText && <p className="text-sm text-muted-foreground">{missText}</p>}
        {hits && (
          <>
            <p className="text-sm font-medium">
              {hits.data.length === 1
                ? 'Is this the guardian? Families often share one phone.'
                : `${hits.data.length} guardians found. Link the right one; families often share one phone.`}
            </p>
            <LookupHits
              result={hits}
              linkNames={false}
              action={(hit) => (
                <Button
                  type="button"
                  size="sm"
                  disabled={pickedIds.has(hit.guardian.id)}
                  aria-label={`Link ${hit.guardian.fullName}`}
                  onClick={() => onPick(hit)}
                >
                  {pickedIds.has(hit.guardian.id) ? 'Linked' : 'Link?'}
                </Button>
              )}
            />
            {stage !== 'done' && (
              <div>
                <Button type="button" variant="outline" size="sm" onClick={skip}>
                  {stage === 'cnic' ? 'Not them — search by phone' : 'None of these'}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      {stage === 'done' && (
        <div className="flex flex-wrap items-center gap-2">
          {onNoMatch ? (
            <Button type="button" onClick={() => onNoMatch(searched.current)}>
              Add a new guardian
            </Button>
          ) : (
            noMatchHint
          )}
          <Button type="button" variant="ghost" onClick={restart}>
            Search again
          </Button>
        </div>
      )}
    </div>
  );
}
