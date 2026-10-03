'use client';

import { Capability, ErrorCode, LOGIN_ISSUED_REASONS, newIdempotencyKey } from '@asms/shared';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2Icon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { BackLink, NoPermissionState, StateCard } from '@/components/page-states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { ApiError, describeApiError } from '@/lib/api/errors';
import { guardiansApi } from '@/lib/api/school-guardians-contract';
import {
  studentsApi,
  type AdmissionBody,
  type AdmissionResultDto,
  type DuplicateMatchDto,
  type Relationship,
} from '@/lib/api/school-students-contract';
import { formatDay, todayInSchool } from '@/lib/format';
import { useCapabilities } from '@/lib/school-session';
import { cn } from '@/lib/utils';
import { guardiansKeys } from '../../guardians/_lib/guardians-ui';
import { useClasses, useSections, useYears } from '../../academics/_lib/options';
import {
  DOCUMENT_TYPE_LABELS,
  GENDER_LABELS,
  IssueStudentLoginDialog,
  RELATIONSHIP_LABELS,
  STUDENT_STATUS_LABELS,
  studentsKeys,
} from '../../students/_lib/students-ui';
import { ReauthAbandoned, useReauth } from '../_lib/reauth';
import { GuardiansStep } from './guardians-step';
import { DocumentsStep, PlacementStep } from './other-steps';
import { StudentStep } from './student-step';
import {
  guardianName,
  type DocumentEntry,
  type Guard,
  type GuardianEntry,
  type PlacementDraft,
  type StudentDraft,
} from './wizard-types';

const STEPS = ['Student', 'Guardians', 'Class and section', 'Documents', 'Review and submit'] as const;

/** 32 characters of [0-9a-f]: inside the API's `^[A-Za-z0-9_-]{16,64}$`. */

/**
 * The admission wizard (plan §5 slice 6, contracts/slice-6.md §6.3, §10). Remounted by
 * "Admit another student", so every admission starts with fresh state and a fresh key.
 */
export function AdmissionWizardPage() {
  const { can } = useCapabilities();
  const [run, setRun] = useState(0);
  if (!can(Capability.STUDENT_CREATE)) {
    return (
      <>
        <PageHeader title="New admission" />
        <StateCard>
          <NoPermissionState />
        </StateCard>
      </>
    );
  }
  return <AdmissionWizard key={run} onRestart={() => setRun((n) => n + 1)} />;
}

const EMPTY_STUDENT: StudentDraft = {
  checked: false,
  bForm: null,
  fullName: '',
  gender: '',
  dateOfBirth: '',
  admittedOn: '',
  notes: '',
};

