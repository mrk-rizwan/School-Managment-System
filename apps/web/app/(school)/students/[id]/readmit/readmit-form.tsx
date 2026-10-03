'use client';

import { Capability, ErrorCode, READMISSIBLE_STATUSES } from '@asms/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import {
  BackLink,
  EmptyState,
  NoPermissionState,
  QueryStates,
  StateCard,
} from '@/components/page-states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { unwrap } from '@/lib/api/client';
import { ApiError, describeApiError } from '@/lib/api/errors';
import {
  studentsApi,
  type StudentDetailDto,
} from '@/lib/api/school-students-contract';
import { formatDay, todayInSchool } from '@/lib/format';
import { useCapabilities } from '@/lib/school-session';
import { ReauthAbandoned, useReauth } from '../../../admissions/_lib/reauth';
import { NO_PLACEMENT, PlacementSelects, type Placement } from '../../_lib/placement';
import { STUDENT_STATUS_LABELS, studentsKeys } from '../../_lib/students-ui';

/**
 * POST /students/:id/readmit (contracts/slice-6.md §3.7, R26): a new active enrolment, the same
 * admission number, the guardian links kept. The reason is asked for by the shared dialog.
 */
export function ReadmitForm({ id }: { id: string }) {
  const { can } = useCapabilities();
  const student = useQuery({
    queryKey: studentsKeys.detail(id),
    queryFn: () => unwrap(studentsApi.GET('/api/v1/students/{id}', { params: { path: { id } } })),
  });

  return (
    <>
      <BackLink href={`/students/${id}`}>Student</BackLink>
      <QueryStates
        query={student}
        loadingRows={4}
        notFound={{ title: 'Student not found', description: 'Find them in the students list.' }}
      >
        {(data) => {
          if (!can(Capability.STUDENT_CREATE)) {
            return (
              <StateCard>
                <NoPermissionState />
              </StateCard>
            );
          }
          if (!READMISSIBLE_STATUSES.includes(data.status)) {
            return (
              <StateCard>
                <EmptyState
                  title={`${data.fullName} is ${STUDENT_STATUS_LABELS[data.status].toLowerCase()}`}
                  description="Only a withdrawn, transferred or alumni student can be readmitted."
                  action={
                    <Link href={`/students/${id}`} className={buttonVariants({ variant: 'outline' })}>
                      Open the record
                    </Link>
                  }
                />
              </StateCard>
            );
          }
          return <ReadmitCard student={data} />;
        }}
      </QueryStates>
    </>
  );
}

