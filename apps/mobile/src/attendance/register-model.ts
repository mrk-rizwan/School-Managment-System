import type { AttendanceStatus } from '@asms/shared';
import type {
  AttendanceMarkDto,
  RegisterDto,
  RegisterSubmitMinimalResultDto,
  RegisterSubmitResultDto,
  RegisterViewDto,
  RosterRowDto,
  SubmitRegisterDto,
} from '../api/contracts';
import type { LocalRegister } from '../db/local.repository';
import type { RegisterMarkInput } from '../outbox/bodies';

// The register screen's rules (slice-16 §4.2), pure and table-tested through the screen.

export type RegisterMode = 'new' | 'amend' | 'locked' | 'not_teaching' | 'viewer';

export function registerMode(view: RegisterViewDto): RegisterMode {
  if (!view.canSubmit) return 'viewer';
  if (!view.teachingDay) return 'not_teaching';
  if (view.register === null) return 'new';
  return view.amendable ? 'amend' : 'locked';
}

export const editable = (mode: RegisterMode) => mode === 'new' || mode === 'amend';

/** A tap cycles present → absent → late → on leave → present. */
export const NEXT_STATUS: Record<AttendanceStatus, AttendanceStatus> = {
  present: 'absent',
  absent: 'late',
  late: 'on_leave',
  on_leave: 'present',
};

/** The status after a tap: an unmarked row starts the cycle at present (wave-F review). */
export const nextStatus = (current: AttendanceStatus | null): AttendanceStatus =>
  current === null ? 'present' : NEXT_STATUS[current];

/** "Ali: present → absent" lines from a refusal's amendments (ids and statuses, no names). */
export function amendmentLines(
  details: string | null,
  nameOf: (enrolmentId: string) => string,
): string[] | null {
  if (details === null) return null;
  try {
    const parsed = JSON.parse(details) as {
      amendments?: { enrolmentId: string; from: AttendanceStatus | null; to: AttendanceStatus }[];
    };
    if (!Array.isArray(parsed.amendments)) return null;
    return parsed.amendments.map(
      (a) =>
        `${nameOf(a.enrolmentId)}: ${a.from ? STATUS_WORDS[a.from] : 'not marked'} → ${STATUS_WORDS[a.to]}`,
    );
  } catch {
    return null;
  }
}

export type RowValue = {
  status: AttendanceStatus | null;
  note: string | null;
  arrivedAt: string | null;
};
export type Edits = Readonly<Record<string, RowValue>>;

/**
 * Local marks are the latest unsent intent: they win over the server's while their write is not
 * yet confirmed, or while the cached view has no register at all (it predates the save).
 */
export function localMarksApply(
  local: LocalRegister | null,
  view: RegisterViewDto | null,
): boolean {
  if (local === null) return false;
  return local.outbox?.state !== 'done' || view === null || view.register === null;
}

/** What a row shows: the unsaved edit, else the device's mark, else the server's, else (new) present. */
export function rowValue(
  row: RosterRowDto,
  mode: RegisterMode,
  edits: Edits,
  local: LocalRegister | null,
  useLocal: boolean,
): RowValue {
  const edit = edits[row.enrolmentId];
  if (edit !== undefined) return edit;
  const localMark = useLocal
    ? local?.marks.find((m) => m.enrolmentId === row.enrolmentId)
    : undefined;
  if (localMark !== undefined) {
    return { status: localMark.status, note: localMark.note, arrivedAt: localMark.arrivedAt };
  }
  if (row.mark !== null) {
    return { status: row.mark.status, note: row.mark.note, arrivedAt: row.mark.arrivedAt };
  }
  // A fresh register is pre-filled present (slice-16 decision 3); the teacher taps exceptions.
  return { status: mode === 'new' && row.onRoster ? 'present' : null, note: null, arrivedAt: null };
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? null) === (b ?? null);

/** In amend mode, a row differs from the server's mark. */
export function differsFromServer(row: RosterRowDto, value: RowValue): boolean {
  if (row.mark === null) return value.status !== null;
  return (
    value.status !== row.mark.status ||
    !same(value.note, row.mark.note) ||
    !same(value.status === 'late' ? value.arrivedAt : null, row.mark.arrivedAt)
  );
}

/**
 * The marks a save sends: every roster row in new mode (the first submit covers the whole
 * roster, R119); only the changed rows in amend mode (a subset submit, slice-11 §4.2 step 8).
 */