function AdmissionWizard({ onRestart }: { onRestart: () => void }) {
  const queryClient = useQueryClient();
  const { guard, dialog } = useReauth();
  // Generated once when the wizard opens and reused by every resubmit (R82–R89). In memory only.
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  const [student, setStudent] = useState<StudentDraft>(() => ({ ...EMPTY_STUDENT, admittedOn: todayInSchool() }));
  const [guardians, setGuardians] = useState<GuardianEntry[]>([]);
  const [placement, setPlacement] = useState<PlacementDraft>({
    academicYearId: '',
    classId: '',
    sectionId: '',
    rollNo: '',
  });
  const [documents, setDocuments] = useState<DocumentEntry[]>([]);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [result, setResult] = useState<AdmissionResultDto | null>(null);

  const dirty = student.checked || guardians.length > 0 || documents.length > 0;
  useEffect(() => {
    if (!dirty || result) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, result]);

  const goTo = (next: number) => {
    setStep(next);
    setReached((r) => Math.max(r, next));
  };

  if (result) {
    return (
      <>
        {dialog}
        <AdmissionDone result={result} onRestart={onRestart} />
      </>
    );
  }

  const body = (): AdmissionBody => ({
    student: {
      fullName: student.fullName.trim(),
      gender: student.gender as AdmissionBody['student']['gender'],
      dateOfBirth: student.dateOfBirth,
      admittedOn: student.admittedOn,
      ...(student.bForm && { bForm: student.bForm }),
      ...(student.notes.trim() && { notes: student.notes.trim() }),
    },
    guardians: guardians.map((g) => {
      const flags = {
        relationship: g.relationship as Relationship,
        isPrimaryContact: g.isPrimaryContact,
        isFeePayer: g.isFeePayer,
        canLogin: g.canLogin,
      };
      return g.kind === 'existing' ? { ...flags, guardianId: g.guardianId } : { ...flags, newGuardian: g.guardian };
    }),
    enrolment: {
      classId: placement.classId,
      sectionId: placement.sectionId,
      ...(placement.rollNo && { rollNo: Number(placement.rollNo) }),
    },
    ...(documents.length > 0 && {
      documents: documents.map(({ stagedUploadId, type }) => ({ stagedUploadId, type })),
    }),
  });

  return (
    <>
      {dialog}
      <BackLink href="/students">Students</BackLink>
      <PageHeader title="New admission" description="Nothing is saved until the last step." />
      <ol className="mb-6 flex flex-wrap gap-x-4 gap-y-2 text-sm" aria-label="Admission steps">
        {STEPS.map((label, index) => (
          <li key={label}>
            <button
              type="button"
              disabled={index > reached}
              aria-current={index === step ? 'step' : undefined}
              onClick={() => setStep(index)}
              className={cn(
                'inline-flex items-center gap-2 rounded px-1 disabled:cursor-not-allowed',
                index === step ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                index > reached && 'opacity-50',
              )}
            >
              <span
                className={cn(
                  'flex size-6 items-center justify-center rounded-full border text-xs tabular-nums',
                  index === step && 'border-primary bg-primary text-primary-foreground',
                )}
              >
                {index + 1}
              </span>
              {label}
            </button>
          </li>
        ))}
      </ol>
      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>{STEPS[step]}</CardTitle>
        </CardHeader>
        <CardContent>
          {step === 0 && (
            <StudentStep draft={student} onChange={setStudent} onNext={() => goTo(1)} guard={guard} />
          )}
          {step === 1 && (
            <GuardiansStep
              entries={guardians}
              onChange={setGuardians}
              onBack={() => setStep(0)}
              onNext={() => goTo(2)}
              guard={guard}
            />
          )}
          {step === 2 && (
            <PlacementStep
              value={placement}
              onChange={setPlacement}
              onBack={() => setStep(1)}
              onNext={() => goTo(3)}
              guard={guard}
            />
          )}
          {step === 3 && (
            <DocumentsStep
              entries={documents}
              onChange={setDocuments}
              onBack={() => setStep(2)}
              onNext={() => goTo(4)}
              guard={guard}
            />
          )}
          {step === 4 && (
            <ReviewStep
              student={student}
              guardians={guardians}
              placement={placement}
              documents={documents}
              guard={guard}
              onEdit={setStep}
              submit={async (acknowledgeIds) => {
                const ids = [...new Set([...acknowledged, ...acknowledgeIds])];
                setAcknowledged(ids);
                const payload = { ...body(), ...(ids.length > 0 && { acknowledgedDuplicateStudentIds: ids }) };
                const admitted = await guard(() =>
                  unwrap(
                    studentsApi.POST('/api/v1/admissions', {
                      params: { header: { 'Idempotency-Key': idempotencyKey } },
                      body: payload,
                    }),
                  ),
                );
                void queryClient.invalidateQueries({ queryKey: studentsKeys.all });
                void queryClient.invalidateQueries({ queryKey: guardiansKeys.all });
                // The identity digits leave memory with the wizard's drafts.
                setStudent(EMPTY_STUDENT);
                setGuardians([]);
                setResult(admitted);
              }}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}

/** Which step a refusal sends the office back to. */
const CODE_STEP: Partial<Record<string, number>> = {
  [ErrorCode.STUDENT_BFORM_EXISTS]: 0,
  [ErrorCode.GUARDIAN_CNIC_EXISTS]: 1,
  [ErrorCode.GUARDIAN_MERGED]: 1,
  [ErrorCode.PRIMARY_CONTACT_NEEDS_PHONE]: 1,
  [ErrorCode.ROLL_NO_TAKEN]: 2,
  [ErrorCode.SECTION_ARCHIVED]: 2,
  [ErrorCode.CLASS_ARCHIVED]: 2,
  [ErrorCode.ACADEMIC_YEAR_CLOSED]: 2,
};
const PATH_STEP: Record<string, number> = { student: 0, guardians: 1, enrolment: 2, documents: 3 };

function ReviewStep({
  student,
  guardians,
  placement,
  documents,
  guard,
  onEdit,
  submit,
}: {
  student: StudentDraft;
  guardians: GuardianEntry[];
  placement: PlacementDraft;
  documents: DocumentEntry[];
  guard: Guard;
  onEdit: (step: number) => void;
  submit: (acknowledgeIds: string[]) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const years = useYears(guard);
  const classes = useClasses(placement.academicYearId, { call: guard });
  const sections = useSections(placement.classId, guard);
  const name = (list: { id: string; name: string }[] | undefined, id: string) =>
    list?.find((x) => x.id === id)?.name ?? '…';

  const send = async (acknowledgeIds: string[] = []) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await submit(acknowledgeIds);
    } catch (e) {
      setError(e);
      setPending(false);
    }
  };

  const apiError = error instanceof ApiError ? error : null;
  const matches =
    apiError?.code === ErrorCode.ADMISSION_POSSIBLE_DUPLICATE
      ? ((apiError.details as { matches?: DuplicateMatchDto[] } | null)?.matches ?? [])
      : null;

  const row = (label: string, value: React.ReactNode, key = label) => (
    <div key={key} className="grid grid-cols-[10rem_1fr] gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
  const section = (title: string, step: number, children: React.ReactNode) => (
    <section className="grid gap-2 border-b pb-4 last:border-b-0">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => onEdit(step)}>
          Edit
        </Button>
      </div>
      <dl className="grid gap-1.5">{children}</dl>
    </section>
  );

  return (
    <div className="grid gap-4">
      {section(
        'Student',
        0,
        <>
          {row('Name', student.fullName)}
          {row('Gender', student.gender ? GENDER_LABELS[student.gender] : '—')}
          {row('Date of birth', student.dateOfBirth ? formatDay(student.dateOfBirth) : '—')}
          {row('Admission date', formatDay(student.admittedOn))}
          {row('B-Form', student.bForm ? 'Recorded' : 'Not recorded')}
        </>,
      )}
      {section(
        'Guardians',
        1,
        guardians.map((g) =>
          row(
            guardianName(g),
            [
              g.relationship ? RELATIONSHIP_LABELS[g.relationship] : '',
              g.isPrimaryContact && 'primary contact',
              g.isFeePayer && 'pays fees',
              g.canLogin && 'may log in',
              g.kind === 'new' && 'new record',
            ]
              .filter(Boolean)
              .join(', '),
            g.key,
          ),
        ),
      )}
      {section(
        'Class and section',
        2,
        <>
          {row('Academic year', name(years.data?.data, placement.academicYearId))}
          {row(
            'Class',
            `${name(classes.data?.data, placement.classId)} ${name(sections.data?.data, placement.sectionId)}`,
          )}
          {row('Roll number', placement.rollNo || 'Not set')}
        </>,
      )}
      {section(
        'Documents',
        3,
        documents.length === 0
          ? row('Documents', 'None')
          : documents.map((d) => row(DOCUMENT_TYPE_LABELS[d.type], d.fileName, d.stagedUploadId)),
      )}

      {matches ? (
        <DuplicateWarning
          matches={matches}
          pending={pending}
          onConfirm={() => void send(matches.map((m) => m.studentId))}
        />
      ) : (
        error !== null && <SubmitError error={error} onEdit={onEdit} />
      )}

      <div className="flex justify-between pt-2">
        <Button type="button" variant="outline" disabled={pending} onClick={() => onEdit(3)}>
          Back
        </Button>
        {!matches && (
          <Button type="button" disabled={pending} onClick={() => void send()}>
            {pending ? 'Admitting…' : 'Admit student'}
          </Button>
        )}
      </div>
    </div>
  );
}

/** ADMISSION_POSSIBLE_DUPLICATE (R88): nothing was written; the office confirms or stops. */
function DuplicateWarning({
  matches,
  pending,
  onConfirm,
}: {
  matches: DuplicateMatchDto[];
  pending: boolean;
  onConfirm: () => void;
}) {
  return (
    <Alert role="alert">
      <AlertTitle>This may be a child already on record</AlertTitle>
      <AlertDescription>
        <p>Same name, date of birth and primary guardian as:</p>
        <ul className="my-2 grid gap-1">
          {matches.map((m) => (
            <li key={m.studentId}>
              {/* A new tab, so the wizard and its answers stay open here. */}
              <a
                href={`/students/${m.studentId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-foreground underline underline-offset-4"
              >
                {m.fullName}
              </a>{' '}
              — admission no. {m.admissionNo}, born {formatDay(m.dateOfBirth)},{' '}
              {STUDENT_STATUS_LABELS[m.status].toLowerCase()}
              {m.className ? `, ${m.className}` : ''}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button type="button" disabled={pending} onClick={onConfirm}>
            {pending ? 'Admitting…' : 'These are different children — admit'}
          </Button>
          <Link href="/students" className={buttonVariants({ variant: 'outline' })}>
            Stop this admission
          </Link>
        </div>
      </AlertDescription>
    </Alert>
  );
}

function SubmitError({ error, onEdit }: { error: unknown; onEdit: (step: number) => void }) {
  if (error instanceof ReauthAbandoned) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  }
  const apiError = error instanceof ApiError ? error : null;
  const fields = apiError?.fieldErrors ?? [];
  const details = (apiError?.details ?? null) as { studentId?: string; readmissible?: boolean } | null;
  const step = apiError ? CODE_STEP[apiError.code] : undefined;

  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>The student was not admitted</AlertTitle>
      <AlertDescription>
        {fields.length > 0 ? (
          <ul className="grid gap-1">
            {fields.map((f) => {
              const target = PATH_STEP[f.path.split('.')[0]];
              return (
                <li key={`${f.path}-${f.code}`}>
                  {f.message}{' '}
                  {target !== undefined && (
                    <button type="button" className="underline underline-offset-4" onClick={() => onEdit(target)}>
                      Go to {STEPS[target].toLowerCase()}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p>
            {describeApiError(error)}{' '}
            {apiError?.code === ErrorCode.STUDENT_BFORM_EXISTS && details?.studentId && (
              <Link
                href={details.readmissible ? `/students/${details.studentId}/readmit` : `/students/${details.studentId}`}
                className="font-medium underline underline-offset-4"
              >
                {details.readmissible ? 'Readmit that student' : 'Open that student'}
              </Link>
            )}
            {apiError?.code === ErrorCode.IDEMPOTENCY_KEY_REUSED && (
              <Link href="/students" className="font-medium underline underline-offset-4">
                Check the students list
              </Link>
            )}
            {step !== undefined && (
              <button type="button" className="underline underline-offset-4" onClick={() => onEdit(step)}>
                Go to {STEPS[step].toLowerCase()}
              </button>
            )}
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** The result, then the login offers (§6.3 `loginOffers`). */
function AdmissionDone({ result, onRestart }: { result: AdmissionResultDto; onRestart: () => void }) {
  const { can } = useCapabilities();
  const canIssue = can(Capability.USER_ACCOUNT_MANAGE);
  const { student, enrolment, loginOffers } = result;
  const [studentLoginOpen, setStudentLoginOpen] = useState(false);
  const [studentIssued, setStudentIssued] = useState(false);
  const offers = loginOffers.guardians.filter((g) => g.available);
  const showOffers = canIssue && (loginOffers.student || offers.length > 0);

  return (
    <>
      <PageHeader title="Admission complete" />
      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2Icon className="size-5 text-primary" aria-hidden="true" />
            {student.fullName} is admitted
          </CardTitle>
          <CardDescription>
            Admission no. {student.admissionNo}, {enrolment.className} {enrolment.sectionName},{' '}
            {enrolment.academicYearName}.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          {showOffers && (
            <section className="grid gap-3">
              <h3 className="text-sm font-semibold">Logins</h3>
              <p className="text-sm text-muted-foreground">
                The username is the person’s CNIC or B-Form number without dashes, and so is the
                password until they change it. Tell them in person; nothing is sent.
              </p>
              <ul className="grid gap-2">
                {loginOffers.student && (
                  <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
                    <span>{student.fullName} (student)</span>
                    {studentIssued ? (
                      <span className="text-muted-foreground">Login issued</span>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => setStudentLoginOpen(true)}>
                        Issue login
                      </Button>
                    )}
                  </li>
                )}
                {offers.map((g) => (
                  <GuardianLoginOffer key={g.guardianId} guardianId={g.guardianId} fullName={g.fullName} />
                ))}
              </ul>
              <IssueStudentLoginDialog
                student={student}
                defaultReason={LOGIN_ISSUED_REASONS.admission}
                open={studentLoginOpen}
                onOpenChange={setStudentLoginOpen}
                onIssued={() => setStudentIssued(true)}
              />
            </section>
          )}
          <div className="flex flex-wrap gap-2">
            <Link href={`/students/${student.id}`} className={buttonVariants()}>
              Open the student’s record
            </Link>
            <Button variant="outline" onClick={onRestart}>
              Admit another student
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

/** POST /guardians/:id/issue-login (slice 5 §3.7) for a guardian the admission made eligible. */
function GuardianLoginOffer({ guardianId, fullName }: { guardianId: string; fullName: string }) {
  const [state, setState] = useState<'idle' | 'pending' | 'issued'>('idle');
  const [error, setError] = useState<unknown>(null);
  const issue = async () => {
    setState('pending');
    setError(null);
    try {
      await unwrap(
        guardiansApi.POST('/api/v1/guardians/{id}/issue-login', {
          params: { path: { id: guardianId } },
          // R57: the audit row says the login was issued at admission.
          body: { reason: LOGIN_ISSUED_REASONS.admission },
        }),
      );
      setState('issued');
    } catch (e) {
      // A resubmit after a lost response: the login exists, which is what was wanted.
      if (e instanceof ApiError && e.code === ErrorCode.LOGIN_ALREADY_EXISTS) return setState('issued');
      setError(e);
      setState('idle');
    }
  };
  return (
    <li className="grid gap-1 rounded-lg border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{fullName} (guardian)</span>
        {state === 'issued' ? (
          <span className="text-muted-foreground">Login issued</span>
        ) : (
          <Button size="sm" variant="outline" disabled={state === 'pending'} onClick={() => void issue()}>
            {state === 'pending' ? 'Issuing…' : 'Issue login'}
          </Button>
        )}
      </div>
      {Boolean(error) && <p className="text-xs text-destructive">{describeApiError(error)}</p>}
    </li>
  );
}
