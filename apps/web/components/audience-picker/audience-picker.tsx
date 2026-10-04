'use client';

import {
  ROLE_AUDIENCE_KINDS,
  audiencesProblem,
  normaliseAudiences,
  type AudienceInput,
  type AudienceKind,
  type AudienceRole,
  type AudiencesProblemReason,
} from '@asms/shared';
import { PlusIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ClassSectionChooser, FamilyChooser, StaffChooser, StudentChooser, type Picked } from './audience-targets';

/**
 * The audience picker (contracts/slice-14.md §12.1): one controlled component over
 * `AudienceInput[]`, shared by announcements now and Phase 3 charge campaigns. It knows nothing
 * of announcements: the caller says what the sender may reach (`canSchoolWide`, `sectionScope`)
 * and hands in the server's preview counts; the picker emits `normaliseAudiences(value)` and
 * refuses locally with `audiencesProblem`, in the API's own words. The flow is concept slide 04's:
 * Everyone → by role → by class → by section → one student, family or staff member.
 */

/**
 * Where the sender's sections reach: `all` (every class and section), or the rows of today's
 * assignments — `sectionId: null` is a whole-class subject row, which reaches the whole class.
 */
export type AudienceSectionScope =
  | 'all'
  | readonly { classId: string; className: string; sectionId: string | null; sectionName: string | null }[];

/** The server's preview (`POST …/preview-audience`) as the picker shows it. */
export type AudiencePickerPreview = {
  byAudience?: readonly { kind: AudienceKind; targetId: string | null; targetName: string | null; persons: number }[];
  total?: number;
  pending: boolean;
};

/** A known name for a targeted item (an edited record's `audiences[].targetName`). */
export type AudienceLabel = { kind: AudienceKind; targetId: string | null; targetName: string | null };

type Step = 'everyone' | 'parents' | 'students' | 'staff' | 'class' | 'section' | 'student' | 'guardian' | 'staff_member';

const STEPS: { step: Step; label: string; schoolWide: boolean }[] = [
  { step: 'everyone', label: 'Everyone', schoolWide: true },
  { step: 'parents', label: 'All parents', schoolWide: true },
  { step: 'students', label: 'All students', schoolWide: true },
  { step: 'staff', label: 'All staff', schoolWide: true },
  { step: 'class', label: 'A class', schoolWide: false },
  { step: 'section', label: 'A section', schoolWide: false },
  { step: 'student', label: 'One student', schoolWide: false },
  { step: 'guardian', label: 'One family', schoolWide: false },
  { step: 'staff_member', label: 'One staff member', schoolWide: true },
];

const BROAD: Partial<Record<Step, string>> = {
  everyone: 'Every family, every student with a login and every member of staff. Each person once.',
  parents: 'Every guardian of a student at the school.',
  students: 'Every student who has a login.',
  staff: 'Every active member of staff.',
};

/** The API's 422 rules (§4.1) in words; `empty` is what a fresh form shows. */
export const AUDIENCE_PROBLEM_MESSAGES: Record<AudiencesProblemReason, string> = {
  empty: 'Choose who receives it.',
  too_many: 'Use at most 20 audience items. Choose a wider one instead.',
  everyone_not_alone: 'Everyone combines with nothing.',
  target_forbidden: 'This audience takes no class, section or person.',
  target_required: 'Choose the class, section or person.',
  roles_forbidden: 'Parents and students can be chosen only for a class, a section or a student.',
  roles_empty: 'Keep parents, students or both.',
  duplicate: 'The same audience is listed twice.',
};

const keyOf = (a: { kind: AudienceKind; targetId?: string | null }) => `${a.kind}:${a.targetId ?? ''}`;

const BROAD_NAMES: Partial<Record<AudienceKind, string>> = {
  everyone: 'Everyone',
  parents: 'All parents',
  students: 'All students',
  staff: 'All staff',
};
const KIND_PREFIX: Partial<Record<AudienceKind, string>> = { guardian: 'Family: ', staff_member: 'Staff: ' };

