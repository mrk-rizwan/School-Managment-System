'use client';

import { normaliseIdentityDigits } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { XIcon } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ContactCapability } from '@/lib/api/school-guardians-contract';
import { blankToNull, formatIdentityInput, nameSchema, optionalCnicSchema } from '@/lib/validation';
import { lookupGuardians } from '../../guardians/_lib/guardian-lookup';
import {
  ContactFields,
  contactFieldsSchema,
  describeStudents,
} from '../../guardians/_lib/guardians-ui';
import { GuardianFinder, type Searched } from '../../students/_lib/guardian-finder';
import { LinkFlagFields, type LinkFlags } from '../../students/_lib/link-flags';
import {
  guardianHasPhone,
  guardianName,
  guardianProblems,
  type GuardianEntry,
  type Guard,
} from './wizard-types';

const MAX_GUARDIANS = 4;
const NO_FLAGS: LinkFlags = { relationship: '', isPrimaryContact: false, isFeePayer: false, canLogin: false };
let nextKey = 0;
const newKey = () => `g${++nextKey}`;

/**
 * Step 2, which cannot be skipped (contracts/slice-6.md §10): every guardian is searched for by
 * CNIC, then phone, before a new one may be added; at most four; one primary contact with a phone
 * and at least one fee payer.
 */
export function GuardiansStep({
  entries,
  onChange,
  onBack,
  onNext,
  guard,
}: {
  entries: GuardianEntry[];
  onChange: (entries: GuardianEntry[]) => void;
  onBack: () => void;
  onNext: () => void;
  guard: Guard;
}) {
  const [finding, setFinding] = useState(entries.length === 0);
  const [creating, setCreating] = useState<Searched | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const problems = guardianProblems(entries);
  const pickedIds = new Set(entries.flatMap((e) => (e.kind === 'existing' ? [e.guardianId] : [])));

  const add = (entry: GuardianEntry) => {
    // The first guardian with a phone becomes the primary contact and fee payer by default.
    const first = entries.length === 0;
    const hasPhone = guardianHasPhone(entry);
    onChange([...entries, { ...entry, isPrimaryContact: first && hasPhone, isFeePayer: first }]);
    setFinding(false);
    setCreating(null);
  };

  const update = (key: string, flags: LinkFlags) =>
    onChange(
      entries.map((e) => {
        if (e.key === key) return { ...e, ...flags };
        // One primary contact: choosing a new one clears the previous one.
        return flags.isPrimaryContact ? { ...e, isPrimaryContact: false } : e;
      }),
    );

  return (
    <div className="grid gap-4">
      {entries.map((entry) => (
        <Card key={entry.key} size="sm">
          <CardHeader className="flex flex-row items-start justify-between gap-2">
            <div className="grid gap-0.5">
              <CardTitle>{guardianName(entry)}</CardTitle>
              <p className="text-sm text-muted-foreground">
                {entry.kind === 'existing'
                  ? (entry.family ?? 'On record, no other children linked.')
                  : 'New guardian, created with the admission.'}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${guardianName(entry)}`}
              onClick={() => onChange(entries.filter((e) => e.key !== entry.key))}
            >
              <XIcon />
            </Button>
          </CardHeader>
          <CardContent>
            <LinkFlagFields
              value={entry}
              onChange={(flags) => update(entry.key, flags)}
              hasPhone={guardianHasPhone(entry)}
            />
          </CardContent>
        </Card>
      ))}

      {creating ? (
        <Card>
          <CardHeader>
            <CardTitle>New guardian</CardTitle>
          </CardHeader>
          <CardContent>
            <NewGuardianForm
              searched={creating}
              guard={guard}
              onCancel={() => setCreating(null)}
              onAdd={(guardian) => add({ ...NO_FLAGS, key: newKey(), kind: 'new', guardian })}
            />
          </CardContent>
        </Card>
      ) : finding ? (
        <Card>
          <CardHeader>
            <CardTitle>Find the guardian</CardTitle>
          </CardHeader>
          <CardContent>
            <GuardianFinder
              lookup={(body) => guard(() => lookupGuardians(body))}
              pickedIds={pickedIds}
              onPick={({ guardian, students }) =>
                add({
                  ...NO_FLAGS,
                  key: newKey(),
                  kind: 'existing',
                  guardianId: guardian.id,
                  fullName: guardian.fullName,
                  hasPhone: guardian.hasPhone,
                  family: describeStudents(students),
                })
              }
              onNoMatch={setCreating}
            />
          </CardContent>
        </Card>
      ) : (
        entries.length < MAX_GUARDIANS && (
          <div>
            <Button type="button" variant="outline" onClick={() => setFinding(true)}>
              Add another guardian
            </Button>
          </div>
        )
      )}

      {showProblems && problems.length > 0 && (
        <ul role="alert" className="grid gap-1 text-sm text-destructive">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="flex justify-between pt-2">
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button
          type="button"
          onClick={() => {
            setShowProblems(true);
            if (problems.length === 0) onNext();
          }}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

const schema = contactFieldsSchema.extend({ fullName: nameSchema(2, 200), cnic: optionalCnicSchema });
type Values = z.input<typeof schema>;

/** slice-5 §3.4 create fields; the searched CNIC and phone are filled in. */
function NewGuardianForm({
  searched,
  guard,
  onCancel,
  onAdd,
}: {
  searched: Searched;
  guard: Guard;
  onCancel: () => void;
  onAdd: (guardian: Extract<GuardianEntry, { kind: 'new' }>['guardian']) => void;
}) {
  const [checking, setChecking] = useState(false);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      fullName: '',
      cnic: searched.cnic ? formatIdentityInput(searched.cnic) : '',
      phone: searched.phone ?? '',
      email: '',
      contactCapability: '',
      address: '',
    },
  });
  const onSubmit = form.handleSubmit(async (values) => {
    const cnic = values.cnic.trim() ? normaliseIdentityDigits(values.cnic) : null;
    // A CNIC typed here that was not the one searched is looked up too: the match cannot be skipped.
    if (cnic && cnic !== searched.cnic) {
      setChecking(true);
      try {
        const hits = await guard(() => lookupGuardians({ cnic }));
        if (hits.data.length > 0) {
          form.setError('cnic', {
            message: `${hits.data[0].guardian.fullName} is already on record with this CNIC. Cancel and link them instead.`,
          });
          return;
        }
      } catch (error) {
        applyApiError(form, error);
        return;
      } finally {
        setChecking(false);
      }
    }
    onAdd({
      fullName: values.fullName.trim(),
      cnic,
      phone: blankToNull(values.phone),
      email: blankToNull(values.email.toLowerCase()),
      contactCapability: values.contactCapability as ContactCapability,
      address: blankToNull(values.address),
    });
  });
  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-4">
      <FormRootError form={form} />
      <FormField control={form.control} name="fullName" label="Full name" maxLength={200} autoFocus />
      <FormField
        control={form.control}
        name="cnic"
        label="CNIC (optional)"
        hint="13 digits. Needed for a login: it becomes the username."
        inputMode="numeric"
        autoComplete="off"
        placeholder="#####-#######-#"
        maxLength={15}
        format={formatIdentityInput}
      />
      <ContactFields control={form.control} />
      <div className="flex gap-2">
        <Button type="submit" disabled={checking}>
          {checking ? 'Checking CNIC…' : 'Add guardian'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
