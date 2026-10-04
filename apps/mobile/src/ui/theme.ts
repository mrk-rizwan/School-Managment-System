// Theme tokens: the web's palette (apps/web/app/globals.css, oklch) as sRGB hex — the normative
// mobile values (slice-15 §12). Light only; the shape keeps a dark set additive. One accent, the
// system font, a 4-dp spacing scale, 48-dp tap targets. No gradients, no decoration. Attendance
// status colours arrive with slice 16, here, not per screen.

export const colors = {
  background: '#FFFFFF',
  foreground: '#0A0A0A',
  card: '#FFFFFF',
  popover: '#FFFFFF',
  muted: '#F5F5F5',
  secondary: '#F5F5F5',
  accent: '#F5F5F5',
  mutedForeground: '#737373',
  secondaryForeground: '#171717',
  border: '#E5E5E5',
  input: '#E5E5E5',
  primary: '#1D5AB0',
  primaryForeground: '#FAFAFA',
  ring: '#5787CE',
  destructive: '#E7000B',
} as const;

export const radius = 10;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const fontSize = { caption: 12, small: 14, body: 16, title: 18, heading: 22 } as const;

/** Minimum tap target: a corridor, one hand. */
export const TAP_TARGET = 48;

/**
 * Attendance status colours (slice-16 §3.3), used only through statusTone. A colour is never the
 * only carrier of meaning: every chip also carries its letter or word. White on each solid
 * colour is at least 4.5:1.
 */
export const statusColors = {
  present: '#15803D',
  absent: '#B91C1C',
  late: '#B45309',
  on_leave: '#475569',
  partial: '#B45309',
  unrecorded: '#F5F5F5',
  unrecordedText: '#737373',
  onStatus: '#FFFFFF',
} as const;

export type ChipStatus = 'present' | 'absent' | 'late' | 'on_leave' | 'partial';

export type StatusTone = {
  background: string;
  foreground: string;
  /** partial: a dashed border; unrecorded: a hollow chip. */
  border: 'none' | 'dashed' | 'hollow';
  /** One letter in a chip; '' for partial and unrecorded (the word says it). */
  letter: string;
  word: string;
};

const TONES: Record<ChipStatus, StatusTone> = {
  present: {
    background: statusColors.present,
    foreground: statusColors.onStatus,
    border: 'none',
    letter: 'P',
    word: 'Present',
  },
  absent: {
    background: statusColors.absent,
    foreground: statusColors.onStatus,
    border: 'none',
    letter: 'A',
    word: 'Absent',
  },
  late: {
    background: statusColors.late,
    foreground: statusColors.onStatus,
    border: 'none',
    letter: 'L',
    word: 'Late',
  },
  on_leave: {
    background: statusColors.on_leave,
    foreground: statusColors.onStatus,
    border: 'none',
    letter: 'O',
    word: 'On leave',
  },
  partial: {
    background: statusColors.partial,
    foreground: statusColors.onStatus,
    border: 'dashed',
    letter: '',
    word: 'Partly absent',
  },
};

const NOT_RECORDED: StatusTone = {
  background: statusColors.unrecorded,
  foreground: statusColors.unrecordedText,
  border: 'hollow',
  letter: '',
  word: 'Not recorded',
};

/** The tone of a status; null (nothing recorded) is muted with "Not recorded". */
export function statusTone(status: ChipStatus | null): StatusTone {
  return status === null ? NOT_RECORDED : TONES[status];
}

/**
 * A tab's stack (slice-16 §2): its index has no header; a pushed screen shows only the back
 * control, and the screen's own title names it (a child's name on a secure screen).
 */
export const stackScreenOptions = {
  headerTintColor: colors.primary,
  headerTitle: '',
  headerShadowVisible: false,
  contentStyle: { backgroundColor: colors.background },
} as const;
