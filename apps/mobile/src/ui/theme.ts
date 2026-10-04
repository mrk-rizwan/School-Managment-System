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
