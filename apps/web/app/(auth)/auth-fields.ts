'use client';

import { IDENTITY_INPUT_PATTERN } from '@asms/shared';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { FieldValues, Path, PathValue, UseFormReturn } from 'react-hook-form';
import { z } from 'zod';
import { getRememberedSchoolCode } from '@/lib/remembered-school';

// Field rules and helpers shared by the school sign-in screens (contracts/slice-2.md §3).

/** §3.1: trimmed, lower-cased, 3–12 letters or digits. */
export const SCHOOL_CODE_PATTERN = /^[a-z0-9]{3,12}$/;

export const schoolCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SCHOOL_CODE_PATTERN, 'Enter your school code: 3 to 12 letters or numbers.');

/**
 * The username is the 13-digit CNIC or B-Form number; dashes in the usual 5-7-1 places are
 * accepted and stripped before sending (normaliseIdentityDigits). It is never put in a URL, a
 * log line or browser storage (CLAUDE.md rule 12).
 */
export const usernameSchema = z
  .string()
  .trim()
  .regex(IDENTITY_INPUT_PATTERN, 'Enter the 13 digits of your CNIC or B-Form number.');

/** §3.4: 8–128 characters. The API also refuses the username digits (a 422 on the field). */
export const newPasswordSchema = z
  .string()
  .min(8, 'Use at least 8 characters.')
  .max(128, 'Use at most 128 characters.');

/** Fills the school code field from the remembered value (the only thing in localStorage). */
export function useRememberedSchoolCode<T extends FieldValues>(
  form: UseFormReturn<T>,
  name: Path<T>,
) {
  useEffect(() => {
    const remembered = getRememberedSchoolCode();
    if (remembered && !form.getValues(name)) {
      form.setValue(name, remembered as PathValue<T, Path<T>>);
    }
  }, [form, name]);
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function tokenFromFragment(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  return token && TOKEN_PATTERN.test(token) ? token : null;
}

const subscribeNothing = () => () => {};

/**
 * Reads `#token=…` from an emailed link (§3.3, §3.5), keeps it in memory only, and removes the
 * fragment from the address bar and history with replaceState. The fragment never reaches a
 * server or a Referer. `ready` is false during the server render and hydration, so both render
 * the same placeholder; the token is read in the browser on the first client render.
 */
export function useFragmentToken(): { ready: boolean; token: string | null } {
  const ready = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
  // Read once per mount; reading is pure, so a double render in development is harmless.
  const [token] = useState(() => (typeof window === 'undefined' ? null : tokenFromFragment()));
  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
  }, []);
  return { ready, token };
}
