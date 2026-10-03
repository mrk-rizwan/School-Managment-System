'use client';

import { containsIdentityNumber } from '@asms/shared';
import { useDebounced } from './hooks';

/**
 * What a list's search box sends: `q`, or the reason it sends nothing. `identity` means the text
 * carries an identity number, which is never a search term (identity numbers never travel in a
 * URL); each screen says what to do instead.
 */
export type ListSearch = { q?: string; identity?: boolean; hint?: string };

/**
 * `q` only when the API would accept it: 2–100 characters and no identity number. The identity
 * check is the API's strictest (`NoIdentityNumber({ ignoreSeparators: true })`): spaces, dashes
 * and `+` are removed first, so `35201-1234567-1` and `35201 1234567 1` are caught too.
 */
export function listSearchTerm(raw: string): ListSearch {
  const q = raw.trim();
  if (q.length === 0) return {};
  if (containsIdentityNumber(q.replace(/[\s+-]/g, ''))) return { identity: true };
  if (q.length < 2) return { hint: 'Type at least 2 characters to search.' };
  return { q: q.slice(0, 100) };
}

/**
 * `listSearchTerm` for a search box: `q` and the hint are debounced, but the identity check runs
 * on the live text, so an identity number is never sent, not even while the debounce settles.
 */
export function useListSearch(raw: string): ListSearch {
  const live = listSearchTerm(raw);
  const debounced = listSearchTerm(useDebounced(raw));
  if (live.identity) return { identity: true };
  return { q: debounced.q, hint: debounced.hint };
}