export function marksToSend(
  view: RegisterViewDto,
  mode: RegisterMode,
  valueOf: (row: RosterRowDto) => RowValue,
): RegisterMarkInput[] {
  const rows = view.roster.filter((row) => row.onRoster);
  const chosen =
    mode === 'amend' ? rows.filter((row) => differsFromServer(row, valueOf(row))) : rows;
  return chosen.flatMap((row) => {
    const value = valueOf(row);
    if (value.status === null) return [];
    return [
      {
        enrolmentId: row.enrolmentId,
        status: value.status,
        note: value.note,
        arrivedAt: value.status === 'late' ? value.arrivedAt : null,
      },
    ];
  });
}

export type Counts = { present: number; absent: number; late: number; onLeave: number };

export function countOf(statuses: readonly (AttendanceStatus | null)[]): Counts {
  const counts = { present: 0, absent: 0, late: 0, onLeave: 0 };
  for (const status of statuses) {
    if (status === 'present') counts.present += 1;
    if (status === 'absent') counts.absent += 1;
    if (status === 'late') counts.late += 1;
    if (status === 'on_leave') counts.onLeave += 1;
  }
  return counts;
}

export const countsLine = (c: Counts) =>
  `P ${c.present} · A ${c.absent} · L ${c.late} · O ${c.onLeave}`;

/** The nameless line after a 401 wiped the roster cache (slice-16 §3.4, §4.2). */
export function namelessLine(local: LocalRegister): string {
  const c = countOf(local.marks.map((m) => m.status));
  const n = local.marks.length;
  return `${n} ${n === 1 ? 'mark' : 'marks'} saved on device (${c.absent} absent, ${c.late} late) — sign in to see names`;
}

export const STATUS_WORDS: Record<AttendanceStatus, string> = {
  present: 'present',
  absent: 'absent',
  late: 'late',
  on_leave: 'on leave',
};

/** HH:MM, 00:00–23:59. */
export const isClockTime = (text: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(text);

/**
 * The marks a `Prefer: return=minimal` submit wrote (R160), rebuilt from what was sent and the
 * server's `{ id, enrolmentId, outcome }` per mark: the status, note and arrival time are the
 * request's own; the student id comes from the cached roster row. An `unchanged` mark keeps the
 * amended flag it had; an `amended` one is amended.
 */
export function marksFromMinimal(
  view: RegisterViewDto,
  sent: Pick<SubmitRegisterDto, 'date' | 'period' | 'marks'>,
  result: Pick<RegisterSubmitMinimalResultDto, 'register' | 'marks'>,
): AttendanceMarkDto[] {
  const rows = new Map(view.roster.map((row) => [row.enrolmentId, row] as const));
  const bodies = new Map(sent.marks.map((mark) => [mark.enrolmentId, mark] as const));
  return result.marks.flatMap((answer) => {
    const row = rows.get(answer.enrolmentId);
    const body = bodies.get(answer.enrolmentId);
    if (row === undefined || body === undefined) return [];
    return [
      {
        id: answer.id,
        enrolmentId: answer.enrolmentId,
        studentId: row.studentId,
        registerId: result.register.id,
        date: sent.date,
        period: sent.period,
        status: body.status,
        note: body.note ?? null,
        arrivedAt: body.status === 'late' ? (body.arrivedAt ?? null) : null,
        amended: answer.outcome === 'amended' || (row.mark?.amended ?? false),
      },
    ];
  });
}

/**
 * The register view after the server accepted a submit, from the submit's own answer (R160):
 * the register and every mark it wrote, so "Saved on server" costs no second read of the
 * roster. Rows the submit did not name keep their mark (a subset amendment).
 */
export function applySubmitResult(
  view: RegisterViewDto,
  result: {
    register: RegisterDto;
    marks: (AttendanceMarkDto | RegisterSubmitResultDto['marks'][number])[];
  },
): RegisterViewDto {
  const written = new Map(
    result.marks.map((m) => {
      const { outcome: _outcome, ...mark } = m as RegisterSubmitResultDto['marks'][number];
      return [mark.enrolmentId, mark] as const;
    }),
  );
  return {
    ...view,
    register: result.register,
    teachingDay: result.register.teachingDay,
    roster: view.roster.map((row) => {
      const mark = written.get(row.enrolmentId);
      return mark === undefined ? row : { ...row, mark };
    }),
  };
}
