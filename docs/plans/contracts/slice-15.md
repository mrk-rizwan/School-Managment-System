# Slice 15 contract — mobile foundation (Expo / React Native, Android)

**Author:** implementation-planner (Fable 5.1), 2026-10-04. **Binds:** `apps/mobile/**` (new),
`packages/shared/src/{api-error,format}.ts` (new, moved from the web), `apps/web/lib/api/errors.ts`
and `apps/web/lib/format.ts` (become re-export shims), `.github/workflows/ci.yml` (new `mobile`
job), `apps/api/scripts/seed-dev-school.ts` (new, idempotent). **Sources:** `CLAUDE.md` (rules 2, 4,
12, 13, 16, 17; Design; market constraints; conventions table), `phase-2-daily-operations.md`
§0.14–0.15, §2, §3 (Mobile, Tests, CI rows), §4.3, §4.7, §4.8, slice 15 and 16, R153–R162, R166,
R169–R170, R173; `contracts/slice-9.md` §1.2–§1.6, §2.2, §3, §14 (mobile row), decision 2;
`contracts/slice-2.md` §3.1, §4.3; `contracts/slice-6.md` §4 (`Idempotency-Key`);
`contracts/slice-10.md` (`GET /me/calendar`). Everything not restated follows Phase 1 §3.9
(envelope, string ids, camelCase, dates) and the contracts above.

**Status:** build specification, approved for wave E. It plans no production code; Opus writes
the code from it. Every "must" below is a test or a lint rule.

---

## 0. Scope, and what moved

Slice 15 delivers **one installable Android app that signs in, shows a role-aware shell, survives
being offline, updates itself when told to, and leaks nothing** — with the machinery (outbox,
cache, push registration, logging) that slice 16's screens plug into. The only feature reads are
`GET /me` and `GET /me/calendar`; the only outbox lane is device registration.

Two changes to the plan's slice 15 text, both forced by sequencing:

1. **The read-only inbox list moves to slice 16.** The plan lists it under 15 ("from slice 14's
   `/me/inbox`"), but 15 runs in wave E and 14 in wave F; `GET /me/inbox` does not exist when 15 is
   built. Nothing is planned against an endpoint that is not there. `GET /me/calendar` (slice 10,
   built) is the read screen that proves the cache and "as of" machinery instead.
2. **Device registration is the first outbox lane.** The plan's three offline writes (register,
   diary, remark) are slice 16's; a state machine with no consumer cannot be shown working, so
   `POST /me/devices` (idempotent on the server, slice-9 §3.5) runs through the outbox from day
   one. The push-token refresh listener can fire offline, so it is a real case, not a contrivance.

Not in slice 15: feature screens of any kind, change-email (web only in Phase 2; the account
screen says so), dark mode (light only; the web's dark theme is not mirrored until a decision),
iOS (the project stays iOS-capable; nothing is built or tested), background sync (foreground
only, by design — data cost and simplicity), a crash reporter (sending crash data to a third
party is a decision not taken; see §10), the suspended-school banner (slice-9 §10: none on mobile).

---

## 1. Dependencies and decisions this slice waits on

| Item | State | Effect on slice 15 |
|---|---|---|
| Bearer login, `X-App-Version` floor, `POST /me/devices`, revoke-others, `MeDto.capacities/assignments` | **Built** (slice 9, `578c210`; all in `apps/api/openapi/school.json`) | None |
| `GET /me/calendar` | **Built** (slice 10) | None |
| `newIdempotencyKey()`, `APP_VERSION_PATTERN`, `Capacity`, `Capability`, `normaliseIdentityDigits`, `DEFAULT_TIMEZONE` in `@asms/shared` | **Built** | None |
| Firebase project and `google-services.json` | **Owner, pending** (§1.2 of the plan: account `devjourtechnologiesteam`) | None for the build: §8 makes push registration skip and log when the file is absent. Push is **not** demonstrated in 15 unless the file arrives |
| Google Play developer account, Expo (EAS) account | Owner, pending | None for a local dev build; needed for the internal-testing track and for cloud builds (§2.6) |
| Android `applicationId` | **Open — owner decision.** It is permanent once published. Recommended: a reverse domain the owner controls (for example `com.devjour.asms`); the dev build uses `com.devjour.asms.dev` so both can be installed side by side | The dev build can start with the recommendation; **the first Play upload cannot happen until the owner confirms it** |
| Android SDK on the build machine | **Not found on this machine** (§15) | Local `expo run:android` and local Maestro are impossible until installed; everything in §13.4 "must pass locally" still runs |
| 401 handling: "pause the queue" (R157) versus "any 401 wipes the SQLite store" (R155, §4.7) | **Inconsistent in the approved plan**; reconciled in §7.6, flagged for the wave-E `security-reviewer` | Does not block 15 (its only lane carries a push token, which is not sensitive data); it decides what slice 16's offline registers survive |
| Register item 30 (privileged capabilities on a default password) | Open; not needed by Phase 2 | None |

No other decision is open. The plan's §1.2 answers (Android only, owner-made Firebase project,
one role-aware app) are settled.

---

## 2. Workspace, versions, and how the app consumes what exists

### 2.1 Workspace placement

`apps/mobile` is a pnpm workspace package `@asms/mobile`; `pnpm-workspace.yaml` already lists
`apps/*`, so **no workspace change**. Consequences of the root scripts:

- `pnpm dev` runs `pnpm -r --parallel --filter ./apps/* dev`. The mobile package **has no `dev`
  script** (its Metro script is `start`), so `pnpm dev` still starts exactly the API and the web.
- `pnpm -r lint`, `typecheck`, `test` now include the mobile package, so each must pass headless
  with no Android SDK, no emulator and no network.
- Shared files touched by this slice (`packages/shared`, `apps/web/lib/api/errors.ts`,
  `apps/web/lib/format.ts`, `.github/workflows/ci.yml`, `apps/api/scripts/`) are edited by the main
  thread or by the one agent named for them in the wave, per the WORKLOG process.

### 2.2 Pinned versions

**Resolution rule, binding:** every Expo-owned package is installed with `npx expo install <pkg>`
so its version is the one the SDK pins; mixing SDK-mismatched Expo modules is the most common
Expo failure and is refused. Non-Expo packages are pinned to the exact version the rest of the
monorepo already holds where one exists. The exact versions resolved on day one are **recorded in
`WORKLOG.md`** (plan §3 requires it) and `package.json` carries exact versions, no `^`.

| Package | Version | Why |
|---|---|---|
| `expo` | **SDK 55** (`expo@~55.0`) — the floor this contract vouches for | React Native 0.83, React 19.2 — the same React major and minor as the web (19.2.8). If `npx create-expo-app@latest` offers a newer stable SDK on day one, take it **only if** its React is still 19.x, every module below has a version for it, and `jest-expo` and `expo-router` exist for it; otherwise stay on 55. Record the choice |
| `react-native`, `react` | the SDK's (0.83.x, 19.2.x) | New Architecture only (the legacy architecture is gone from RN 0.82+); every native module below supports it |
| `expo-router` | SDK-aligned | File-system routing, typed routes on (`experiments.typedRoutes`), deep links for notification taps |
| `expo-dev-client` | SDK-aligned | **Development builds, not Expo Go** (plan §3: push needs a native module) |
| `expo-secure-store` | SDK-aligned | The token store (§4.3); Android Keystore-backed |
| `expo-sqlite` | SDK-aligned | Cache and outbox (§7); the current async API (`openDatabaseAsync`, `withExclusiveTransactionAsync`, prepared statements) |
| `expo-notifications` | SDK-aligned | FCM device token, permission, tap handling (§8) |
| `expo-image` | SDK-aligned | Thumbnails on tap only (§9); `cachePolicy: 'disk'` |
| `expo-crypto` | SDK-aligned | `randomUUID` polyfill for `newIdempotencyKey()` (§2.4) |
| `expo-constants`, `expo-device`, `expo-linking`, `expo-status-bar`, `expo-build-properties`, `expo-splash-screen` | SDK-aligned | App version header, device checks, Play Store intent, status bar, manifest properties |
| `react-native-safe-area-context`, `react-native-screens`, `react-native-gesture-handler`, `react-native-reanimated` | SDK-aligned | `expo-router` peers; nothing else uses Reanimated (no decorative animation, Design rules) |
| `@react-native-community/netinfo` | SDK-aligned (`expo install`) | Connectivity listener (§7.5) |
| `@tanstack/react-query` | **5.104.0** (= web) | One query library, one version in the lockfile |
| `openapi-fetch` | **0.17.0** (= web) | The same generated client (§2.5) |
| `openapi-typescript` (dev) | **7.13.0** (= web) | Generates `school.d.ts` from the same document |
| `zod` | **4.6.5** (= web, API) | Validates SQLite rows and push payloads at the boundary; nothing else |
| `typescript` | **5.9.3** (= root) | |
| `jest-expo` (dev) | SDK-aligned | Preset for Jest under Hermes-like semantics |
| `jest` (dev) | the version `jest-expo` peers on (29.7.x) | The API's Jest 30 is a different workspace package; pnpm keeps both |
| `@testing-library/react-native` (dev) | 13.x, latest at install | React 19 support starts at 13 |
| `eslint` 9.39.5, `eslint-config-expo` (SDK-aligned), `typescript-eslint` 8.71.0 (= API) | | Flat config, type-aware (§11) |
| Maestro CLI | 2.x, pinned by `MAESTRO_VERSION` in CI | CI-only (§13.3) |
| JDK | Temurin 17 | What RN 0.83 / AGP 8 build with |
| Android | `compileSdk`/`targetSdk` the SDK's defaults; `minSdk` the SDK's default (24+); CI emulator API 34, `google_apis`, `x86_64` | |

