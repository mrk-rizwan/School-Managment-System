import { perUserThrottle } from '../../common/rate-limit';

/**
 * Phase 5 slice 38 (phase-5-extended.md §5.1): every event write — create, edit, duties, publish,
 * cancel, complete, participation, payments — and the expense tag share one per-user bucket,
 * 30/min and 300/h.
 */
export const EventWritesThrottleGuard = perUserThrottle('event-writes', 30, 300);
