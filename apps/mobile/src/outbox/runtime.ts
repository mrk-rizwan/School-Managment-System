import { useQuery, type QueryKey } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { currentBearerToken, sendRaw } from '../api/client';
import { queryClient } from '../api/query-client';
import type {
  RegisterSubmitMinimalResultDto,
  RegisterSubmitResultDto,
  RegisterViewDto,
  SubmitRegisterDto,
} from '../api/contracts';
import { invalidationKeys, queryKeys } from '../api/query-keys';
import { applySubmitResult, marksFromMinimal } from '../attendance/register-model';
import { cacheKey, readCache, writeCache, type Cached } from '../db/cache';
import {
  markAttachmentDone,
  markDiarySaved,
  markRegisterSaved,
  markRemarkSaved,
} from '../db/local.repository';
import * as outbox from '../db/outbox.repository';
import { isOnline } from '../net/connectivity';
import { log } from '../platform/log';
import { onDeviceRegistered } from '../push/registration';
import { sendAttachment } from './attachment-sender';
import { laneOf } from './lanes';
import { transition, type OutboxItem } from './machine';
import { outcomeOf, thrownOutcome, type SentOutcome } from './outcome';
import { OutboxWorker, type QueueStatus } from './worker';

// The app's one outbox worker, wired to the real client, store and connectivity.

/** One send of a JSON lane: the stored request through the shared client. */
async function sendJson(item: OutboxItem): Promise<SentOutcome> {
  const lane = laneOf(item.lane);
  const headers: Record<string, string> = {
    ...lane?.headers,
    ...(lane?.idempotencyHeader ? { 'Idempotency-Key': item.id } : {}),
  };
  const sentWith = currentBearerToken();
  let response: Response;
  try {
    response = await sendRaw(item.method, item.path, item.body, headers);
  } catch (error) {
    return thrownOutcome(error);
  }
  return outcomeOf(response, sentWith);
}

/** One send, dispatched on the lane's sender (slice-16 §10.1); the machine sees only Outcomes. */
export function sendItem(item: OutboxItem): Promise<SentOutcome> {
  return laneOf(item.lane)?.sender === 'diary_attachment' ? sendAttachment(item) : sendJson(item);
}

function invalidate(keys: readonly (readonly unknown[])[]): void {
  for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
  void queryClient.invalidateQueries({ queryKey: queryKeys.local });
}

/**
 * Lays a submit's response (already checked against its shape) over the cached register view —
 * in memory (an open screen) and on disk (the "as of" offline). False when there is no view to
 * update: the caller then invalidates instead (no open screen means no fetch).
 */
async function applyToCachedRegister(
  sectionId: string,
  sent: SubmitRegisterDto,
  outcome: SentOutcome,
  minimal: boolean,
): Promise<boolean> {
  const { date, period } = sent;
  const queryKey = queryKeys.register(sectionId, date, period);
  const key = cacheKey(`/api/v1/sections/${sectionId}/register`, { date, period });
  const cached =
    queryClient.getQueryData<Cached<RegisterViewDto>>(queryKey) ??
    (await readCache<RegisterViewDto>(key));
  if (cached === null || cached === undefined) return false;
  const marks = minimal
    ? marksFromMinimal(cached.body, sent, outcome.body as RegisterSubmitMinimalResultDto)
    : (outcome.body as RegisterSubmitResultDto).marks;
  const register = (outcome.body as RegisterSubmitResultDto).register;
  const next = await writeCache(
    key,
    applySubmitResult(cached.body, { register, marks }),
    outcome.date ?? null,
  );
  queryClient.setQueryData<Cached<RegisterViewDto>>(queryKey, next, {
    updatedAt: Date.parse(next.serverTime),
  });
  return true;
}

// The submit's answer, one schema per shape (`Prefer: return=minimal` or not): enough of it to
// record the summary and rebuild the register view.
const registerResult = <M extends z.ZodTypeAny>(mark: M) =>
  z.object({
    register: z.object({ id: z.string(), teachingDay: z.boolean() }),
    summary: z.object({
      roster: z.number(),
      marked: z.number(),
      present: z.number(),
      absent: z.number(),
      late: z.number(),
      onLeave: z.number(),
    }),
    marks: z.array(mark),
  });
/** RegisterSubmitResultDto. */
const SubmitResult = registerResult(
  z.object({ enrolmentId: z.string(), id: z.string(), status: z.string() }),
);
/** RegisterSubmitMinimalResultDto: per mark its id and outcome only. */
const MinimalSubmitResult = registerResult(
  z.object({
    enrolmentId: z.string(),
    id: z.string(),
    outcome: z.enum(['created', 'amended', 'unchanged']),
  }),
);
const WithId = z.object({ id: z.string() });
const WithSection = z.object({ id: z.string(), sectionId: z.string() });