**React 19 compatibility note.** The web is on React 19.2.8; the SDK pins React 19.2.x. The two
apps are separate packages, so the lockfile may hold two patch versions of React — harmless,
because **`@asms/shared` has no React dependency and never will** (a test asserts its
`package.json` has none). `react-dom` is not installed in the mobile package. `@tanstack/react-query`
5 and `@testing-library/react-native` 13 both support React 19.

### 2.3 pnpm's isolated `node_modules` and Metro

The repo uses pnpm 12 with the default isolated linker (no `.npmrc`). Expo's Metro config
auto-detects a pnpm workspace and follows symlinks; Expo autolinking resolves native modules from
the package's own `node_modules`. **Day-one verification (task 15.1):** `expo export --platform
android` bundles, `expo-doctor` is clean, and `expo prebuild --platform android` produces a Gradle
project whose autolinking lists every native module above. If any of the three fails for a
symlink reason, the **stated fallback** is `node-linker=hoisted` in a root `.npmrc`, after which
the API and web are re-verified (`pnpm install --frozen-lockfile`, `pnpm -r typecheck test`,
`pnpm --filter @asms/web build`) before the change is committed. No other Metro customisation
(`watchFolders`, `nodeModulesPaths`) is added unless the verification demands it, and then it is
commented with the failure it fixes.

### 2.4 Consuming `@asms/shared` from React Native — inspected

Findings (`packages/shared/src/**`, 2026-10-04): **no Node-only import anywhere** (the only
intra-package import is `./identity`); the package is `type: commonjs`, `main: dist/index.js`,
built by `tsc` targeting ES2023; the one runtime global is `globalThis.crypto.randomUUID()` in
`idempotency.ts`. Metro consumes CommonJS from `dist` without configuration.

Rules that follow:

- **Build before Metro.** The mobile `start`, `test`, `typecheck` and `lint` scripts are preceded
  by `pnpm --filter @asms/shared build` (as CI already does for the API and web). A stale `dist`
  is a wrong type, not a runtime surprise.
- **`crypto.randomUUID` is not guaranteed by Hermes.** `src/platform/crypto-polyfill.ts` is the
  first import of the entry file: when `globalThis.crypto?.randomUUID` is absent it installs
  `expo-crypto`'s `randomUUID` and `getRandomValues`. A Jest test under `jest-expo` asserts
  `newIdempotencyKey()` returns a dashed v4 UUID and that two calls differ. Without this the
  first offline write would throw.
- **No deep imports** (`@asms/shared/dist/...`): lint-banned, as the API bans re-exports.
- `Intl.DateTimeFormat` with `timeZone` is available in Hermes on Android, which is what makes
  the moved `format` helpers (§2.5) safe on both sides; a Jest test formats a fixed instant in
  `Asia/Karachi`.

### 2.5 The same generated API client — how

The contract is declared once, on the server (`apps/api/openapi/school.json`); the web consumes
it as `openapi-typescript` output plus `openapi-fetch`. The mobile does exactly the same:

- `apps/mobile/src/api/school.d.ts` is generated by the mobile package's own `api:generate` script
  (`openapi-typescript ../api/openapi/school.json -o src/api/school.d.ts --default-non-nullable
  false`, the web's flags). It is a **build artefact of the same document**, committed like the
  web's copy, and **CI's OpenAPI staleness step regenerates and diffs both** (`git diff
  --exit-code -- apps/api/openapi apps/web/lib/api apps/mobile/src/api`), so the two copies cannot
  drift. The platform document is not generated for mobile: the app never talks to
  `/api/v1/platform/*`.
- `src/api/client.ts` creates **one** `openapi-fetch` client with `baseUrl` = the build's API URL
  (§2.6), `credentials: 'omit'` (no cookie, ever — R170), `headers: { Accept: 'application/json' }`,
  and one `onRequest` middleware that adds `X-App-Version` and, when signed in,
  `Authorization: Bearer <token>`. One `onResponse` middleware routes `401` and `426` to the
  session and update handlers (§6). This file is the only importer of `openapi-fetch` and the only
  caller of the global `fetch` (lint).
- **Hand-written helpers that both clients need move to `packages/shared`**, so nothing is
  duplicated: `ApiError`, `toApiError`, `rateLimitMessage`, `describeApiError` go to
  `packages/shared/src/api-error.ts`, typed structurally (`toApiError` takes `{ status; headers:
  { get(name) } }`, and the envelope type is declared as `{ error: { code: ErrorCode; message;
  details?; requestId? } }` rather than imported from a generated file). `apps/web/lib/api/errors.ts`
  keeps `ApiErrorEnvelope` (generated), `toastApiError` and `refusalMessage` and **re-exports the
  moved names**, so no web screen changes (75 files import it today). Likewise `formatDate`,
  `formatDateTime`, `formatDay`, `todayInSchool` move to `packages/shared/src/format.ts` and
  `apps/web/lib/format.ts` re-exports them next to `formatBytes`. Both moves are covered by the
  existing web typecheck and Playwright runs; they are main-thread edits.
- Contract files follow the web's pattern: `src/api/contracts.ts` re-exports the DTO and body
  types the screens use from `school.d.ts` (`MeDto`, `LoginResultDto`, `MeAssignmentDto`,
  `DeviceDto`, `MeCalendarDto`, `SchoolLoginDto`, `RegisterDeviceDto`, `ChangePasswordDto`), so a
  regenerated document is checked by `pnpm typecheck`.

If a third consumer appears later, the generated types and `createSchoolClient` become a
`packages/api-client` package; today that is a package for two files and is not built.

### 2.6 Build profiles, base URL and cleartext

| Profile | Built how | `EXPO_PUBLIC_API_URL` | Notes |
|---|---|---|---|
| `development` | `expo run:android` (needs the Android SDK) or EAS `development` (dev client, APK) | emulator: `http://10.0.2.2:3001` (the host's loopback, which is where the API binds — README); device: `http://127.0.0.1:3001` with `adb reverse tcp:3001 tcp:3001` | Cleartext is allowed **only here**, by the `android:usesCleartextTraffic="true"` that Expo prebuild writes to the **debug** manifest; `applicationId` suffix `.dev` |
| `preview` | EAS `preview` (internal APK) | `https://<staging-api>` | Play internal testing |
| `production` | EAS `production` (AAB) | `https://<api>` | |

`app.config.ts` **throws at config time** when a non-development profile's URL is not `https://`
(the URL is fixed per build, plan §3; a release build cannot be pointed at an http endpoint).
`expo-build-properties` sets `android.usesCleartextTraffic: false` explicitly, and a CI check greps
the prebuilt **release** manifest for `usesCleartextTraffic="true"` and fails on a match (R155's
"cleartext traffic is off" as a test). The app sends **no `Origin` header** (React Native's fetch
sends none) and holds no cookie, which is what the API's bearer rules require (R170).

`eas.json` carries the three profiles; EAS itself needs the owner's Expo account (§1). Until it
exists, `expo run:android` on a machine with the SDK is the only way to produce a build.

---

## 3. Folder layout

```
apps/mobile/
  app.config.ts                 Expo config from env: name, slug, applicationId (+ .dev), version,
                                googleServicesFile only when GOOGLE_SERVICES_JSON is set (§8),
                                plugins (router, secure-store, sqlite, notifications, build-properties),
                                android.usesCleartextTraffic false, https guard (§2.6)
  eas.json                      development / preview / production
  index.ts                      entry: crypto polyfill first, then expo-router
  metro.config.js               expo/metro-config defaults (see §2.3)
  babel.config.js               babel-preset-expo
  jest.config.js                preset jest-expo; setup file installs the polyfill and fake timers
  eslint.config.mjs             §11 boundaries
  tsconfig.json                 extends ["expo/tsconfig.base", "../../tsconfig.base.json"]; strict
  maestro/
    flows/sign-in-shell-sign-out.yaml
    flows/update-required.yaml           (426 via MOBILE_MIN_APP_VERSION=99.0.0 on the API)
    README.md                            how CI runs them; CI-only (§13.3)
  src/
    app/                        expo-router routes (src/app is supported; everything stays under src)
      _layout.tsx               providers: QueryClient, Session, Outbox, Theme; the gate (§4.1)
      sign-in.tsx
      update-required.tsx
      no-access.tsx
      (tabs)/_layout.tsx        tabs = composeTabs(me) filtered by SCREEN_REGISTRY (§5)
      (tabs)/home.tsx
      (tabs)/calendar.tsx
      (tabs)/account/index.tsx  change password, sign out, sign out other devices, sync, diagnostics
      (tabs)/account/change-password.tsx
      (tabs)/account/sync.tsx   the sync status sheet (§7.7)
      (tabs)/account/diagnostics.tsx   the scrubbed log ring buffer (§10)
      (tabs)/inbox/ classes/ children/ student/ today/ announce/   slice 16 (not created in 15)
    api/
      client.ts                 the one openapi-fetch client + middlewares (§2.5, §6)
      school.d.ts               generated
      contracts.ts              DTO/body type re-exports
      query-keys.ts             ['me'], ['me','calendar', from, to], …
    auth/
      session-store.ts          the ONLY importer of expo-secure-store (§4.3)
      session.tsx               provider/hook: state machine signed-out | signed-in | lost | blocked
      sign-in.ts                login call, store writes, post-login hooks
      tabs.ts                   composeTabs(me): pure (§5)
      screen-registry.ts        which tab ids have a screen in this build
    db/
      database.ts               open, PRAGMAs, migrations, wipe, owner check (§7.1)
      schema.ts                 the DDL as a versioned array
      cache.ts                  get/put/evict keyed by endpoint (§7.2)
      outbox.repository.ts      the only SQL on the outbox table
    outbox/
      lanes.ts                  the lane table (§7.3)
      machine.ts                pure transition function: (item, event) -> (item', effects) (§7.4)
      worker.ts                 runner: picks, sends, applies transitions, schedules (§7.5)
      coalesce.ts               register natural-key merge (slice 16 fills the merge; 15 ships the rule and tests)
      backoff.ts                the schedule (§7.4)
    push/
      registration.ts           the only importer of expo-notifications (§8)
      routing.ts                routeForNotification(payload): pure
    net/connectivity.ts         NetInfo listener → one boolean + subscribers
    platform/
      log.ts                    the only console caller; ring buffer; scrubber (§10)
      scrub.ts                  the R16 patterns (identity, phone, token) as one pure function
      app-version.ts            reads expo-constants; asserts APP_VERSION_PATTERN at startup
      crypto-polyfill.ts
    ui/
      theme.ts                  tokens (§12)
      states.tsx                LoadingState, EmptyState, ErrorState, NoPermissionState, OfflineNotice
      Screen.tsx, Button.tsx, Field.tsx, ListRow.tsx, Banner.tsx, Sheet.tsx
  __tests__/                    or co-located *.spec.ts(x); scripted-day.spec.ts (§9)
```

One component per concern; slice 16 adds route folders and lanes, not new infrastructure.

---

## 4. Auth flow and the secure store

### 4.1 Startup gate (in `_layout.tsx`, in this order)

1. Polyfills; open the database and migrate (§7.1); read the app version and assert it matches
   `APP_VERSION_PATTERN` (a build with a malformed version fails fast, not with a 426 in the field).
2. Read the token from the secure store. **None → sign-in screen.**
3. Token present → check the store owner (`meta.user_id`, `meta.school_id` equal the secure
   store's); mismatch → wipe the database, continue.
4. Render the shell immediately from the cached `GET /me` body if one exists (with its "as of"),
   then refetch `GET /me`. Outcomes: `200` → replace cache and shell; `401` → session lost (§4.5);
   `426` → update screen (§6, §11); network error → stay on the cached shell, offline notice;
   no cache and network error → an offline "cannot reach the school" screen with retry.
5. `me.capacities` empty → `no-access` screen, then sign-out (R156). The API refuses such a login
   anyway (`401`); this is the defensive branch for a capacity lost mid-session.
6. Start the outbox worker (§7.5) and the connectivity listener; run push registration (§8) once
   the shell is visible.

### 4.2 Sign-in screen → `POST /auth/login`

Fields: school code (pre-filled from the remembered value; editable; a "not your school?" link
clears it), identity number (CNIC or B-Form, dashes allowed; normalised with
`normaliseIdentityDigits` before sending; the field never remembers the last value in component
state across app restarts — only the secure store does, §4.3), password (never remembered). Body
`{ schoolCode, username, password, channel: 'bearer' }`; headers `X-App-Version`, and
**`Authorization: Bearer <old token>` when the secure store still holds one** (slice-9 §3.1 step 6:
the server revokes the presented session and, by the join, its device). Response handling:

| Status / code | Screen behaviour |
|---|---|
| `200 LoginResultDto` | `bearerToken` → secure store; `me.id`, `me.school.id` → secure store and `meta`; remembered school code and username written; `LoginResultDto` cached as `GET /me`; shell |
| `401 AUTH_FAILED` | One generic sentence (R11: the server's message), the password cleared, nothing else |
| `422` on `channel` | Impossible when the header is sent; shown as a generic failure and logged as a bug |
| `426` | Update screen |
| `429` | `rateLimitMessage` (the `Retry-After` wait) |
| `503` | "The school's system is busy. Try again shortly." |
| network | "No connection. Sign-in needs a connection." The outbox is irrelevant here: sign-in is online-only |

`passwordIsDefault: true` → a persistent, dismissable-per-session banner on Home: "You are using the
default password. Change it." → Account → change password (rule 12: prompt, do not force).

### 4.3 Secure store — the whole key list

`expo-secure-store` is imported only by `src/auth/session-store.ts` (lint). Nothing else on the
device persists any of these; **`AsyncStorage` is not installed** and its import is lint-banned,
so R155's "no identity number … reaches `AsyncStorage`" is structural.

| Key | Value | Written | Cleared |
|---|---|---|---|
| `asms.session.token` | the 43-character bearer token | login; change-password rotation (replaced **before** anything else runs on the response, slice-9 §14) | sign-out; any `401` (§4.5) |
| `asms.session.userId`, `asms.session.schoolId` | ids (strings) | login | with the token |
| `asms.remembered.schoolCode` | the school code | successful login | "not your school?"; never by a 401 |
| `asms.remembered.username` | the normalised identity digits | successful login | "forget me" on the sign-in screen; never by a 401 |
| `asms.push.token` | the last FCM token successfully registered | after `POST /me/devices` `2xx` | sign-out |

The password is never stored. The remembered username is the user's own identity number inside
Android's Keystore-backed storage, as the plan allows (§4.7 "the remembered school code and
username live only in the secure store"); it is shown masked on the sign-in screen
(`35201-*****-1` form) with the full value never rendered after the first login.

### 4.4 Account actions

| Action | Call | Behaviour |
|---|---|---|
| Change password | `POST /me/change-password` | Needs a verified email (`409 EMAIL_NOT_VERIFIED` → "Add and verify an email on the web first"); on `200 LoginResultDto` the new `bearerToken` replaces the stored one first, then `me` is updated; `409 CURRENT_PASSWORD_INCORRECT` on the field. Online-only (R162): disabled with "needs a connection" when offline |
| Sign out | `POST /auth/logout` | Server first (revokes the session and its device, R159), then wipe (§4.6). A `401` reply counts as signed out. A network failure → "Could not reach the school. Sign out anyway?" → local wipe only; the session dies by idle-out, and the user is told so |
| Sign out other devices | `POST /me/sessions/revoke-others` | Confirm; shows "`n` signed out". Online-only |
| Sync status | — | §7.7 |
| Diagnostics | — | §10 |

### 4.5 Session loss — any `401` outside the login form

The `onResponse` middleware turns any `401` whose code is not `AUTH_FAILED` into one event. Then:
the token and session ids leave the secure store; **every read cache row is deleted**; TanStack
Query's cache is cleared; the outbox queue is **paused**; the sign-in screen opens with the
remembered school code and username and, if pending outbox rows exist, the line "`n` unsent
items will be sent after you sign in". What happens to those rows is §7.6.

### 4.6 Wipe

Sign-out, "forget me", a store-owner mismatch and the §7.6 cases call one function: delete the
SQLite database file (`deleteDatabaseAsync`), clear TanStack Query, remove every `asms.session.*`
and `asms.push.*` key. A test asserts that after sign-out the database file does not exist, the
secure store holds only the two `asms.remembered.*` keys, and the query cache is empty.

---

## 5. Tab composition from `/me` (R156) — one pure function

`composeTabs(me: Pick<MeDto, 'capacities' | 'capabilities' | 'assignments'>): TabId[]` in
`src/auth/tabs.ts`. No React, no I/O. The shell renders `composeTabs(me)` **intersected with
`SCREEN_REGISTRY`** (the tab ids that have a screen in this build), so a permitted tab with no
screen yet is simply not shown, and a tab the API would refuse is never produced.

Notation: `staff`/`guardian`/`student` = the capacity is present; `cap(x)` = `x` is in
`capabilities`; `A` = `assignments` is non-empty (rows active today, cover included).

| Tab id | Condition (all must hold) | Who typically sees it | Screen ships in |
|---|---|---|---|
| `home` | always (a signed-in user with at least one capacity) | everyone | **15** |
| `classes` | `staff ∧ A ∧ (cap(attendance.student.mark) ∨ cap(diary.write) ∨ cap(remark.write))` | class, subject and cover teachers | 16a |
| `today` | `staff ∧ cap(attendance.student.view_all)` | principal; office staff (role default) | 16b (arrivals action inside it needs `cap(attendance.student.mark)`) |
| `announce` | `staff ∧ cap(announcement.send.school)` | principal | 16b (a `.scope`-only holder gets no tab in Phase 2; scoped notices stay on the web) |
| `children` | `guardian` | parents | 16a |
| `student` | `student` | students (own attendance, diary) | 16a |
| `inbox` | always | everyone (`GET /me/inbox` is `@AuthenticatedOnly`) | 16a |
| `calendar` | always | everyone (`GET /me/calendar`) | **15** |
| `account` | always | everyone | **15** |

Rules the test table proves:

- **Order** is fixed: `home, classes, today, announce, children, student, inbox, calendar, account`.
- **Bottom bar holds at most five**; `home` is always first and `account` always last among the
  shown tabs; when more than five tabs are shown, positions 1–4 are the first four and the fifth is
  `more`, listing the rest (so a teacher-parent sees Home, Classes, Children, Inbox, More → Calendar,
  Account).
- Capabilities alone never produce `classes`: a teacher whose assignments ended yesterday has
  `cap(attendance.student.mark)` and no `A` → no Classes tab (scope comes from assignment data, rule
  13). A principal with no assignments has `today` and `announce`, not `classes`.
- A user with no capacity → `[]`; the caller shows `no-access` and signs out.
- "My attendance" (R135, `GET /me/staff/attendance`) is a card on Home for `staff`, not a tab (16a).

Jest fixtures: principal; office clerk (role default); class teacher; subject teacher; cover
teacher only; teacher with ended assignments; parent; student; teacher-parent; principal-parent;
no capacity. Each asserts the exact ordered list and the five-slot layout.

---

## 6. The request layer — every request, one behaviour table

Headers on every request: `X-App-Version` (from `expo-constants`' native version; asserted at
startup), `Accept: application/json`, `Authorization: Bearer <token>` when signed in,
`Idempotency-Key` on lanes that declare it (§7.3). Never `Origin`, never a cookie
(`credentials: 'omit'`). Timeouts: 20 s reads, 30 s writes (`AbortController`); a timeout is a
network error.

| Outcome | Reads (TanStack Query) | Outbox items (§7.4) | Global |
|---|---|---|---|
| `2xx` | cache row written with the response `Date` header as "as of" (§7.2) | `done` | — |
| `401` (not `AUTH_FAILED`) | query fails silently; the screen is replaced | item back to `pending`, queue `paused` | §4.5 |
| `403 PERMISSION_DENIED` | `NoPermissionState` (should not occur: R156) | `failed` (terminal, server message) | logged as a composition bug |
| `404` | `EmptyState` "no longer available" | `failed` (terminal: the row is gone or out of scope) | — |
| `409` | shown with the server's message | `failed` (terminal) — the sync sheet offers the lane's remedy (§7.4) | — |
| `422` | field errors from `details.fields` | `failed` (terminal: a bad body never heals) | — |
| `426 UPGRADE_REQUIRED` | — | item back to `pending`, queue `blocked` | update screen (§11); nothing else sends |
| `429` | `rateLimitMessage` | `pending`, `next_attempt_at = now + Retry-After` (default 60 s) | — |
| `5xx`, network, timeout | cached data with `OfflineNotice` if any, else `ErrorState` with retry | `pending` with backoff | offline banner from NetInfo, not from errors |

TanStack Query defaults for the app: `networkMode: 'offlineFirst'`, `staleTime` 5 min, `gcTime`
24 h, `refetchOnWindowFocus: false`, `refetchOnReconnect: true` for the visible screen only,
`retry: 1` for reads, `retry: 0` for mutations (the outbox owns retries). Reads are hydrated from
the SQLite cache (`initialData` + `initialDataUpdatedAt`), so a cold start offline shows data.

---

## 7. Offline store and the outbox

### 7.1 Database

One file, `asms.db`, opened by `src/db/database.ts` (the only `expo-sqlite` importer):
`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000`. Migrations are
a versioned array applied inside one exclusive transaction; `meta.schema_version` records the
level; a downgrade (file newer than the app) wipes rather than guesses. Every outbox write happens
in **one transaction with its domain row** (plan §4.7); slice 15 has no domain tables yet and
reserves the pattern.

### 7.2 Tables (normative)

**`meta`**

| Column | Type | Meaning |
|---|---|---|
| `key` | TEXT PK | `schema_version`, `user_id`, `school_id`, `push_permission_asked_at` |
| `value` | TEXT NOT NULL | ids only — never a name, number or token |

**`cache`** — read responses, keyed by endpoint and canonical params

| Column | Type | Meaning |
|---|---|---|
| `key` | TEXT PK | `GET <path>?<params sorted by name>`, for example `GET /api/v1/me/calendar?dateFrom=2026-10-01&dateTo=2026-10-31` |
| `body` | TEXT NOT NULL | the JSON exactly as received |
| `server_time` | TEXT NOT NULL | the response's `Date` header as ISO-8601 — the **"as of"** shown on screen; when the header is missing the device clock is used and `server_time_is_device = 1` |
| `server_time_is_device` | INTEGER NOT NULL DEFAULT 0 | so the UI can say "as of (device time)" |
| `fetched_at` | TEXT NOT NULL | device clock; eviction |

Eviction: rows older than 30 days by `fetched_at`, and everything on wipe. Index: none beyond the
primary key (a few hundred rows at most).

**`outbox`** — one row per intended write

| Column | Type | Meaning |
|---|---|---|
| `id` | TEXT PK | `newIdempotencyKey()` — also the `Idempotency-Key` for header lanes |
| `lane` | TEXT NOT NULL | a key of the lane table (§7.3) |
| `method`, `path` | TEXT NOT NULL | the request |
| `natural_key` | TEXT NULL | `section:<id>|date:<YYYY-MM-DD>|period:<n>` for registers; NULL otherwise |
| `body` | TEXT NOT NULL | JSON |
| `state` | TEXT NOT NULL CHECK IN (`pending`,`sending`,`done`,`failed`) | §7.4 |
| `attempts` | INTEGER NOT NULL DEFAULT 0 | network/5xx/429 attempts |
| `next_attempt_at` | TEXT NULL | ISO; NULL = now |
| `sending_since` | TEXT NULL | set with `sending`; crash recovery (§7.4) |
| `response_status` | INTEGER NULL | last HTTP status |
| `response_code`, `response_message` | TEXT NULL | the envelope's `code` and `message` on `failed`; never a response body |
| `domain_table`, `domain_id` | TEXT NULL | the local row written in the same transaction (slice 16) |
| `created_at`, `updated_at` | TEXT NOT NULL | |

Indexes: `(lane, state, created_at)`; **`UNIQUE (natural_key) WHERE natural_key IS NOT NULL AND
state = 'pending'`** — coalescing is enforced by the schema, not only by code (§7.4).

### 7.3 Lanes (R158 — independent per endpoint)

| Lane | Endpoint | Idempotency | Remedy offered on a terminal failure | Ships |
|---|---|---|---|---|
| `device_register` | `POST /me/devices` | server-side (same token → `200`) | none; silently superseded by the next token | **15** |
| `submit_register` | `POST /sections/:id/submit-register` | natural key + coalescing; `409 AMENDMENT_REASON_REQUIRED` → "add a reason and resend" creates a new pending item for the key; `409 STALE_STATUS` / `ATTENDANCE_LOCKED` / `NOT_A_TEACHING_DAY` → shown, discard | 16a |
| `diary_entry` | `POST /sections/:id/diary-entries` | `Idempotency-Key` header = `outbox.id` | `409 DIARY_ENTRY_EXISTS` → open the existing entry | 16a |
| `remark` | `POST /students/:id/remarks` | header | — | 16a |
| `diary_attachment` | upload for a diary entry | own lane (a failed photo never blocks a register, R158) | retry / discard | 16a |

Lane rules: **one request in flight per lane**; lanes run concurrently (at most three at once);
within a lane, `created_at` ascending; a lane's terminal failure never stops the lane. **Online-only
actions never enter the outbox** (R162): change password, revoke-others, arrivals, amend after the
window, assign cover, send announcement are called directly and disabled offline with "needs a
connection". The lane table is the single place that says which is which; a test asserts the
R162 list is absent from it.

### 7.4 The state machine (normative; `machine.ts` is pure and table-tested)

States: `pending → sending → done | failed(reason)`. Queue flags, separate from item state:
`offline`, `paused` (401), `blocked` (426).

| From | Event | To | Effects |
|---|---|---|---|
| — | user saves an offline-capable write | `pending` | same SQLite transaction as the domain row; `next_attempt_at = NULL`; if the lane has a natural key and a **`pending`** row with that key exists → **merge into it** instead (marks by `enrolmentId`, latest wins; `reason` kept or replaced by the newer non-empty one) — the partial unique index makes a second pending row impossible; if that key's row is `sending`, a new `pending` row is created and later writes merge into *that* |
| `pending` | worker tick: lane idle ∧ online ∧ not paused ∧ not blocked ∧ `next_attempt_at ≤ now` | `sending` | `attempts + 1`, `sending_since = now` |
| `sending` | `2xx` | `done` | domain row marked saved on server with the server's ids; related query keys invalidated; **"saved on server" appears only now** (R157); `done` rows deleted after 7 days |
| `sending` | `401` | `pending` (attempts unchanged) | queue `paused`; §4.5 |
| `sending` | `403`, `404`, `409`, `422` | `failed` | `response_code/message` from the envelope; shown in the sync sheet with the lane's remedy; the domain row shows "not saved: <message>" |
| `sending` | `426` | `pending` (attempts unchanged) | queue `blocked`; update screen |
| `sending` | `429` | `pending` | `next_attempt_at = now + Retry-After` (60 s default) |
| `sending` | `5xx`, network error, timeout | `pending` | `next_attempt_at = now + backoff(attempts)`: **5 s, 30 s, 2 min, 10 min, 30 min, then every 30 min**; **no give-up** — a weekend offline must still sync on Monday; the item stays visible in the sync sheet |
| `sending` | app restarted with `sending_since` older than 60 s | `pending` | the request may or may not have reached the server; every lane is idempotent, so resending is safe |
| `pending` or `failed` | user taps "discard" (confirm) | row deleted | the domain row is marked "discarded" (rule 4 governs server rows, not device scratch) |
| `failed` | user taps the lane's remedy | a **new** `pending` row | the failed row stays until its 7-day purge |
| any | wipe (§4.6) | gone | |

Worker triggers: app foreground, connectivity becomes online, a successful sign-in, each `done`,
and a timer for the earliest `next_attempt_at` **while the app is foregrounded**. No background
task, no push-triggered sync (data cost; the walk back to the staff room is the sync).

### 7.5 Connectivity

`@react-native-community/netinfo` is read only in `src/net/connectivity.ts`, which exposes one
boolean and a subscription. `isInternetReachable === false` or `isConnected === false` → offline.
Offline is a **banner state**, not an error state: lists show cached data with "as of"; writes save
to the device and say so. The worker never trusts the flag alone — a request is attempted when the
flag is online and the outcome decides.

### 7.6 The 401 question — pause versus wipe (needs the wave-E security review's confirmation)

The plan says both "`401` pauses the queue and asks for sign-in" (R157) and "sign-out and any
`401` wipe the SQLite store" (R155, §4.7). Read literally, a teacher whose session idles out on a
Friday (14-day idle for staff; a long leave) loses Friday's unsent register — the exact case the
outbox exists for. This contract **proposes** the narrow reconciliation below and asks the
`security-reviewer` to confirm or refuse it in the wave-E review; it is written so either answer is
a one-function change in `database.ts`.

**Proposed rule.** On any `401`: the token and session ids are removed; **every `cache` row and
every `done`/`failed` outbox row are deleted; TanStack Query is cleared; `pending` and `sending`
outbox rows survive**, bound to `meta.user_id`/`school_id`. The queue is `paused`. At the next
successful sign-in: same `user_id` and `school_id` → the queue resumes; a different user, or
"forget me", or sign-out → full wipe. The sign-in screen says how many unsent items wait and
offers "discard them". **Fallback if refused:** the strict reading — full wipe on `401`, and the
sign-in screen says "`n` unsent items were discarded because your session ended" with the lane
names and dates, so nothing is lost silently.

Slice 15 is unaffected either way: its only lane carries a push token. Slice 16 inherits the
confirmed answer.

### 7.7 The sync status sheet (Account → Sync; also a header chip when anything is not `done`)

Lists lanes with their counts and items: "Saved on device" (`pending`, with "retrying in …" when
backed off), "Sending", "Not saved: <server message>" (`failed`) with the lane's remedy and a
discard button, and the queue flag ("Paused — sign in to continue", "Update the app to continue",
"Offline"). "Retry now" sets every `pending` item's `next_attempt_at` to now and ticks the worker.
No green tick appears for anything but `done` (plan §0.15). Slice 15 shows the sheet working with
the `device_register` lane (which has no user-visible remedy and is labelled "notification
registration").

---

## 8. Push registration (`expo-notifications`) — works without Firebase

- `app.config.ts` sets `android.googleServicesFile` **only when** the env var
  `GOOGLE_SERVICES_JSON` names an existing file; otherwise the key is omitted and the build has no
  Firebase. `google-services.json` is never committed (it is per-project client config with API
  keys; the owner supplies it; CI reads it from a secret, EAS from a file secret). A build-time
  public flag `EXPO_PUBLIC_PUSH_ENABLED` mirrors its presence so the app does not probe native
  code to find out.
- Registration runs after the shell is visible, on first sign-in and on every app open:
  1. `EXPO_PUBLIC_PUSH_ENABLED` false → log `push.skipped { reason: 'no_firebase' }`, stop. **This
     is the state of every build until the owner's Firebase project exists.**
  2. Android 13+ permission: ask once (store `push_permission_asked_at` in `meta`), with one
     sentence of context first; denied → `push.skipped { reason: 'permission_denied' }`; ask again
     no sooner than 30 days later.
  3. `getDevicePushTokenAsync()` → the **native FCM token** (the server sends through
     `firebase-admin`; Expo's push service is not used). If it equals `asms.push.token`, stop.
  4. Enqueue `device_register` with `{ platform: 'android', pushToken }` (§7.3); on `done`, write
     `asms.push.token`. The token is **never logged** (`pushToken` is a dropped key in the scrubber).
  5. `addPushTokenListener` → step 3 again on refresh.
- A notification's data is `{ type, subjectType, subjectId, messageId }` plus title and body
  (R173). `routeForNotification(data)` is pure, table-tested, and returns the inbox item route
  `/inbox/[messageId]` for every known `subjectType` in slice 15 (the inbox screen is 16a; until it
  exists the registry falls back to `home`). Slice 16 refines: `register_deadline` → `/today`,
  `teacher_assignment` → `/classes`, `diary_entry`/`remark`/`attendance_alert` → the child's screen
  resolved through the inbox item's `viaStudents`. Unknown or malformed data → `home`. Cold-start
  taps use `getLastNotificationResponseAsync()` once.
- Foreground display: notifications are shown as banners while the app is open (no sound), never
  persisted on the device beyond the OS tray; the inbox (16) is the record.

---

## 9. Data cost (R160, R166)

Rules, each enforced or tested:

1. **No image in any list.** Lists carry `hasAttachment` only; a thumbnail loads on tap through the
   `/thumbnail` endpoints with `expo-image` (`cachePolicy: 'disk'`), the original on a second tap.
   Lint: `expo-image` importable only from `src/ui/Attachment.tsx` (16a) and nothing in 15 renders
   remote images.
2. **No prefetch, no polling, no background fetch.** TanStack `refetchInterval` is lint-banned;
   `staleTime` 5 min; `GET /me` runs at sign-in, cold start and after a change-password, not on
   every screen.
3. **Lists ask for `limit=25`** (the default) and page on demand; never `limit=50` on mobile except
   dropdown-style pickers (16b's reduced audience picker).
4. **Compression at the edge** is a deployment requirement already recorded (gzip for
   `application/json` at the proxy, WORKLOG "Deployment requirements").
5. **The scripted-day test** (`__tests__/scripted-day.spec.ts`): a fetch spy serves recorded fixtures
   (captured once from the dev API by `scripts/capture-fixtures.ts` and committed; real sizes) for
   sign-in, `GET /me`, three register reads and submits, one diary entry, an inbox refresh, with
   15's subset (sign-in, `/me`, calendar, devices) running now and 16 extending it. It asserts the
   request count ≤ 60 (R166: 120/min, 2,000/h per user) and the byte sum (request bodies +
   response bodies + 300 B per request for headers) **< 50 KB excluding images**, and that no
   request path ends in `/thumbnail` or `/attachment`.

---

## 10. Log hygiene (R155, R16 with the phone pattern)

- `src/platform/log.ts` is the **only** module allowed to call `console.*` (lint `no-console`
  elsewhere, no inline disables honoured — the API's rule). It takes `(level, event, fields)`;
  every field value passes `scrub()` before it is written anywhere.
- `scrub.ts` replaces: an identity number (13 consecutive digits, or `#####-#######-#`) → `[id]`;
  a phone (`(\+?92|0)3\d{2}[\s-]?\d{7}`) → `[phone]`; a 43-character base64url run
  (`[A-Za-z0-9_-]{43}`) → `[token]`; and **drops** the keys `password`, `currentPassword`,
  `newPassword`, `token`, `bearerToken`, `pushToken`, `authorization`, `username`, `body`,
  `text` outright. Errors are logged by `name`, `code`, `status` and a scrubbed `message`, never
  as whole objects (the API's `failureLog` rule).
- The sink is a **ring buffer of the last 200 lines** in memory, shown on Account → Diagnostics
  with a "copy" button, and `console` in development builds only (release builds write no device
  log). No remote crash reporter in Phase 2 (a decision not taken; if added later, it goes behind
  `log.ts` with the same scrubber and is recorded in `CLAUDE.md`).
- Tests: the scrubber over a fixture set (every pattern, nested objects, arrays, URLs); the
  sign-in and 401 flows run against a fake API and the whole ring buffer is matched against the
  R16 identity regex and the phone regex (must not match); a lint fixture test plants a
  `console.log` outside `log.ts` and a bare `fetch` outside `client.ts` and asserts both fail.

---

## 11. The update screen (`426`) and the other full-screen states

- Any `426` (login included) sets the session state `blocked`: the router shows **only**
  `update-required` — title "Update ASMS", one sentence from the server's message, the
  `details.minimumVersion` and the installed version, a primary button "Update" opening the Play
  listing (`market://details?id=<applicationId>`, falling back to the https Play URL), a secondary
  "Check again" that repeats `GET /me`. Nothing else renders and the outbox is `blocked` (§7.4)
  until a request succeeds. Maestro flow `update-required.yaml` runs the API with
  `MOBILE_MIN_APP_VERSION=99.0.0` and asserts the screen.
- `no-access`: "Your account has no access to the app. Ask the office." → sign-out on dismiss.
- Offline cold start with no cache: "Cannot reach `<school name if known>`. Check your connection."
  with retry.
- Every screen in the app has the four states at 360 px width (loading, empty, error, no
  permission) plus the offline notice ("as of 09:32" in school time from `server_time`), mirroring
  `apps/web/components/page-states.tsx` in `src/ui/states.tsx`.

---

## 12. Theme tokens — the web's palette, in React Native terms

The web is shadcn's neutral scale with a blue primary, expressed in `oklch` (`apps/web/app/globals.css`).
React Native takes sRGB hex; the conversions below are the normative mobile values (light only).

| Token | Web (`oklch`) | Mobile hex | Use |
|---|---|---|---|
| `background` | `1 0 0` | `#FFFFFF` | screens |
| `foreground` | `0.145 0 0` | `#0A0A0A` | body text |
| `card` / `popover` | `1 0 0` | `#FFFFFF` | cards, sheets |
| `muted` / `secondary` / `accent` | `0.97 0 0` | `#F5F5F5` | chips, list separators' background |
| `mutedForeground` | `0.556 0 0` | `#737373` | secondary text, "as of" |
| `secondaryForeground` | `0.205 0 0` | `#171717` | |
| `border` / `input` | `0.922 0 0` | `#E5E5E5` | 1 px hairlines, field borders |
| `primary` | `0.48 0.15 258` | `#1D5AB0` | the one accent: primary button, active tab, links |
| `primaryForeground` | `0.985 0 0` | `#FAFAFA` | text on primary |
| `ring` | `0.62 0.12 258` | `#5787CE` | focus outline |
| `destructive` | `0.577 0.245 27.325` | `#E7000B` | destructive actions, "not saved" |
| `radius` | `0.625rem` | `10` (dp) | cards, buttons, fields |

Also normative: spacing on a 4-dp scale (`4, 8, 12, 16, 24, 32`); type scale `12 / 14 / 16 / 18 /
22` dp with the system font (Roboto on Android — the web's Geist is not bundled; one typeface, no
decorative weights); **minimum tap target 48 × 48 dp** (a corridor, one hand); status colours for
attendance appear in slice 16 and are added to `theme.ts` then, not improvised per screen. No
gradients, no illustrations, no animation beyond the platform's navigation transitions (Design
rules). Dark mode is not shipped; the token file is shaped so a dark set is additive.

---

## 13. Testing

### 13.1 Jest + React Native Testing Library (the pure and near-pure parts)

| Suite | Proves |
|---|---|
| `outbox/machine.spec.ts` | every row of §7.4 as a table: `401` pause, `403/404/409/422` terminal with the message, `426` block, `429` with and without `Retry-After`, network backoff sequence (fake timers), crash recovery of stale `sending`, discard, remedy creating a new row |
| `outbox/coalesce.spec.ts` | two writes to one natural key with a `pending` row → one row, marks merged latest-wins, reason kept; a write while `sending` → a second `pending` row; the partial unique index refuses a duplicate `pending` (run against a real `expo-sqlite` in-memory database under `jest-expo`, or `better-sqlite3` behind the same repository interface if the native module cannot load in Jest — the choice is recorded) |
| `outbox/worker.spec.ts` | lanes independent: a failing `diary_attachment` item never delays `submit_register`; one in flight per lane; triggers (foreground, online, sign-in) each cause exactly one tick |
| `auth/tabs.spec.ts` | the §5 table, every fixture, order and the five-slot rule |
| `auth/session.spec.tsx` (RNTL) | sign-in writes the secure store and cache; 401 → sign-in screen, caches gone, `pending` rows per §7.6; sign-out → §4.6 wipe assertions; change-password replaces the token before `me` updates; the old token is presented on re-login |
| `api/client.spec.ts` | every request carries `X-App-Version` and `Accept`, bearer when signed in, never `Origin` or cookies; `Idempotency-Key` equals the outbox id on header lanes; the `426` and `401` middlewares fire |
| `push/registration.spec.ts` | no Firebase → skipped and logged, no throw, no outbox row; permission denied → skipped; token refresh → one `device_register` row; same token → nothing |
| `push/routing.spec.ts` | the §8 route table and the malformed-payload fallback |
| `platform/scrub.spec.ts`, `log.spec.ts` | §10 |
| `platform/crypto.spec.ts` | `newIdempotencyKey()` under the polyfill |
| `db/cache.spec.ts` | key canonicalisation (param order), "as of" from the `Date` header, device-time flag, eviction |
| `ui/states.spec.tsx` (RNTL) | the four states and the offline notice render their text; `OfflineNotice` shows school-time "as of" |
| `__tests__/scripted-day.spec.ts` | §9 |
| `__tests__/boundaries.spec.ts` | lint fixtures: forbidden imports (`expo-secure-store`, `expo-sqlite`, `expo-notifications`, `openapi-fetch`, `@react-native-async-storage/async-storage`, `@asms/shared/dist`), `console` outside `log.ts`, `fetch` outside `client.ts`, `refetchInterval` |
| `__tests__/shared-has-no-react.spec.ts` | `packages/shared/package.json` declares no `react*` dependency |

### 13.2 Build-level checks that run without a device

`pnpm --filter @asms/mobile exec expo export --platform android` (Metro resolves everything,
including `@asms/shared`), `expo-doctor`, `expo config --type public` (asserts the https guard by
running it once with a non-https URL under a release profile and expecting a failure).

### 13.3 Maestro flows — written in slice 15, **CI-only**

No Android emulator is guaranteed on the development machine (§15), so the flows are authored
and committed in 15 but proven only by the CI job below. Element selection is by `testID`
(`screen.element`, for example `signIn.schoolCode`, `tabs.home`, `account.signOut`).

| Flow | Steps | Asserts |
|---|---|---|
| `sign-in-shell-sign-out.yaml` | launch; school code, identity number, password of the seeded principal; sign in | Home visible with the school's name; Calendar tab opens and shows "as of"; Account → sign out → sign-in screen with the school code remembered |
| `update-required.yaml` | the API runs with `MOBILE_MIN_APP_VERSION=99.0.0`; launch; attempt sign-in | the update screen, the minimum version text, no tab bar |
| (16) `register-offline.yaml` | airplane mode via `adb`, mark, reconnect | the server has it; written in 16 |

**CI job `mobile` in `.github/workflows/ci.yml`** (a second job beside `ci`; the services and
`.env` steps are duplicated from `ci` on purpose — YAML, not code — and may be factored into a
composite action later):

| Step | Detail |
|---|---|
| Checkout, pnpm, Node 24, install | as `ci` |
| Build shared | `pnpm --filter @asms/shared build` |
| Lint, typecheck, unit tests | `pnpm --filter @asms/mobile lint typecheck test` — **these also run in the main `ci` job through `pnpm -r`**, so the fast checks never wait on the emulator |
| Bundle check | `expo export --platform android` |
| Services | Postgres and Redis service containers, CI `.env` as `ci`, test database, migrate, `MOBILE_MIN_APP_VERSION=0.0.0` |
| Seed | `pnpm --filter @asms/api seed:platform-admin`, then `pnpm --filter @asms/api seed:dev-school` — a **new idempotent script** `apps/api/scripts/seed-dev-school.ts` that creates one school (`demo`) with one principal from `DEV_SCHOOL_PRINCIPAL_CNIC` and prints `created` or `exists`, reusing the API's own services (not HTTP); it replaces the README's manual "First school and principal" steps for developers too |
| Start the API | `pnpm --filter @asms/api build && node apps/api/dist/main.js &`, wait for `/health` |
| Java and Android | `actions/setup-java@v4` (Temurin 17), `android-actions/setup-android@v3`, Gradle cache |
| Prebuild and build | `expo prebuild --platform android --no-install`, release-manifest cleartext grep (§2.6), `./gradlew assembleDebug` with `EXPO_PUBLIC_API_URL=http://10.0.2.2:3001`, `EXPO_PUBLIC_PUSH_ENABLED=false` |
| Emulator | `reactivecircus/android-emulator-runner@v2`: API 34, `google_apis`, `x86_64`, `-no-window -gpu swiftshader_indirect -noaudio -no-boot-anim`, AVD snapshot cached by key |
| Install and run | `adb install` the debug APK; `curl -Ls https://get.maestro.mobile.dev | bash` pinned by `MAESTRO_VERSION`; `maestro test maestro/flows/sign-in-shell-sign-out.yaml`; restart the API with `MOBILE_MIN_APP_VERSION=99.0.0`; `maestro test maestro/flows/update-required.yaml` |
| Artefacts on failure | Maestro screenshots and the API log, 7 days |
| Budget | `timeout-minutes: 45`; the emulator stage is expected at 12–20 min |

### 13.4 What must pass locally before a commit (no Android SDK required)

`pnpm --filter @asms/shared build` · `pnpm --filter @asms/mobile lint` · `typecheck` · `test` ·
`expo export --platform android` · `expo-doctor` · the hook dry run. With a device or emulator
present, additionally `expo run:android` to a signed-in Home screen. The Maestro flows are **not** a
local gate.

---

## 14. Build sequence (half-day tasks; each is demonstrable)

**15.1 — Project, versions, client (1 day)**
Goal: an Expo dev-client project in the monorepo that bundles with the shared package and the
generated client. Requirements: §2. Dependencies: none open. Tasks: create the package with the
pinned SDK and record versions in WORKLOG; tsconfig extending both bases; eslint boundaries (§11)
with the fixture test; the crypto polyfill and its test; `api:generate` and the CI staleness path;
the two `packages/shared` moves with web shims (main thread); `client.ts` with headers and the
`401`/`426` middlewares and its test; theme tokens and `states.tsx`; `app.config.ts` with the
https guard and the optional Firebase file; `eas.json`. Expected result: `expo export` bundles;
`pnpm -r lint typecheck test` green with the mobile package included; web unchanged (Playwright
green). Tests: `api/client.spec.ts`, `platform/crypto.spec.ts`, `__tests__/boundaries.spec.ts`,
`shared-has-no-react`. Acceptance: **pass** if a developer with no Android SDK can run every §13.4
check green from a fresh clone; **fail** otherwise or if any web file other than the two shims changed.

**15.2 — Sign-in, secure store, shell, update screen (1.5 days)**
Goal: sign in on a phone and see a role-aware shell. Requirements: 15.1. Tasks: `session-store.ts`;
sign-in screen and `sign-in.ts` (§4.2); the startup gate (§4.1); `composeTabs` and the registry;
Home (name, school, default-password banner, "as of"), Calendar (`GET /me/calendar`, month,
cached), Account (change password, sign out, revoke-others); `no-access`; `update-required`.
Expected result: login → shell → sign-out works against the dev API; a `426` shows only the update
screen. Tests: `auth/tabs.spec.ts`, `auth/session.spec.tsx`, `ui/states.spec.tsx`; Maestro flows
authored. Acceptance: **pass** if every §5 fixture produces the stated tabs, sign-out leaves only
the two remembered keys and no database file, and the two Maestro flows are committed and
syntactically valid (`maestro test --dry-run` is not available; the CI job is the proof).

**15.3 — Database, cache, outbox, sync sheet (1.5 days)**
Goal: reads survive airplane mode and a queued write reaches the server when the signal returns.
Requirements: 15.2. Tasks: `database.ts` with migrations and wipe; `cache.ts` wired into the query
client (hydration, "as of"); lane table; pure machine; worker with triggers; coalescing rule and
tests (the merge body is a function slice 16 fills for registers; 15 implements it for a generic
`marks[]` shape and tests it); connectivity; sync sheet; the §7.6 rule as written, flagged in the
review request. Expected result: with the API stopped, Calendar shows cached data with "as of" and
the sheet shows the `device_register` item as "Saved on device, retrying"; starting the API makes
it `done` within one backoff step. Tests: `outbox/*.spec.ts`, `db/cache.spec.ts`. Acceptance:
**pass** if every §7.4 row has a passing named test and the airplane-mode demonstration above is
recorded (screen recording or Maestro in 16).

**15.4 — Push registration and notification routing (0.5 day)**
Goal: a build without Firebase runs clean; a build with it registers a device. Requirements: 15.3.
Tasks: §8. Expected result: in the current (no-Firebase) build, one `push.skipped` log line and no
outbox row; with the owner's `google-services.json` supplied locally, a `devices` row appears on the
server. Tests: `push/*.spec.ts`. Acceptance: **pass** if the no-Firebase path is proven by test and
the with-Firebase path is either demonstrated on a device or explicitly recorded as "not yet
provable: no Firebase project" in WORKLOG.

**15.5 — Data cost and log hygiene (0.5 day)**
Goal: R160 and R155 are tests. Tasks: fixture capture script, scripted-day test (15's subset),
scrubber, ring buffer, diagnostics screen, the R16 scan over the buffer. Acceptance: **pass** if the
scripted-day assertions hold and the scan over a full fake-API session finds no identity, phone or
token pattern.

**15.6 — CI job and review (0.5 day + review)**
Goal: the emulator proof runs where an emulator exists. Tasks: `seed-dev-school.ts` (main thread
or the named agent); the `mobile` job (§13.3); README section "Mobile app" (dev build, `adb
reverse`, the SDK requirement, the no-Firebase state). Then the wave-E review: `security-reviewer`
(secure store, wipe, §7.6, headers, cleartext, logs), the combined correctness-and-quality review,
`test-engineer` coverage of R153 (client side), R155–R162 (15's parts), R166 (request count).
Acceptance: **pass** if the `mobile` CI job is green on the wave-E commit and every review finding
of high or critical severity is fixed with a proving test.

Phase gate for the slice: implemented → tested → security-reviewed → audited → no critical bug,
per `CLAUDE.md`; a FAIL at any step returns the slice.

---

## 15. Blockers and environment findings (this machine, 2026-10-04)

1. **Android SDK and JDK are not installed here, as far as the filesystem shows.** Checked: no
   `C:\Users\mrk\AppData\Local\Android` (the default SDK location), no `C:\Users\mrk\.android`
   (created by any `adb`/emulator run), no `C:\Program Files\Android` (Android Studio), no JDK
   under `C:\Program Files\Java`, `Eclipse Adoptium` or `Microsoft`; no Maestro (`~/.maestro`).
   `ANDROID_HOME`/`adb` on `PATH` could not be read (no shell in this run) — **the caller should
   confirm with `adb version` and `echo $env:ANDROID_HOME`**. Consequences: `expo run:android`, a
   local emulator and local Maestro are impossible until one of: (a) Android Studio (SDK, emulator,
   JDK; ~10 GB), (b) command-line tools + platform-tools + one system image + Temurin 17 (smaller),
   or (c) a physical Android phone with USB debugging and `platform-tools` only, plus EAS Build for
   the APK. Recommendation: (c) for day one, (b) when an emulator is wanted. Everything in §13.4
   runs without any of them.
2. **No Firebase project yet** → push registration is skipped and logged in every build; R159's
   device registration is proven by unit test and by the outbox, not by a real device row, until
   the owner supplies `google-services.json` (§8).
3. **`applicationId` is an owner decision** before the first Play upload (§1). Not blocking the dev
   build.
4. **No Expo (EAS) account and no Play developer account yet** → no cloud build, no internal track;
   local `expo run:android` needs item 1.
5. **§7.6 pause-versus-wipe** needs the security reviewer's confirmation in the wave-E review; it
   does not block 15.
6. **pnpm isolated linker with Expo** is verified on day one with a stated fallback (§2.3).
7. **Shared-file edits** this slice makes (`packages/shared` moves, web shims, CI job, API seed
   script) are main-thread edits under the wave process; the slice-15 agent must not edit them
   unilaterally while slices 11–13 run.
8. **Inbox list moved to 16** (§0); the plan's slice 15 text should be amended by `docs-maintainer`
   at slice 17 together with the other Phase 2 corrections.

---

## 16. What slice 16 builds on top (and must not rebuild)

- `composeTabs` and `SCREEN_REGISTRY`: 16 adds route folders and registers tab ids; it never adds
  conditions outside `tabs.ts`.
- The lane table and the pure machine: 16 adds `submit_register`, `diary_entry`, `remark`,
  `diary_attachment` rows and the register merge body in `coalesce.ts`; no second queue.
- The cache: 16's lists hydrate from it with "as of"; children's cards, registers and rosters are
  cache keys, not new tables. Domain tables for offline registers (`local_registers`,
  `local_marks`) are added by 16 with `domain_table/domain_id` linking to the outbox row.
- `routeForNotification`: 16 extends the table.
- `states.tsx`, theme tokens, `Screen`, `ListRow`, `Sheet`: every 16 screen is built from them;
  attendance status colours are added to `theme.ts` once.
- The scripted-day test: 16 adds the register, diary and inbox legs and keeps the 50 KB budget.
- The Maestro job: 16 adds `register-offline.yaml` (airplane mode via `adb shell`) and the
  parent and principal flows to the same job.
- The §7.6 answer, whichever it is.

---

## Decisions made here

1. The inbox list leaves slice 15 (its endpoint is wave F); `GET /me/calendar` is 15's read screen.
2. Device registration is 15's outbox lane, so the machine ships with a real consumer.
3. Expo SDK 55 is the floor; a newer stable SDK is accepted on day one under the §2.2 conditions;
   every Expo module is installed by `expo install`; non-Expo libraries match the monorepo's pins.
4. The generated client is reproduced per app from the one OpenAPI document and CI diffs both
   copies; the hand-written error and format helpers move to `@asms/shared` with web re-export
   shims — no new package until a third consumer exists.
5. `crypto.randomUUID` is polyfilled from `expo-crypto` before anything imports `@asms/shared`.
6. The remembered username (an identity number) lives in the secure store only, masked on screen,
   with a "forget me" control; the password is never stored; `AsyncStorage` is not installed.
7. Coalescing is enforced by a partial unique index on `pending` rows; a write during `sending`
   starts a new pending row rather than touching the in-flight one.
8. Network failures never give up (backoff tops out at 30 minutes); `403/404/409/422` are terminal
   with the server's message and a per-lane remedy; `401` pauses; `426` blocks.
9. On `401`, read caches are wiped and the token discarded at once; **pending writes survive for the
   same user only** — proposed, pending the security reviewer (§7.6), with the strict wipe as the
   stated fallback.
10. Foreground-only sync; no background tasks; no polling; no images before a tap.
11. The native FCM token is registered (not an Expo push token); a build without
    `google-services.json` skips registration and logs it.
12. Light theme only; hex conversions of the web's `oklch` tokens are the normative values; system
    font; 48 dp tap targets.
13. Maestro flows are CI-only; the `mobile` CI job owns the emulator; fast mobile checks also run
    in the main job through `pnpm -r`.
14. A new idempotent `seed-dev-school.ts` in the API gives CI (and developers) a school and a
    principal without the manual platform-console steps.
15. The Android `applicationId` is the owner's; the recommendation and the `.dev` suffix rule are
    recorded, and the first Play upload waits on the answer.
