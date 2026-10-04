import { scrub } from './scrub';

// The only module that may call console (lint). Every field passes scrub() before it is kept.
// The sink is an in-memory ring of the last 200 lines, shown on Account → Diagnostics; the
// console mirrors it in development builds only, so a release build writes no device log.
// No remote crash reporter in Phase 2 (slice-15 §10).

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogLine = { at: string; level: LogLevel; event: string; fields: unknown };

export const LOG_CAPACITY = 200;
const lines: LogLine[] = [];

export function log(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
  const line: LogLine = {
    at: new Date().toISOString(),
    level,
    event: String(scrub(event)),
    fields: fields === undefined ? null : scrub(fields),
  };
  lines.push(line);
  if (lines.length > LOG_CAPACITY) lines.splice(0, lines.length - LOG_CAPACITY);
  if (__DEV__ && process.env.NODE_ENV !== 'test') {
    console[level === 'debug' ? 'log' : level](`[asms] ${line.event}`, line.fields ?? '');
  }
}

/** A copy of the ring buffer, oldest first. */
export const logLines = (): LogLine[] => [...lines];

/** The ring buffer as text, for the diagnostics screen's share button. */
export const logText = (): string =>
  lines
    .map((l) => `${l.at} ${l.level} ${l.event} ${l.fields ? JSON.stringify(l.fields) : ''}`)
    .join('\n');

export function clearLog(): void {
  lines.length = 0;
}
