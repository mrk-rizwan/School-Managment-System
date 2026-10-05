# Deploying ASMS

Production requirements created by Phase 1 and Phase 2. Each one is something the code assumes and
cannot enforce on its own. Sources: `docs/plans/phase-2-daily-operations.md` §3 and §9,
`docs/plans/contracts/slice-9.md`, `apps/api/src/config/env.ts`, `apps/api/src/bootstrap.ts`,
`apps/api/src/jobs/worker-host.ts`.

**Still assumptions, not decisions:** the host (a VPS in a region near Pakistan), Docker Compose as
the production runner, nginx or Caddy as the edge proxy, the S3 provider, and the backup schedule
and retention below. Each is marked where it appears.

## Processes

| Process | Command | Instances |
|---|---|---|
| API | `node dist/main.js` (after `nest build`; never `ts-node`) | any number; stateless |
| Worker | `node dist/worker.js` | **exactly one** |
| Web admin | Next.js production server | any number |
| WAHA | `docker compose --profile whatsapp up -d waha` | one, only if `waha` is enabled |
| Postgres, Redis, object storage | managed or self-hosted (assumption) | — |

Migrations: `prisma migrate deploy` only, never `migrate dev`, with a fresh verified backup before
any destructive one.

## Exactly one worker

The worker consumes every queue and owns every repeatable job; the HTTP process runs none
(`WORKER=1` is set only by `src/worker.ts`). Run one, and on deploy **stop the old worker before
starting the new one**, never overlap them:

- The `scheduled` queue runs with concurrency 1 on the assumption that it is the only consumer. The
  sweeps (outbox, register deadline, WhatsApp health, SMS poll, session purge, staged uploads) are
  written to run one at a time; a second worker would run two of them at once over the same rows.
- Every worker boot upserts the repeatable-job list (`SCHEDULES`). Two versions running side by
  side would keep rewriting each other's schedule.
- The claim model (R105: a processor's first statement is a scoped conditional
  `UPDATE … WHERE status = 'queued'`) means a duplicated *message* job sends nothing. That is a
  safety net against replays, not a licence to run two workers.
- Health: `GET http://127.0.0.1:${WORKER_HEALTH_PORT:-3002}/health` on the worker's own host,
  `200` when Postgres and Redis answer, else `503`. Alert a human on `503` and on failed jobs.

## Edge reverse proxy and client IP

Required before the first school goes live. The Next.js rewrite forwards a client-sent
`X-Forwarded-For` unchanged, and the API uses `trust proxy = 1`. So an edge proxy (nginx or Caddy,
assumption) in front of Next must **overwrite** the header with the connecting address:

```nginx
proxy_set_header X-Forwarded-For $remote_addr;   # not $proxy_add_x_forwarded_for
```

Without it, per-IP throttling, login lockout and the webhook failed-verification budget can be
bypassed with a forged header. **Verify on staging:** send `X-Forwarded-For: 203.0.113.9` and check
that the API logs the real address. The edge also terminates HTTPS and redirects HTTP to it.

Topology the code fixes: the API listens on `127.0.0.1:API_PORT` only (`bootstrap.ts`), and Next
rewrites `/api/*` to `http://127.0.0.1:API_PORT`. So Next and the API share one network namespace:
the same host, or the same container network namespace. Only the edge is public.

## Webhooks and the R172 edge allow-list

Mounted: `POST /api/v1/webhooks/waha` (HMAC-SHA512, `X-Webhook-Hmac`) and `GET`/`POST
/api/v1/webhooks/meta` (HMAC-SHA256, `X-Hub-Signature-256`). Both are signed, so they need no IP
allow-list; a provider left out of `WHATSAPP_PROVIDERS_ENABLED` answers `404`. Pass the raw body
through the edge unmodified (no body rewriting or re-encoding), or every signature fails.

R172's edge allow-list applies only to an **unsigned** delivery-report provider. Phase 2 has none:
Sendpk is pull-only and `POST /webhooks/sms` is not mounted (slice-9 §8.4). When a push-report SMS
provider is added and cannot sign, the edge must accept its webhook path only from that provider's
published addresses.

WAHA calls its webhook at `APP_URL` (`<APP_URL origin>/api/v1/webhooks/waha`), so it goes out and
back in through the edge. Its source address is the host's public egress address.

## WAHA

Only when `WHATSAPP_PROVIDERS_ENABLED` includes `waha` (it does when the variable is empty). The
`waha` service in `docker-compose.yml`, profile `whatsapp`, is the reference configuration:

- **No published port.** Two networks: `waha_private` (`internal: true`, no route off the host),
  which only WAHA and the **API container** join, and `waha_egress`, which only WAHA joins, for its
  outbound connections to WhatsApp and to `APP_URL`. The API then uses `WAHA_URL=http://waha:3000`.
  Anyone who can reach WAHA's port can read and send on every paired school's account.
  This means the API runs **in a container** on `waha_private` (with Next in its network
  namespace, see above). An API run directly on the host cannot reach WAHA. Publishing WAHA on
  `127.0.0.1` instead would open it to every process on the host; that is a decision to record, not
  a workaround.