/** The id between two path segments: /api/v1/sections/<id>/submit-register → <id>. */
const idAfter = (path: string, segment: string) =>
  new RegExp(`/${segment}/([^/]+)`).exec(path)?.[1] ?? '';

const savedAt = (outcome: SentOutcome) => {
  const parsed = outcome.date ? Date.parse(outcome.date) : Number.NaN;
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
};

/**
 * Each lane's follow-up after the server's 2xx (slice-16 §10.3). A malformed body is ignored:
 * the item is still done — the server has it.
 */
export const ON_SAVED: Record<string, (item: OutboxItem, outcome: SentOutcome) => Promise<void>> = {
  device_register: (item) => onDeviceRegistered(item),
  async submit_register(item, outcome) {
    const minimal = /\breturn=minimal\b/.test(outcome.preferenceApplied ?? '');
    const result = (minimal ? MinimalSubmitResult : SubmitResult).safeParse(outcome.body);
    await markRegisterSaved(item.id, {
      serverRegisterId: result.success ? result.data.register.id : null,
      savedAt: savedAt(outcome),
      summary: result.success ? result.data.summary : null,
    });
    // The stored body is this app's own, built by buildRegisterBody: no need to re-validate it.
    const sent = JSON.parse(item.body) as SubmitRegisterDto;
    const sectionId = idAfter(item.path, 'sections');
    // R160 (main-thread decision, 2026-10-04): the open register is updated from the submit's
    // own response, never refetched; the principal's console and reports are invalidated.
    const [registerKey, ...others] = invalidationKeys.register(sectionId, sent.date, sent.period);
    const applied = result.success
      ? await applyToCachedRegister(sectionId, sent, outcome, minimal)
      : false;
    invalidate(applied ? others : [registerKey!, ...others]);
  },
  async diary_entry(item, outcome) {
    const result = WithId.safeParse(outcome.body);
    const queued = await markDiarySaved(item.id, result.success ? result.data.id : null);
    invalidate(invalidationKeys.sectionDiary(idAfter(item.path, 'sections')));
    if (queued > 0) void outboxWorker.trigger('enqueued');
  },
  async remark(item, outcome) {
    const result = WithId.safeParse(outcome.body);
    await markRemarkSaved(item.id, result.success ? result.data.id : null);
    invalidate(invalidationKeys.studentRemarks(idAfter(item.path, 'students')));
  },
  async diary_attachment(item, outcome) {
    if (item.domainId !== null) await markAttachmentDone(item.domainId);
    const result = WithSection.safeParse(outcome.body);
    invalidate(result.success ? invalidationKeys.sectionDiary(result.data.sectionId) : []);
  },
};

export async function onSaved(item: OutboxItem, outcome: SentOutcome): Promise<void> {
  const followUp = ON_SAVED[item.lane];
  if (followUp === undefined) {
    log('warn', 'outbox.no_follow_up', { lane: item.lane });
    return;
  }
  await followUp(item, outcome);
}

export const outboxWorker = new OutboxWorker({
  store: outbox,
  send: sendItem,
  isOnline,
  onSaved,
});

/** App start: a `sending` row left by a crash is sent again (every lane is idempotent). */
export async function recoverStaleItems(now: Date = new Date()): Promise<void> {
  for (const item of await outbox.listByState('sending')) {
    const recovered = transition(item, { type: 'recover', now }).item;
    if (recovered !== item) await outbox.saveItem(recovered);
  }
}

/** The sync sheet's view: unfinished items and the queue flags, refreshed on every change. */
export function useOutbox(): {
  items: OutboxItem[];
  status: QueueStatus;
  /** When the list was read (ms): the sheet computes "retrying in" from it. */
  refreshedAt: number;
  refresh: () => void;
} {
  const [view, setView] = useState({
    items: [] as OutboxItem[],
    status: outboxWorker.status(),
    refreshedAt: 0,
  });
  const refresh = useCallback(() => {
    void outbox
      .listUnfinished()
      .catch(() => [] as OutboxItem[])
      .then((items) => setView({ items, status: outboxWorker.status(), refreshedAt: Date.now() }));
  }, []);
  useEffect(() => {
    refresh();
    return outboxWorker.subscribe(refresh);
  }, [refresh]);
  return { ...view, refresh };
}

/**
 * A read of the device's own rows (local tables), refreshed whenever the outbox changes, so a
 * state line moves from "Saved on device" to "Sending" to "Saved on server" by itself.
 */
export function useLocalQuery<T>(queryKey: QueryKey, read: () => Promise<T>) {
  const query = useQuery({
    queryKey,
    queryFn: read,
    networkMode: 'always',
    staleTime: 0,
    retry: 0,
  });
  const { refetch } = query;
  useEffect(
    () =>
      outboxWorker.subscribe(() => {
        void refetch();
      }),
    [refetch],
  );
  return query;
}
