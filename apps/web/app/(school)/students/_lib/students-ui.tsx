'use client';

import { IssueLoginDialog } from '@/components/issue-login-dialog';
import { Badge } from '@/components/ui/badge';
import { unwrap } from '@/lib/api/client';
import {
  studentsApi,
  type DocumentType,
  type EnrolmentStatus,
  type Gender,
  type Relationship,
  type StudentCurrentDto,
  type StudentDetailDto,
  type StudentStatus,
} from '@/lib/api/school-students-contract';
import { todayInSchool } from '@/lib/format';

// Pieces shared by the students list, student detail, readmission and the admission wizard
// (contracts/slice-6.md §10).

export const studentsKeys = {
  all: ['school', 'students'] as const,
  list: ['school', 'students', 'list'] as const,
  detail: (id: string) => ['school', 'students', 'detail', id] as const,
  links: (id: string) => ['school', 'students', 'links', id] as const,
  enrolments: (id: string) => ['school', 'students', 'enrolments', id] as const,
  statusChanges: (id: string) => ['school', 'students', 'status-changes', id] as const,
  documents: (id: string) => ['school', 'students', 'documents', id] as const,
};

export const STUDENT_STATUS_LABELS: Record<StudentStatus, string> = {
  active: 'Active',
  suspended: 'Suspended',
  withdrawn: 'Withdrawn',
  transferred: 'Transferred',
  alumni: 'Alumni',
};
const STUDENT_STATUS_VARIANT = {
  active: 'secondary',
  suspended: 'destructive',
  withdrawn: 'outline',
  transferred: 'outline',
  alumni: 'ghost',
} as const satisfies Record<StudentStatus, string>;

export function StudentStatusBadge({ status }: { status: StudentStatus }) {
  return <Badge variant={STUDENT_STATUS_VARIANT[status]}>{STUDENT_STATUS_LABELS[status]}</Badge>;
}

export const GENDER_LABELS: Record<Gender, string> = { male: 'Male', female: 'Female' };

export const RELATIONSHIP_LABELS: Record<Relationship, string> = {
  father: 'Father',
  mother: 'Mother',
  guardian: 'Guardian',
  other: 'Other',
};

export const ENROLMENT_STATUS_LABELS: Record<EnrolmentStatus, string> = {
  active: 'Current',
  completed: 'Completed',
  left: 'Left',
};

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  b_form: 'B-Form',
  photo: 'Photo',
  previous_school_leaving: 'Previous school leaving certificate',
  guardian_cnic: 'Guardian CNIC',
  other: 'Other',
};

/** "Class 5 A", or null when the student has no current enrolment. */
export function placeLabel(current: Pick<StudentCurrentDto, 'className' | 'sectionName'> | null) {
  return current ? `${current.className} ${current.sectionName}` : null;
}

/** The detail fields both the edit form and the wizard validate (§3.5). */
export function dateOfBirthProblem(value: string, today = todayInSchool()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Enter the date of birth.';
  if (value > today) return 'The date of birth cannot be in the future.';
  const earliest = `${Number(today.slice(0, 4)) - 30}${today.slice(4)}`;
  if (value < earliest) return 'The date of birth is more than 30 years ago.';
  return null;
}

/** POST /students/:id/issue-login (contracts/slice-6.md §3.8, R40), confirmed in a dialog. */
export function IssueStudentLoginDialog({
  student,
  defaultReason,
  ...dialog
}: {
  student: Pick<StudentDetailDto, 'id' | 'fullName'>;
  /** Sent when the clerk gives none (the admission wizard: LOGIN_ISSUED_REASONS.admission). */
  defaultReason?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIssued?: () => void;
}) {
  return (
    <IssueLoginDialog
      {...dialog}
      fullName={student.fullName}
      description="The username is the student’s B-Form number without dashes. The password is the same number until they change it. Tell the family in person; nothing is sent to them."
      issue={(typed) => {
        const reason = typed ?? defaultReason;
        return unwrap(
          studentsApi.POST('/api/v1/students/{id}/issue-login', {
            params: { path: { id: student.id } },
            body: { ...(reason && { reason }) },
          }),
        );
      }}
      invalidate={studentsKeys.all}
    />
  );
}
