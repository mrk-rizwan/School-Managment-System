import { perUserThrottle } from '../../common/rate-limit';

/**
 * Register submits, mark amends and arrivals (contracts/slice-11.md §1.5) and the staff sheet's
 * submit and amend (slice-12.md §1): one per-user bucket, 60/min and 1,000/hour, for every
 * attendance write.
 */
export const AttendanceWritesThrottleGuard = perUserThrottle('attendance-writes', 60, 1000);
