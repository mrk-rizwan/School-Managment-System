import { perUserThrottle } from '../../common/rate-limit';

// contracts/slice-9.md §1.6 (R166). Keyed per school user, so a parent's phone and browser share
// one bucket (stricter than the plan's "per session", decision 5). One guard per bucket name.

/** `GET /me` and every `/me/*` read: 120/min, 2,000/hour. */
export const MeReadsThrottleGuard = perUserThrottle('me-reads', 120, 2000);

/** `POST /me/devices`: 10/min, 60/hour. */
export const DevicesThrottleGuard = perUserThrottle('devices', 10, 60);

/** `POST /me/sessions/revoke-others`: 5/min, 20/hour. */
export const RevokeSessionsThrottleGuard = perUserThrottle('revoke-sessions', 5, 20);