- Dashboard, swagger, apps, debug endpoints and metrics off; log level `info` in JSON (`debug`
  prints message content); the pairing QR never printed to the console.
- Inbound media is never downloaded; the files folder is on a `/tmp` tmpfs (memory only) with a
  24-hour lifetime.
- Non-root (`1000:1000`), read-only root filesystem, image pinned by digest (WAHA 2026.9.2, WEBJS,
  amd64). An upgrade is a reviewed change: re-read WAHA's configuration page and recheck the
  webhook HMAC headers.
- `WAHA_API_KEY` random, at least 16 characters (the container refuses to start otherwise); the same
  value is in the API's environment. `WAHA_WEBHOOK_SECRET` stays in the API's environment only: the
  API sets it as each session's HMAC key when it creates the session. Do not also set
  `WHATSAPP_HOOK_URL`, which would deliver every event twice.
- **The session volume `waha_sessions`** holds each school's logged-in WhatsApp keys:
  - on **encrypted host storage** (an encrypted block device or LUKS volume, assumption);
  - **excluded from log shipping** and from any agent that collects files;
  - backed up, encrypted, with the database (below);
  - a fresh named volume is owned by root; before the first start, give it to uid 1000:
    `docker run --rm -v <project>_waha_sessions:/v alpine chown 1000:1000 /v`.
- The API's 5-minute `whatsapp-health-sweep` is the per-session health check: a session that is not
  `WORKING` turns `down`, routing falls back to SMS for that school, and one `whatsapp_session_down`
  email goes to `PLATFORM_ALERT_EMAIL`. The container's own health check (`/ping`) only says the
  process is up. A ban is not a crash: the session may still report `WORKING` while messages stop
  reaching `delivered`. Watch the per-school failure and no-report counts on
  `GET /platform/messaging/health` (assumption: no automatic alert on that yet).

**Open, not yet met:**

1. **Message store purge every 7 days** (plan §3). WAHA documents no environment variable for it.
   WEBJS keeps chat history in the browser profile inside `waha_sessions`. GOWS can turn local
   message storage off per session (`config.gows.storage.messages = false`), but that needs an
   engine decision and a change to `WahaDriver`'s session create.
2. **First start not yet proven.** The compose service validates (`docker compose config`) but has
   not been started. Running WEBJS's Chromium as uid 1000 on a read-only root needs a staging run;
   if it fails, the fix (extra tmpfs paths, GOWS) is a reviewed change, not dropping `read_only`
   or `user`.

## Object storage

One **private** bucket per environment (`S3_BUCKET`): no public read, no public listing, no
website hosting. The API has no presigned-URL method; it streams every document itself after its
capability and scope checks (R43), so the bucket never needs to be reachable by clients. In
production the API requests SSE-S3 on every object; also enforce default encryption on the bucket.
Turn on **versioning** (or a separate copy), because a database restore without the documents is
half a recovery. Locally this is MinIO (`docker-compose.yml`); the production provider is an
assumption.

## Database settings

Set `work_mem` to about **32 MB for the API's database role** (`ALTER ROLE <api_role> SET
work_mem = '32MB'`, applied to new connections), not server-wide. It keeps the whole-school
attendance percentage report's sort in memory; at the 4 MB default it can spill to disk on a
3,000-student school. Migrations (`prisma migrate deploy`) add every index the queries need; there
is no manual index step.

## Environment

The API validates its environment at boot and refuses to start on a missing or malformed key. In
production (`NODE_ENV=production`), in addition to the always-required keys in `.env.example`:

| `WHATSAPP_PROVIDERS_ENABLED` | Also required |
|---|---|
| empty or unset (means both) | `WAHA_URL`, `WAHA_API_KEY`, `WAHA_WEBHOOK_SECRET`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` |
| `waha` | `WAHA_URL`, `WAHA_API_KEY`, `WAHA_WEBHOOK_SECRET` |
| `cloud_api` | `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` |

Every value: `FCM_SERVICE_ACCOUNT_JSON`, `SMS_API_KEY`, `SMS_SENDER_ID`, `PLATFORM_ALERT_EMAIL`,
and **`MOBILE_MIN_APP_VERSION`** (for example `1.0.0`; requests from older apps get
`426 UPGRADE_REQUIRED`). There is no log-driver fallback in production (R112).

Secrets live only in the deployment environment: not in the repository, not in an image, not on a
laptop. Development, staging and production have separate databases, Redis, buckets and
credentials; development never points at production data. Remove `PLATFORM_ADMIN_PASSWORD` from
the server once the seed has run.

## Backups

The schedule and retention below are a **proposal** until the owner confirms them.

- **Postgres:** `pg_dump` daily at 02:00 Asia/Karachi, encrypted, stored off the application server
  (a bucket in another account or region), 30 days retained. Up to 24 hours of data is at risk.
- **WAHA session volume:** archived encrypted with the same schedule and destination. Losing it
  means every school re-scans a QR code, not data loss.
- **Document bucket:** versioning or replication, as above.
- **Restore is tested monthly:** restore into a scratch database and compare row counts with
  production. An untested backup is not a backup.
