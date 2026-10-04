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
| Web admin | http://localhost:3460 |
| Platform admin console | http://localhost:3460/platform/login |
| API | http://127.0.0.1:3461 |
| Mailpit (captured outgoing mail) | http://127.0.0.1:8025 |
| MinIO console (object storage) | http://127.0.0.1:9001 |

The Docker services and the API bind to `127.0.0.1` only. The Next.js dev server listens on all
interfaces, so run it only on a trusted network.

First platform sign-in: use the seeded email and password, scan the QR with an authenticator app,
confirm a code, then choose a new password (12 characters or more). Later sign-ins need email,
password and the current 6-digit code.

### First school and principal

No school is seeded by default. The quick way, for development and CI (idempotent; prints
`created` or `exists`; refuses production, and refuses a database that is not on this machine
unless `ALLOW_DEV_SEED=1` is set):

```sh
DEV_SCHOOL_PRINCIPAL_CNIC=<13 digits> DEV_SCHOOL_PRINCIPAL_PHONE=<e.g. +923000000000> \n  pnpm --filter @asms/api seed:dev-school   # school code "demo"
```

The principal's password is the same 13 digits, so never point this at a shared database.

Or from the platform console:

1. **Schools → New school.** The short code you choose is the school code used at sign-in.
2. On the school's page, **Issue principal login** with full name, CNIC and phone.
3. Sign in at http://localhost:3460/login with the school code, the CNIC digits without dashes
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
client are not stale, the web build and Playwright. A second job, `mobile`, builds the Android
app and runs the Maestro flows on an emulator. A red build blocks the slice.

After changing an API contract, regenerate and commit both generated files:

```sh
pnpm --filter @asms/api openapi
pnpm --filter @asms/web api:generate
pnpm --filter @asms/mobile api:generate
```

## Mobile app

`apps/mobile` is the Android app: Expo (SDK 57) with a development build, not Expo Go
(contracts/slice-15.md). Every check below runs without an Android SDK:

```sh
pnpm --filter @asms/mobile lint
pnpm --filter @asms/mobile typecheck
pnpm --filter @asms/mobile test                                   # Jest + Testing Library
pnpm --filter @asms/mobile exec expo export --platform android     # Metro bundles everything
pnpm --filter @asms/mobile doctor                                 # expo-doctor
```

Running it on a phone or emulator needs the Android SDK and a JDK 17 (Android Studio has both).

```sh
pnpm --filter @asms/mobile android            # expo run:android: builds and installs the dev build
pnpm --filter @asms/mobile start              # Metro for the installed dev build
```

The app talks to the API at `EXPO_PUBLIC_API_URL`: `http://10.0.2.2:3461` from the emulator (the
default), or `http://127.0.0.1:3461` from a USB phone after `adb reverse tcp:3461 tcp:3461`. Only
the development profile (package `pk.asms.app.dev`, provisional) may use http; preview and
production builds must use https and refuse cleartext.

Push notifications need the owner's Firebase `google-services.json`, which is never committed.
Until it exists every build runs with `EXPO_PUBLIC_PUSH_ENABLED=false`: registration is skipped
and logged (`push.skipped`), and nothing else changes. With the file, set `GOOGLE_SERVICES_JSON`
to its path and `EXPO_PUBLIC_PUSH_ENABLED=true` at build time.

The Maestro flows (`apps/mobile/maestro`) run only in CI's `mobile` job, on an emulator.

## Where things are

| Path | Contents |
|---|---|
| `apps/api` | NestJS API, Prisma schema and migrations |
| `apps/web` | Next.js web admin |
| `apps/mobile` | Expo / React Native Android app |
| `packages/shared` | Code shared by the API, web and mobile (build it before the apps) |
| `docs/plans` | Build plans per phase; `phase-1-foundation.md` is the current one |
| `docs/WORKLOG.md` | Session handover log — what is done, in progress and next |
| `CLAUDE.md` | Settled architecture rules, open decisions, working rules |
| `.githooks` | The pre-commit guard |
| `docker-compose.yml` | Local development services |
