// The lane table (slice-15 §7.3, R158): the single place that says which writes may wait on the
// device. Lanes are independent; within a lane one request is in flight, oldest first. Slice 16
// adds submit_register, diary_entry, remark and diary_attachment here — no second queue.
//
// Online-only actions (R162) never enter the outbox: they are called directly and disabled
// offline with "needs a connection". ONLINE_ONLY_ACTIONS names them so a test can prove none of
// them is a lane.

export type Lane = {
  method: 'POST';
  /** The endpoint, or a template slice 16 fills (`/api/v1/sections/:id/...`). */
  path: string;
  /** True when the request carries `Idempotency-Key: <outbox id>` (slice-6 §4). */
  idempotencyHeader: boolean;
  /** True when writes to one natural key coalesce into one pending row (registers). */
  coalesces: boolean;
  /** What the sync sheet calls the lane. */
  label: string;
  /** The action offered on a terminal failure; null when there is none. */
  remedy: string | null;
};

export const LANES = {
  device_register: {
    method: 'POST',
    path: '/api/v1/me/devices',
    // Idempotent on the server: the same token answers 200 (slice-9 §3.5).
    idempotencyHeader: false,
    coalesces: false,
    label: 'Notification registration',
    // Silently superseded by the next token.
    remedy: null,
  },
} as const satisfies Record<string, Lane>;

export type LaneId = keyof typeof LANES;

export function laneOf(id: string): Lane | null {
  return (LANES as Record<string, Lane>)[id] ?? null;
}

/** At most three lanes send at once. */
export const MAX_CONCURRENT_LANES = 3;

/** R162: these are called directly and fail closed offline. None may ever be a lane. */
export const ONLINE_ONLY_ACTIONS = [
  'change_password',
  'revoke_other_sessions',
  'sign_out',
  'arrivals',
  'amend_after_window',
  'assign_cover',
  'send_announcement',
] as const;