function ReadmitCard({ student }: { student: StudentDetailDto }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const ids = { roll: useId(), date: useId() };
  const today = todayInSchool();
  const [placement, setPlacement] = useState<Placement>(NO_PLACEMENT);
  const [rollNo, setRollNo] = useState('');
  const [readmittedOn, setReadmittedOn] = useState(today);
  const [confirming, setConfirming] = useState(false);
  // A lost session asks for the password here instead of leaving the form (and its choices).
  const { guard, dialog } = useReauth();

  const roll = rollNo.trim() === '' ? undefined : Number(rollNo);
  const rollInvalid = roll !== undefined && (!Number.isInteger(roll) || roll < 1 || roll > 9999);
  const dateProblem = readmittedOn > today ? 'The date cannot be in the future.' : null;
  const complete = placement.classId !== '' && placement.sectionId !== '' && !rollInvalid && !dateProblem;

  const readmit = useMutation({
    mutationFn: (reason: string) =>
      guard(() =>
        unwrap(
          studentsApi.POST('/api/v1/students/{id}/readmit', {
            params: { path: { id: student.id } },
            body: {
              classId: placement.classId,
              sectionId: placement.sectionId,
              ...(roll !== undefined && { rollNo: roll }),
              readmittedOn,
              reason,
            },
          }),
        ),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(studentsKeys.detail(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: studentsKeys.all });
      toast.success(`${updated.fullName} is readmitted.`);
      router.push(`/students/${updated.id}`);
    },
    onError: (error) => {
      // A resubmit after a lost response: the student is no longer readmissible (§3.7).
      if (error instanceof ApiError && error.code === ErrorCode.ILLEGAL_STATUS_TRANSITION) {
        void queryClient.invalidateQueries({ queryKey: studentsKeys.detail(student.id) });
      }
      setConfirming(false);
    },
  });

  const error = readmit.error;
  const fields = error instanceof ApiError ? error.fieldErrors : [];
  const fieldError = (path: string) => fields.find((f) => f.path === path)?.message;
  // Field errors without a field on this card (the reason, say) go in the alert.
  const otherFields = fields.filter((f) => !['classId', 'sectionId', 'rollNo', 'readmittedOn'].includes(f.path));
  const rollTaken = error instanceof ApiError && error.code === ErrorCode.ROLL_NO_TAKEN;
  const linksProblem =
    error instanceof ApiError &&
    (error.code === ErrorCode.PRIMARY_CONTACT_REQUIRED || error.code === ErrorCode.FEE_PAYER_REQUIRED);

  return (
    <>
      <PageHeader
        title={`Readmit ${student.fullName}`}
        description={`Admission no. ${student.admissionNo} is kept. ${STUDENT_STATUS_LABELS[student.status]} now; admitted ${formatDay(student.admittedOn)}.`}
      />
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Class and section</CardTitle>
          <CardDescription>The student’s guardian links are kept as they are.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            noValidate
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (complete) setConfirming(true);
            }}
          >
            {error && !rollTaken && (fields.length === 0 || otherFields.length > 0) && (
              <Alert variant="destructive">
                <AlertDescription>
                  {otherFields.length > 0
                    ? otherFields.map((f) => f.message).join(' ')
                    : error instanceof ReauthAbandoned
                      ? error.message
                      : describeApiError(error)}{' '}
                  {linksProblem && (
                    <Link href={`/students/${student.id}`} className="font-medium underline underline-offset-4">
                      Fix the guardian links first
                    </Link>
                  )}
                </AlertDescription>
              </Alert>
            )}
            <div className="grid gap-4 sm:grid-cols-3">
              <PlacementSelects
                value={placement}
                onChange={setPlacement}
                errors={{ classId: fieldError('classId'), sectionId: fieldError('sectionId') }}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor={ids.roll}>Roll number (optional)</Label>
                <Input
                  id={ids.roll}
                  value={rollNo}
                  inputMode="numeric"
                  maxLength={4}
                  aria-invalid={rollInvalid || rollTaken ? true : undefined}
                  onChange={(event) => setRollNo(event.target.value.replace(/\D/g, ''))}
                />
                {(rollInvalid || rollTaken || fieldError('rollNo')) && (
                  <p className="text-xs text-destructive">
                    {rollInvalid ? 'Enter a number from 1 to 9999.' : rollTaken ? (error as ApiError).message : fieldError('rollNo')}
                  </p>
                )}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={ids.date}>Readmitted on</Label>
                <Input
                  id={ids.date}
                  type="date"
                  value={readmittedOn}
                  max={today}
                  aria-invalid={dateProblem ? true : undefined}
                  onChange={(event) => setReadmittedOn(event.target.value)}
                />
                {(dateProblem || fieldError('readmittedOn')) && (
                  <p className="text-xs text-destructive">{dateProblem ?? fieldError('readmittedOn')}</p>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-2 pt-2">
              <Button type="submit" disabled={!complete || readmit.isPending}>
                Readmit…
              </Button>
              <Link href={`/students/${student.id}`} className={buttonVariants({ variant: 'outline' })}>
                Cancel
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
      <ConfirmWithReasonDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Readmit ${student.fullName}?`}
        description="The student becomes active again in the chosen class. The reason is kept in the status history."
        confirmLabel="Readmit"
        minLength={3}
        maxLength={500}
        pending={readmit.isPending}
        onConfirm={(reason) => readmit.mutate(reason)}
      />
      {dialog}
    </>
  );
}
