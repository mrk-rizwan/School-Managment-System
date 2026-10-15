'use client';

import { formatPercentLabel, formatRupees } from '@asms/shared';
import { useQuery } from '@tanstack/react-query';
import { PrinterIcon } from 'lucide-react';
import { BackLink, QueryStates } from '@/components/page-states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { unwrap } from '@/lib/api/client';
import { studentsApi, type StudentProfileDto } from '@/lib/api/school-students-contract';
import { formatDay } from '@/lib/format';
import { DocumentStatusBadge } from '../../../documents/_lib/documents-ui';
import { DOCUMENT_TYPE_LABELS, STUDENT_STATUS_LABELS, studentsKeys } from '../../_lib/students-ui';

// The one-page student profile (Phase 5 slice 42, R334; contracts/slice-42.md §2.3), laid out to
// print: who the student is, this year's attendance, the latest published result, and, for
// callers who hold their keys, the dues and the document checklist (the API returns null
// otherwise, and the section is left out). No identity number.

export function StudentProfile({ id }: { id: string }) {
  const profile = useQuery({
    queryKey: [...studentsKeys.all, 'profile', id],
    queryFn: () => unwrap(studentsApi.GET('/api/v1/students/{id}/profile', { params: { path: { id } } })),
  });

  return (
    <>
      <div className="print:hidden">
        <BackLink href={`/students/${id}`}>Student</BackLink>
      </div>
      <QueryStates query={profile} notFound={{ title: 'Student not found', description: 'Find them in the students list.' }}>
        {(data) => <Profile data={data} />}
      </QueryStates>
    </>
  );
}

function Profile({ data }: { data: StudentProfileDto }) {
  const place = data.current ? `${data.current.className} ${data.current.sectionName}` : 'Not enrolled';
  return (
    <article className="mx-auto grid max-w-3xl gap-6 print:max-w-none" data-testid="student-profile">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{data.fullName}</h1>
          <p className="text-sm text-muted-foreground">
            Admission no. {data.admissionNo} · {place}
            {data.current && ` · ${data.current.academicYearName}`}
            {data.current?.rollNo != null && ` · Roll ${data.current.rollNo}`}
          </p>
          <p className="text-sm text-muted-foreground">
            {STUDENT_STATUS_LABELS[data.status]} · Admitted {formatDay(data.admittedOn)} · Born {formatDay(data.dateOfBirth)}
          </p>
        </div>
        <Button variant="outline" className="print:hidden" onClick={() => window.print()}>
          <PrinterIcon />
          Print
        </Button>
      </header>

      <Section title="Attendance">
        {data.attendance === null ? (
          <Muted>No attendance this year yet.</Muted>
        ) : (
          <>
            <Lines
              lines={[
                ['Attendance', data.attendance.percentage === null ? '—' : `${data.attendance.percentage.toFixed(1)}%`],
                ['Days recorded', String(data.attendance.countedDays)],
                ['Present', String(data.attendance.present)],
                ['Absent', String(data.attendance.absent)],
                ['Late', String(data.attendance.late)],
                ['On leave', String(data.attendance.onLeave)],
              ]}
            />
            <Muted>
              {formatDay(data.attendance.dateFrom)} to {formatDay(data.attendance.dateTo)}
            </Muted>
          </>
        )}
      </Section>

      <Section
        title="Latest result"
        badge={data.latestResult?.revised ? <Badge variant="secondary">Revised</Badge> : undefined}
      >
        {data.latestResult === null ? (
          <Muted>No published result yet.</Muted>
        ) : (
          <Lines
            lines={[
              [
                'Result',
                `${data.latestResult.isFinal ? 'Final result' : (data.latestResult.termName ?? '')} · ${data.latestResult.className} ${data.latestResult.sectionName} · ${data.latestResult.academicYearName}`,
              ],
              ['Percentage', formatPercentLabel(data.latestResult.percentBp)],
              ['Grade', data.latestResult.grade ?? '—'],
              ['Position in section', ofLabel(data.latestResult.position, data.latestResult.positionOf)],
              ...(data.latestResult.classPosition !== null
                ? [['Position in class', ofLabel(data.latestResult.classPosition, data.latestResult.classPositionOf)] as const]
                : []),
            ]}
          />
        )}
      </Section>

      {data.dues && (
        <Section title="Dues">
          <Lines
            lines={[
              ['Outstanding', formatRupees(data.dues.outstanding)],
              ['Paid in advance', formatRupees(data.dues.advance)],
              ['Cleared', data.dues.cleared ? 'Yes' : 'No'],
            ]}
          />
        </Section>
      )}

      {data.documents && (
        <Section
          title="Documents"
          badge={<Badge variant={data.documents.complete ? 'secondary' : 'outline'}>{data.documents.complete ? 'Complete' : 'Incomplete'}</Badge>}
        >
          {data.documents.items.length === 0 ? (
            <Muted>No document is required.</Muted>
          ) : (
            <dl className="grid gap-2 text-sm">
              {data.documents.items.map((item) => (
                <div key={item.type} className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">{DOCUMENT_TYPE_LABELS[item.type]}</dt>
                  <dd>
                    <DocumentStatusBadge status={item.status} />
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </Section>
      )}

      <Section title="Transport">
        {data.transport === null ? (
          <Muted>No route.</Muted>
        ) : (
          <Lines
            lines={[
              ['Route', data.transport.routeName],
              ['Stop', data.transport.stopName ?? '—'],
              ['Pickup', data.transport.pickupTime ?? '—'],
              ['Since', formatDay(data.transport.startsOn)],
            ]}
          />
        )}
      </Section>

      <p className="text-xs text-muted-foreground">As of {formatDay(data.asOf)}.</p>
    </article>
  );
}

/** "3 of 41"; "—" when there is no position. */
const ofLabel = (position: number | null, of: number | null) =>
  position === null ? '—' : of === null ? String(position) : `${position} of ${of}`;

function Section({ title, badge, children }: { title: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="grid gap-2 break-inside-avoid" aria-label={title}>
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {badge}
      </div>
      <div className="grid gap-2 rounded-lg border bg-card p-4 print:border-0 print:p-0">{children}</div>
    </section>
  );
}

function Lines({ lines }: { lines: readonly (readonly [string, string])[] }) {
  return (
    <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
      {lines.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-4">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