export function AudiencePicker({
  value,
  onChange,
  canSchoolWide,
  sectionScope,
  preview,
  initialLabels = [],
  invalid = null,
  disabled = false,
}: {
  value: readonly AudienceInput[];
  onChange: (next: AudienceInput[]) => void;
  /** `announcement.send.school` held: offers Everyone, all parents, all students, all staff and one staff member. */
  canSchoolWide: boolean;
  sectionScope: AudienceSectionScope;
  preview?: AudiencePickerPreview;
  initialLabels?: readonly AudienceLabel[];
  /** An item the server refused (`audiences[i].targetId`), highlighted with its message. */
  invalid?: { index: number; message: string } | null;
  disabled?: boolean;
}) {
  const steps = STEPS.filter((s) => canSchoolWide || !s.schoolWide);
  const [step, setStep] = useState<Step>(steps[0].step);
  // Names of chosen targets: from the record being edited, then from each pick (the API takes ids only).
  const [labels, setLabels] = useState<Record<string, string>>(() =>
    Object.fromEntries(initialLabels.filter((l) => l.targetName).map((l) => [keyOf(l), l.targetName as string])),
  );
  const hasEveryone = value.some((a) => a.kind === 'everyone');
  const problem = audiencesProblem(value);

  const emit = (next: AudienceInput[]) => onChange(normaliseAudiences(next));
  const add = (item: AudienceInput, name?: string) => {
    if (name && item.targetId) setLabels((before) => ({ ...before, [keyOf(item)]: name }));
    emit([...value, item]);
  };
  const addTarget = (kind: AudienceKind) => (picked: Picked) => add({ kind, targetId: picked.targetId }, picked.targetName);
  const remove = (index: number) => emit(value.filter((_, i) => i !== index));
  const setRoles = (index: number, roles: AudienceRole[] | undefined) =>
    emit(value.map((a, i) => (i === index ? { kind: a.kind, ...(a.targetId && { targetId: a.targetId }), ...(roles && { roles }) } : a)));

  const nameOf = (a: AudienceInput) =>
    BROAD_NAMES[a.kind] ??
    `${KIND_PREFIX[a.kind] ?? ''}${labels[keyOf(a)] ?? preview?.byAudience?.find((p) => keyOf(p) === keyOf(a))?.targetName ?? '…'}`;
  const personsOf = (a: AudienceInput) => preview?.byAudience?.find((p) => keyOf(p) === keyOf(a))?.persons;
  const lockedByEveryone = hasEveryone && step !== 'everyone';
  const addDisabled = disabled || lockedByEveryone;
  const current = steps.find((s) => s.step === step) ?? steps[0];

  return (
    <div className="grid gap-3" data-testid="audience-picker">
      <div role="radiogroup" aria-label="Audience type" className="flex flex-wrap gap-1.5">
        {steps.map((s) => (
          <button
            key={s.step}
            type="button"
            role="radio"
            aria-checked={step === s.step}
            disabled={disabled}
            onClick={() => setStep(s.step)}
            className={cn(
              'rounded-lg border px-2.5 py-1 text-sm transition-colors disabled:opacity-50',
              step === s.step ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="rounded-lg border bg-muted/30 p-3" aria-label={`Add ${current.label.toLowerCase()}`} role="group">
        {lockedByEveryone ? (
          <p className="text-sm text-muted-foreground">Everyone already includes this. Remove Everyone to choose a narrower audience.</p>
        ) : BROAD[step] ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">{BROAD[step]}</p>
            <Button
              type="button"
              variant="outline"
              disabled={addDisabled || value.some((a) => a.kind === step)}
              onClick={() => add({ kind: step as AudienceKind })}
            >
              <PlusIcon />
              Add {current.label.toLowerCase()}
            </Button>
          </div>
        ) : step === 'class' || step === 'section' ? (
          <ClassSectionChooser
            key={step}
            scope={sectionScope}
            level={step}
            disabled={addDisabled}
            onAdd={(kind, picked) => addTarget(kind)(picked)}
          />
        ) : step === 'student' ? (
          <StudentChooser disabled={addDisabled} onAdd={addTarget('student')} />
        ) : step === 'guardian' ? (
          <FamilyChooser disabled={addDisabled} onAdd={addTarget('guardian')} />
        ) : (
          <StaffChooser disabled={addDisabled} onAdd={addTarget('staff_member')} />
        )}
      </div>

      {value.length > 0 && (
        <ul className="grid gap-1.5" aria-label="Chosen audience">
          {value.map((a, index) => {
            const persons = personsOf(a);
            const refused = invalid?.index === index ? invalid.message : null;
            const takesRoles = (ROLE_AUDIENCE_KINDS as readonly string[]).includes(a.kind);
            const name = nameOf(a);
            return (
              <li
                key={keyOf(a)}
                data-testid="audience-chip"
                data-invalid={refused ? true : undefined}
                className={cn(
                  'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card px-3 py-1.5 text-sm',
                  refused && 'border-destructive',
                )}
              >
                <span className="font-medium">{name}</span>
                {persons !== undefined && (
                  <span className="text-muted-foreground tabular-nums">
                    {persons} {persons === 1 ? 'person' : 'people'}
                  </span>
                )}
                {takesRoles && <RoleToggles roles={a.roles} disabled={disabled} label={name} onChange={(roles) => setRoles(index, roles)} />}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto"
                  disabled={disabled}
                  aria-label={`Remove ${name}`}
                  onClick={() => remove(index)}
                >
                  <XIcon />
                </Button>
                {refused && <p className="basis-full text-xs text-destructive">{refused}</p>}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm" aria-live="polite">
        {problem ? (
          <span className={problem.reason === 'empty' ? 'text-muted-foreground' : 'text-destructive'}>
            {AUDIENCE_PROBLEM_MESSAGES[problem.reason]}
          </span>
        ) : (
          <span data-testid="audience-total">
            {preview?.total !== undefined
              ? `${preview.total} ${preview.total === 1 ? 'person' : 'people'} in total, each once`
              : preview?.pending
                ? 'Counting…'
                : ''}
          </span>
        )}
      </div>
    </div>
  );
}

/** Parents / Students on a class, section or student chip; absent roles means both, and one stays on. */
function RoleToggles({
  roles,
  disabled,
  label,
  onChange,
}: {
  roles: AudienceRole[] | undefined;
  disabled: boolean;
  label: string;
  onChange: (roles: AudienceRole[] | undefined) => void;
}) {
  const on = (role: AudienceRole) => roles === undefined || roles.includes(role);
  const toggle = (role: AudienceRole) => {
    const other: AudienceRole = role === 'parents' ? 'students' : 'parents';
    onChange(on(role) ? [other] : undefined);
  };
  return (
    <span className="inline-flex rounded-md border p-0.5" role="group" aria-label={`Who in ${label}`}>
      {(['parents', 'students'] as const).map((role) => (
        <button
          key={role}
          type="button"
          aria-pressed={on(role)}
          // The last one on stays on: an item reaches somebody.
          disabled={disabled || (roles?.length === 1 && roles[0] === role)}
          onClick={() => toggle(role)}
          className={cn(
            'rounded px-2 py-0.5 text-xs capitalize transition-colors',
            on(role) ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground line-through',
          )}
        >
          {role}
        </button>
      ))}
    </span>
  );
}
