# ASMS — School Management System

Multi-tenant school management platform: one system, many schools, each isolated.
TypeScript monorepo — NestJS API, Next.js web admin, PostgreSQL, Redis.

**Before contributing, read [`CLAUDE.md`](CLAUDE.md) and [`docs/WORKLOG.md`](docs/WORKLOG.md).**
They are mandatory for every contributor and every AI session: `CLAUDE.md` holds the settled
rules and the open-decision register; `WORKLOG.md` says what is done, in progress and next.

## Prerequisites

- **Node 24** — the version is pinned in `.nvmrc` (`nvm use` picks it up).
- **pnpm 12.3.4** via Corepack, which ships with Node:
  ```sh
  corepack enable
  corepack prepare pnpm@12.3.4 --activate
  ```
  The version is also pinned in the root `package.json` (`packageManager`).
- **Docker Desktop** — runs Postgres, Redis, Mailpit and MinIO. Node runs on the host.
- **Git**. On Windows use Git Bash for the commands below.
  Password hashing uses `@node-rs/argon2` (prebuilt binaries), so no C++ build tools are needed.

## First-time setup

```sh
git clone https://github.com/mrk-rizwan/School-Managment-System.git
cd School-Managment-System
git config core.hooksPath .githooks
```

**On Windows, clone into a short path** such as `D:\asms`. A deep folder (a long user temp
directory, say) pushes paths inside `node_modules` past Windows' 260-character limit and
`pnpm` fails with "The system cannot find the path specified".

The last line is **required once per clone**. It enables the pre-commit guard in `.githooks/`,
which refuses commits containing `.env` files, credentials, private keys, build output, logs,
uploaded student documents or files over 1 MB. Git does not enable repository hooks on its own.

### Environment

```sh
cp .env.example .env
```

Fill every value. The API refuses to start if one of its own keys is missing; `POSTGRES_*`,
`REDIS_PASSWORD` and `TEST_DATABASE_URL` feed Docker Compose and the tests, and
`PLATFORM_ADMIN_*` are read only by the seed. `.env` is git-ignored and the
hook blocks it; never commit it.

- `IDENTITY_HASH_KEY`, `PASSWORD_PEPPER` — two **different** random secrets. Generate each with
  ```sh
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```
- `FIELD_ENCRYPTION_KEYS` — a keyring, `k1:<base64>` using a third secret from the same command.
- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY` — any local values; Docker Compose creates the services with them.
  MinIO needs a secret key of at least 8 characters.
- `DATABASE_URL` and `TEST_DATABASE_URL` — two databases on the same server, where
  `<credentials>` is `<user>:<password>` from `POSTGRES_USER` and `POSTGRES_PASSWORD`:
  ```
  DATABASE_URL=postgresql://<credentials>@127.0.0.1:5432/asms
  TEST_DATABASE_URL=postgresql://<credentials>@127.0.0.1:5432/asms_test
  ```
- `REDIS_URL` — `redis://:<redis-password>@127.0.0.1:6379`
- `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD` — read only by the seed command below, to
  create the first platform admin. The running API does not need them; on a server, remove the
  password after seeding.

### Services, dependencies, database

```sh
docker compose up -d --wait
docker compose exec postgres psql -U <user> -d asms -c "CREATE DATABASE asms_test;"

pnpm install
pnpm --filter @asms/shared build
pnpm --filter @asms/api db:generate
pnpm --filter @asms/api db:migrate
pnpm --filter @asms/api seed:platform-admin   # prints "created" once, then "exists"
pnpm --filter @asms/api db:test:deploy
```

`asms_test` is created once; it survives `docker compose down` (the data lives in a volume).

**Upgrading a checkout from before 2026-10-03:** object storage moved to Chainguard's MinIO image,
which runs as uid 65532. Hand the old volume to that user once, then restart it:

```sh
docker run --rm -v schoolmanagmentsystem_miniodata:/data alpine:3 chown -R 65532:65532 /data
docker compose up -d minio
```

`db:test:deploy` applies migrations to `TEST_DATABASE_URL` — rerun it after pulling new migrations.

## Running

```sh
pnpm dev
```

| What | Where |
|---|---|
| Web admin | http://localhost:3000 |
| Platform admin console | http://localhost:3000/platform/login |
| API | http://127.0.0.1:3001 |
| Mailpit (captured outgoing mail) | http://127.0.0.1:8025 |
| MinIO console (object storage) | http://127.0.0.1:9001 |

The Docker services and the API bind to `127.0.0.1` only. The Next.js dev server listens on all
interfaces, so run it only on a trusted network.

First platform sign-in: use the seeded email and password, scan the QR with an authenticator app,
confirm a code, then choose a new password (12 characters or more). Later sign-ins need email,
password and the current 6-digit code.

### First school and principal

No school is seeded. From the platform console:

1. **Schools → New school.** The short code you choose is the school code used at sign-in.
2. On the school's page, **Issue principal login** with full name, CNIC and phone.
3. Sign in at http://localhost:3000/login with the school code, the CNIC digits without dashes
   as the username, and the same digits as the password (settled rule 12). The first sign-in
   suggests a password change but does not force it.

## Tests and checks

```sh
pnpm --filter @asms/api test                                 # API tests (uses asms_test)
pnpm --filter @asms/web exec playwright install chromium     # once per machine
pnpm --filter @asms/api build                                # the real-API specs start apps/api/dist
pnpm --filter @asms/web test:e2e                             # web end-to-end tests
pnpm lint
pnpm typecheck
```

Stop `pnpm dev` before `test:e2e`: Playwright reuses a running server, and the dev API points at
the dev database, so the real-API specs would fail at their first sign-in.

CI (`.github/workflows/ci.yml`) runs on every push and pull request: install, Prisma generate,
lint, typecheck, migrations, API tests, a check that the committed OpenAPI document and web
client are not stale, the web build and Playwright. A red build blocks the slice.

After changing an API contract, regenerate and commit both generated files:

```sh
pnpm --filter @asms/api openapi
pnpm --filter @asms/web api:generate
```

## Where things are

| Path | Contents |
|---|---|
| `apps/api` | NestJS API, Prisma schema and migrations |
| `apps/web` | Next.js web admin |
| `packages/shared` | Code shared by the API and web (build it before the apps) |
| `docs/plans` | Build plans per phase; `phase-1-foundation.md` is the current one |
| `docs/WORKLOG.md` | Session handover log — what is done, in progress and next |
| `CLAUDE.md` | Settled architecture rules, open decisions, working rules |
| `.githooks` | The pre-commit guard |
| `docker-compose.yml` | Local development services |
