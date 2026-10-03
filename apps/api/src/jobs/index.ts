// src/jobs - the worker's queue processors and scheduled jobs (Phase 2 plan §2, §3, §4.1;
// contracts/slice-9.md §7.6-§7.12). Run only by the worker process (src/worker.ts, WORKER=1); the
// HTTP process enqueues after commit and runs no job.
//
// Rules for every file in this folder:
// - Only src/jobs/** (and src/messaging/outbox-dispatcher.ts) may import bullmq (eslint.config.mjs).
// - Only src/jobs/** may import src/tenancy/queue.mint.ts: a payload's school id becomes a
//   SchoolId through QueueTenancy.fromQueuePayload, nowhere else. A null result means the job is
//   dropped (ended successfully, logged without ids), never retried.
// - Every job body runs inside QueueTenancy.runAsSchool(schoolId, fn), the worker's only way into
//   a CLS context, so concurrent jobs for two schools never share a tenant or a transaction.
// - A processor's first statement is a claim scoped by the SchoolId (R105): zero rows means the
//   job was replayed, forged or already handled, and it ends without effect.
// - Housekeeping that reaches every school (outbox sweep, delivery-health rollup, staged-upload
//   sweep) keeps the in-process fan-out (SchoolFanOutRepository, named exception 3).
//
// Empty until slice 9 adds the queues `messaging`, `attendance` and `scheduled`.
export {};
