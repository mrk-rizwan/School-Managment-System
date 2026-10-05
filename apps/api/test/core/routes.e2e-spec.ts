// Route and OpenAPI hygiene over the REAL application (no test-only modules): the R68 table of
// every route's guard with its argument (route-guards.ts, slice 17), the R68 snapshot of routes
// that need no capability, the §3.9 rule that every operation documents the error
// envelope, R66 (every id in the document is a string) and the R57 audit classification of
// every state-changing route.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RequestMethod, Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { OpenAPIObject } from '@nestjs/swagger';
import { Client } from 'pg';
import {
  AuthenticatedOnly,
  PlatformSession,
  Public,
  RequireCapability,
  RequireCapacity,
  RequireStaff,
  Webhook,
} from '../../src/common/auth/route-access';
import { Capability } from '@asms/shared';
import { API_PREFIX } from '../../src/common/http';
import { buildOpenApiDocuments } from '../../src/openapi-documents';
import { PlatformModule } from '../../src/modules/platform/platform.module';
import { createTestApp } from './app';
import { byPathThenMethod, ROUTE_GUARDS } from './route-guards';

type Access =
  | 'public'
  | 'authenticated-only'
  | 'capability'
  | 'platform-session'
  | 'staff'
  | 'capacity'
  | 'webhook';
interface Route {
  method: string;
  path: string;
  access: Access[];
  /** The declared guard with its argument: capabilities, capacity, provider or platform level. */
  guard: string;
  handler: string;
  /** The @PlatformSession level, if declared. */
  level: string | undefined;
  /** Whether the controller belongs to PlatformModule's module tree. */
  inPlatformModule: boolean;
}

// The metadata keys are private to route-access.ts. Rather than restating the strings here,
// each decorator is applied to a throwaway class and the key it writes is read back, so a
// renamed key cannot make this test silently look for the wrong thing.
function keyOf(decorator: ClassDecorator): string {
  class Probe {}
  decorator(Probe);
  const [key] = Reflect.getMetadataKeys(Probe) as unknown[];
  if (typeof key !== 'string') throw new Error('decorator wrote no string metadata key');
  return key;
}
const ACCESS_KEYS: [Access, string][] = [
  ['public', keyOf(Public())],
  ['authenticated-only', keyOf(AuthenticatedOnly())],
  ['capability', keyOf(RequireCapability(Capability.STUDENT_VIEW))],
  ['platform-session', keyOf(PlatformSession())],
  ['staff', keyOf(RequireStaff())],
  ['capacity', keyOf(RequireCapacity('guardian'))],
  ['webhook', keyOf(Webhook('waha'))],
];
const PLATFORM_KEY = keyOf(PlatformSession());

/**
 * A guard as the R68 table records it: the decorator and what it was given. @RequireCapability's
 * list is ANY-of and kept in its declared order; @RequireCapacity names the capacity, @Webhook the
 * provider, @PlatformSession the level. The flag decorators are their label alone.
 */
function guardText(label: Access, value: unknown): string {
  if (Array.isArray(value)) return `${label}: ${value.map(String).join(' | ')}`;
  if (typeof value === 'string') return `${label}: ${value}`;
  return label;
}

/** PlatformModule and every module it imports, recursively. */
function platformModuleTree(): Set<unknown> {
  const found = new Set<unknown>();
  const visit = (module: unknown): void => {
    if (typeof module !== 'function' || found.has(module)) return;
    found.add(module);
    const imports: unknown = Reflect.getMetadata(MODULE_METADATA.IMPORTS, module);
    if (Array.isArray(imports)) imports.forEach(visit);
  };
  visit(PlatformModule);
  return found;
}

const joinPath = (...parts: string[]): string =>
  '/' +
  parts
    .flatMap((p) => p.split('/'))
    .filter((p) => p.length > 0)
    .join('/');

const asArray = (value: string | string[] | undefined): string[] =>
  value === undefined ? [''] : Array.isArray(value) ? value : [value];

/**
 * Every route Nest registered, with the access decorators on its handler or controller.
 *
 * Enumeration walks Nest's own module graph (ModulesContainer, each module's controllers, their
 * methods via MetadataScanner, the @Get/@Post metadata on each) because only there is the
 * handler function available, and the access decorators live on the handler and its class. The
 * Express router alone has paths but not handlers. The path is rebuilt as global prefix +
 * controller path + method path; a second test checks that rebuilt set against the Express
 * router stack, so a route the walk misses or mis-paths (versioning, prefix exclusions, a route
 * registered outside a controller) fails the suite rather than escaping the snapshot.
 */
function nestRoutes(app: NestExpressApplication): Route[] {
  const reflector = new Reflector();
  const scanner = new MetadataScanner();
  const routes: Route[] = [];
  const platformTree = platformModuleTree();
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as Type | null;
      if (!controller) continue;
      const controllerPaths = asArray(
        reflector.get<string | string[] | undefined>(PATH_METADATA, controller),
      );
      const proto = controller.prototype as Record<string, unknown>;
      for (const name of scanner.getAllMethodNames(proto)) {
        const handler = proto[name];
        if (typeof handler !== 'function') continue;
        const method = reflector.get<RequestMethod | undefined>(METHOD_METADATA, handler);
        const methodPaths = reflector.get<string | string[] | undefined>(PATH_METADATA, handler);
        if (method === undefined || methodPaths === undefined) continue;
        const declared = ACCESS_KEYS.flatMap(([label, key]): [Access, unknown][] => {
          const value = reflector.getAllAndOverride<unknown>(key, [handler, controller]);
          return value === undefined ? [] : [[label, value]];
        });
        const access = declared.map(([label]) => label);
        const guard = declared.map(([label, value]) => guardText(label, value)).join(' + ');
        for (const c of controllerPaths) {
          for (const m of asArray(methodPaths)) {
            routes.push({
              method: RequestMethod[method],
              path: joinPath(API_PREFIX, c, m),
              access,
              guard,
              handler: `${controller.name}.${name}`,
              level: reflector.getAllAndOverride<string | undefined>(PLATFORM_KEY, [handler, controller]),
              inPlatformModule: platformTree.has(module.metatype),
            });
          }
        }
      }
    }
  }
  return routes;
}

interface ExpressLayer {
  route?: { path: string | string[]; methods: Record<string, boolean> };
}

// Nest's own catch-all under the global prefix (the not-found handler and the error relay),
// registered with router.all for every method. It serves no controller and is the one route
// layer the comparison below ignores, by exact path.
const NEST_CATCH_ALL = `/${API_PREFIX}{/*splat}`;

/** What Express actually serves: "METHOD path" for every route layer on the app router. */
function expressRoutes(app: NestExpressApplication): string[] {
  const stack = app.getHttpAdapter().getInstance().router.stack as ExpressLayer[];
  return stack.flatMap(({ route }) =>
    route === undefined || route.path === NEST_CATCH_ALL
      ? []
      : Object.keys(route.methods).flatMap((method) =>
          (Array.isArray(route.path) ? route.path : [route.path]).map(
            (path) => `${method === '_all' ? 'ALL' : method.toUpperCase()} ${path}`,
          ),
        ),
  );
}

// R68 snapshot: every route reachable without a capability. Adding an entry here is a
// reviewed change: a new @Public(), @AuthenticatedOnly() or @RequireStaff() route widens what an
// anonymous caller, any signed-in user or any staff member can reach, and must be agreed in
// review, not just appended (contract slice-2 §1).
const NO_CAPABILITY_ROUTES: [string, string, Access][] = [
  ['GET', '/api/v1/academic-years', 'staff'],
  ['GET', '/api/v1/academic-years/:id', 'staff'],
  ['POST', '/api/v1/auth/forgot-password', 'public'],
  ['POST', '/api/v1/auth/login', 'public'],
  ['POST', '/api/v1/auth/logout', 'authenticated-only'],
  ['POST', '/api/v1/auth/reset-password', 'public'],
  ['POST', '/api/v1/auth/verify-email', 'public'],
  ['GET', '/api/v1/calendar/teaching-days', 'staff'],
  ['GET', '/api/v1/classes', 'staff'],
  ['GET', '/api/v1/classes/:id', 'staff'],
  ['GET', '/api/v1/classes/:id/sections', 'staff'],
  ['GET', '/api/v1/health', 'public'],
  ['GET', '/api/v1/holidays', 'staff'],
  ['GET', '/api/v1/holidays/:id', 'staff'],
  ['GET', '/api/v1/me', 'authenticated-only'],
  ['GET', '/api/v1/me/calendar', 'authenticated-only'],
  ['POST', '/api/v1/me/change-email', 'authenticated-only'],
  ['POST', '/api/v1/me/change-password', 'authenticated-only'],
  // contracts/slice-11.md §1.1, §1.4 (R130): a guardian's child's attendance, capacity scope.
  ['GET', '/api/v1/me/children/:id/attendance', 'capacity'],
  // contracts/slice-13.md §1.1, §1.2 (R163): a guardian's child, by the capacity scope.
  ['GET', '/api/v1/me/children/:id/diary-entries', 'capacity'],
  ['GET', '/api/v1/me/children/:id/diary-entries/:entryId/attachment', 'capacity'],
  ['GET', '/api/v1/me/children/:id/diary-entries/:entryId/thumbnail', 'capacity'],
  ['GET', '/api/v1/me/children/:id/remarks', 'capacity'],
  ['POST', '/api/v1/me/devices', 'authenticated-only'],
  // contracts/slice-14.md §7 (R166): any live session's own inbox, by person at read time.
  ['GET', '/api/v1/me/inbox', 'authenticated-only'],
  ['GET', '/api/v1/me/inbox/:id', 'authenticated-only'],
  ['GET', '/api/v1/me/inbox/:id/attachment', 'authenticated-only'],
  ['GET', '/api/v1/me/inbox/:id/thumbnail', 'authenticated-only'],
  // Phase 3 slice 18: where a guardian can pay.
  ['GET', '/api/v1/me/payment-accounts', 'capacity'],
  ['POST', '/api/v1/me/sessions/revoke-others', 'authenticated-only'],
  // contracts/slice-12.md §1 (R135): any active staff member reads their own attendance.
  ['GET', '/api/v1/me/staff/attendance', 'staff'],
  // contracts/slice-11.md §1.1: the student's own attendance.
  ['GET', '/api/v1/me/student/attendance', 'capacity'],
  // contracts/slice-13.md §1.1, §1.2: the student's own diary and remarks.
  ['GET', '/api/v1/me/student/diary-entries', 'capacity'],
  ['GET', '/api/v1/me/student/diary-entries/:entryId/attachment', 'capacity'],
  ['GET', '/api/v1/me/student/diary-entries/:entryId/thumbnail', 'capacity'],
  ['GET', '/api/v1/me/student/remarks', 'capacity'],
  ['POST', '/api/v1/platform/auth/login', 'public'],
  ['GET', '/api/v1/sections/:id', 'staff'],
  ['GET', '/api/v1/subjects', 'staff'],
  ['GET', '/api/v1/subjects/:id', 'staff'],
];

// Contract slice-1 §1: the platform auth routes and their @PlatformSession level. Reviewed like
// the snapshot above: an 'any' or 'password-change' route is reachable before the second factor
// or before the seeded password is changed.
const PLATFORM_AUTH_ROUTES: [string, string, string][] = [
  ['POST', '/api/v1/platform/auth/change-password', 'password-change'],
  ['POST', '/api/v1/platform/auth/logout', 'any'],
  ['POST', '/api/v1/platform/auth/totp/confirm', 'any'],
  ['POST', '/api/v1/platform/auth/totp/enrol', 'any'],
  ['GET', '/api/v1/platform/me', 'any'],
];
const PLATFORM_PREFIX = '/api/v1/platform/';

// R57 / plan §3.7: what every state-changing route writes to the audit trail. Each entry is
// either the audit actions the route records (audit_log, or platform_audit_log under
// /platform) or `none:` with the reason it records nothing. A new POST/PATCH/PUT/DELETE route
// fails the guard below until it is classified here, which is a reviewed change: "none" must
// be argued, not defaulted. Behaviour is proved per action in the suites (R57's own list in
// test/access/audit-trail.e2e-spec.ts).
type AuditClass = string[] | `none: ${string}`;
const MUTATION_AUDIT: Record<string, AuditClass> = {
  'POST /api/v1/academic-years': ['academic_year.created'],
  // contracts/slice-11.md §11. An identical replay is a 200 with no row.
  'POST /api/v1/attendance-arrivals': ['attendance_mark.arrival_recorded'],
  'POST /api/v1/attendance-marks/:id/amend': ['attendance_mark.amended'],
  'POST /api/v1/sections/:id/submit-register': ['attendance_register.submitted', 'attendance_register.amended'],
  'PATCH /api/v1/academic-years/:id': ['academic_year.updated'],
  'POST /api/v1/academic-years/:id/activate': ['academic_year.activated'],
  'POST /api/v1/academic-years/:id/close': ['academic_year.closed'],
  'POST /api/v1/admissions': ['guardian.created', 'student.admitted'],
  'POST /api/v1/auth/forgot-password': 'none: issues a reset token only; the account is unchanged until it is used',
  'POST /api/v1/auth/login': ['user.login_on_default_password', 'login_failure_spike'],
  'POST /api/v1/auth/logout': 'none: ends the caller own session only',
  'POST /api/v1/auth/reset-password': ['user.password_reset_by_token'],
  'POST /api/v1/auth/verify-email': ['user.email_verified'],
  'POST /api/v1/classes': ['class.created'],
  'PATCH /api/v1/classes/:id': ['class.updated'],
  'POST /api/v1/classes/:id/archive': ['class.archived'],
  'POST /api/v1/classes/:id/copy-sections': ['class.sections_copied'],
  'POST /api/v1/classes/:id/sections': ['section.created'],
  'POST /api/v1/custom-roles': ['custom_role.created'],
  'PATCH /api/v1/custom-roles/:id': ['custom_role.updated'],
  'POST /api/v1/custom-roles/:id/archive': ['custom_role.archived'],
  'PATCH /api/v1/enrolments/:id': ['enrolment.roll_no_set'],
  'POST /api/v1/enrolments/:id/change-class': ['enrolment.class_changed'],
  'POST /api/v1/enrolments/:id/change-section': ['enrolment.section_changed'],
  // contracts/slice-10.md §11. A repeated publish or cancel is an unchanged 200 with no row.
  'POST /api/v1/holidays': ['holiday.created'],
  'PATCH /api/v1/holidays/:id': ['holiday.updated'],
  'POST /api/v1/holidays/:id/cancel': ['holiday.cancelled'],
  'POST /api/v1/holidays/:id/publish': ['holiday.published'],
  'POST /api/v1/grants/:id/end': ['capability_grant.ended'],
  'PATCH /api/v1/guardian-links/:id': ['guardian_link.updated'],
  'POST /api/v1/guardian-links/:id/end': ['guardian_link.ended'],
  'POST /api/v1/guardians': ['guardian.created'],
  'PATCH /api/v1/guardians/:id': ['guardian.updated'],
  'POST /api/v1/guardians/:id/issue-login': ['user.login_issued'],
  'POST /api/v1/guardians/lookup': 'none: a read carried in a body so the CNIC stays out of the URL',
  'POST /api/v1/me/change-email': ['user.email_changed'],
  'POST /api/v1/me/change-password': ['user.password_changed'],
  'POST /api/v1/me/devices': 'none: a push address of the caller own session, refreshed often; grants nothing',
  'POST /api/v1/me/sessions/revoke-others': ['user.sessions_revoked'],
  // contracts/slice-9.md §5, §12.
  'POST /api/v1/messaging/test': ['messaging.test_sent'],
  'POST /api/v1/messaging/whatsapp/connect-cloud-api': ['whatsapp.cloud_api_connected'],
  'POST /api/v1/messaging/whatsapp/disable': ['whatsapp.disabled'],
  'POST /api/v1/messaging/whatsapp/pair': ['whatsapp.pairing_started'],
  'POST /api/v1/platform/auth/change-password': ['platform_user.password_changed'],
  'POST /api/v1/platform/auth/login': ['platform_user.login'],
  'POST /api/v1/platform/auth/logout': 'none: ends the caller own session only',
  'POST /api/v1/platform/auth/totp/confirm': ['platform_user.totp_enrolled'],
  'POST /api/v1/platform/auth/totp/enrol': 'none: a pending secret, inert until confirm (audited there)',
  'POST /api/v1/platform/schools': ['school.created'],
  'PATCH /api/v1/platform/schools/:id': ['school.updated'],
  'POST /api/v1/platform/schools/:id/change-status': ['school.status_changed'],
  'PATCH /api/v1/platform/settings': ['platform_settings.updated'],
  'POST /api/v1/platform/schools/:id/issue-principal-login': [
    'staff.created',
    'user.principal_login_issued',
    'school.principal_login_issued',
  ],
  'PATCH /api/v1/school/settings': ['school_settings.updated'],
  // Phase 3 slice 18 (phase-3-financial.md R230). A repeated archive or disable writes no row.
  'POST /api/v1/fee-heads': ['fee_head.created'],
  'PATCH /api/v1/fee-heads/:id': ['fee_head.updated'],
  'POST /api/v1/fee-heads/:id/archive': ['fee_head.archived'],
  'POST /api/v1/fee-structures': ['fee_structure.created'],
  'POST /api/v1/fee-structures/copy': ['fee_structure.copied'],
  'POST /api/v1/payment-accounts': ['payment_account.created'],
  'POST /api/v1/payment-accounts/:id/disable': ['payment_account.disabled'],
  'PATCH /api/v1/sections/:id': ['section.updated'],
  'POST /api/v1/sections/:id/archive': ['section.archived'],
  'POST /api/v1/staff': ['staff.created'],
  'PATCH /api/v1/staff/:id': ['staff.updated'],
  'POST /api/v1/staff/:id/change-status': ['staff.status_changed'],
  'POST /api/v1/staff/:id/issue-login': ['user.login_issued', 'user.reset_on_staff_link'],
  'POST /api/v1/staff/:id/teacher-assignments': ['teacher_assignment.created', 'teacher_assignment.ended'],
  // contracts/slice-12.md §6. An identical replay is a 200 with no row.
  'POST /api/v1/staff-attendance/submit': ['staff_attendance.recorded', 'staff_attendance.amended'],
  'POST /api/v1/staff-attendance/:id/amend': ['staff_attendance_mark.amended'],
  'POST /api/v1/students/:id/change-status': ['student.status_changed'],
  'POST /api/v1/students/:id/documents': ['document.added'],
  'POST /api/v1/students/:id/guardian-links': ['guardian_link.created'],
  'POST /api/v1/students/:id/issue-login': ['user.login_issued'],
  'POST /api/v1/students/:id/readmit': ['student.readmitted'],
  // contracts/slice-13.md §9. A replayed create and a no-op patch write no row.
  'POST /api/v1/sections/:id/diary-entries': ['diary_entry.created'],
  'PATCH /api/v1/diary-entries/:id': ['diary_entry.updated'],
  'POST /api/v1/students/:id/remarks': ['remark.created'],
  'POST /api/v1/remarks/:id/correct': ['remark.corrected'],
  // contracts/slice-14.md §10 (R152). A replayed create, a no-op patch and a retried send or
  // cancel write no row; the scheduled job is not audited (no actor).
  'POST /api/v1/announcements': ['announcement.created'],
  'PATCH /api/v1/announcements/:id': ['announcement.updated'],
  'POST /api/v1/announcements/:id/send': ['announcement.scheduled', 'announcement.sent'],
  'POST /api/v1/announcements/:id/cancel': ['announcement.cancelled'],
  'POST /api/v1/announcements/preview-audience': 'none: a read carried in a body; it writes nothing',
  'PATCH /api/v1/students/:id': ['student.updated'],
  'POST /api/v1/students/lookup': 'none: a read carried in a body so the B-Form stays out of the URL',
  'POST /api/v1/subjects': ['subject.created'],
  'PATCH /api/v1/subjects/:id': ['subject.updated'],
  'POST /api/v1/subjects/:id/archive': ['subject.archived'],
  'POST /api/v1/teacher-assignments/:id/end': ['teacher_assignment.ended'],
  'POST /api/v1/uploads': 'none: a staged upload is not a record; committing it is audited as document.added, diary_entry.created or announcement.created',
  'POST /api/v1/user-roles/:id/remove': ['user_role.removed'],
  'POST /api/v1/users/:id/disable': ['user.disabled'],
  'POST /api/v1/users/:id/enable': ['user.enabled'],
  'POST /api/v1/users/:id/grants': ['capability_grant.created'],
  'POST /api/v1/users/:id/reset-password': ['user.office_reset'],
  'POST /api/v1/users/:id/roles': ['user_role.assigned'],
  'POST /api/v1/users/:id/sign-out-everywhere': ['user.signed_out_everywhere'],
  // contracts/slice-9.md §8, §12: provider reports have no actor; counters only.
  'POST /api/v1/webhooks/meta': 'none: a provider report with no actor; it moves a delivery forward or counts an inbound message',
  'POST /api/v1/webhooks/waha': 'none: a provider report with no actor; it moves a delivery forward or triggers a health check',
};

/** Every .ts file under `root` that `keep` admits, generated code skipped. */
function tsFiles(root: string, keep: (path: string) => boolean): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'generated') walk(path);
      } else if (entry.name.endsWith('.ts') && keep(path)) {
        files.push(path);
      }
    }
  };
  walk(root);
  return files;
}

/** The text of every non-generated, non-test source file under src/. */
function sourceText(): string {
  return tsFiles(join(__dirname, '../../src'), (path) => !path.endsWith('.spec.ts'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
}

/** The text of each behavioural suite under test/ (this file and its tables excluded). */
function suiteTexts(): string[] {
  const tables = new Set([__filename, join(__dirname, 'route-guards.ts')]);
  return tsFiles(join(__dirname, '..'), (path) => /\.(e2e-)?spec\.ts$/.test(path) && !tables.has(path)).map(
    (file) => readFileSync(file, 'utf8'),
  );
}

/** The audit actions the reviewed table names, once each. */
const auditActions = (): string[] => [
  ...new Set(Object.values(MUTATION_AUDIT).flatMap((c) => (typeof c === 'string' ? [] : c))),
];

/**
 * Audit actions a route writes with no actor, and why (R57 asks for actor, target and reason):
 * the login-spray alarm counts anonymous failures across many usernames, so nobody is the actor.
 */
const ACTORLESS_ACTIONS: Record<string, string> = {
  login_failure_spike: 'anonymous failed logins in a burst, recorded by the alarm, not by a person',
};

const OPERATIONS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
const isObject = (v: Json | undefined): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isIdName = (name: string): boolean => name === 'id' || /Id$/.test(name);

/** Follows local $refs (#/components/...) to the schema they name. */
function resolve(doc: JsonObject, node: Json | undefined): Json | undefined {
  let current = node;
  for (let hops = 0; isObject(current) && typeof current.$ref === 'string' && hops < 10; hops++) {
    const ref: string = current.$ref;
    current = ref
      .replace(/^#\//, '')
      .split('/')
      .reduce<Json | undefined>((at, key) => (isObject(at) ? at[key] : undefined), doc);
  }
  return current;
}

/** type 'string', or 3.1's ['string', 'null']. Integer, number, an object $ref and untyped fail. */
function isStringSchema(doc: JsonObject, schema: Json | undefined): boolean {
  const s = resolve(doc, schema);
  if (!isObject(s)) return false;
  const t = s.type;
  if (t === 'string') return true;
  return Array.isArray(t) && t.includes('string') && t.every((x) => x === 'string' || x === 'null');
}

/**
 * Walks the whole document (components.schemas, inline schemas in request bodies and responses,
 * every parameter: path, query, header, component) and returns the JSON path of each id-named
 * property or parameter whose schema is not a string.
 */
function nonStringIds(doc: JsonObject): string[] {
  const offenders: string[] = [];
  const walk = (node: Json, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    if (!isObject(node)) return;
    if (isObject(node.properties)) {
      for (const [name, schema] of Object.entries(node.properties)) {
        if (isIdName(name) && !isStringSchema(doc, schema)) {
          offenders.push(`${path}.properties.${name}`);
        }
      }
    }
    if (typeof node.in === 'string' && typeof node.name === 'string' && isIdName(node.name)) {
      if (!isStringSchema(doc, node.schema)) offenders.push(`${path} (${node.in} ${node.name})`);
    }
    for (const [key, child] of Object.entries(node)) walk(child, `${path}.${key}`);
  };
  walk(doc, '$');
  return offenders;
}

describe('Routes and OpenAPI over the real AppModule', () => {
  let app: NestExpressApplication;
  let routes: Route[];
  let docs: [string, OpenAPIObject][];

  beforeAll(async () => {
    // No test-only modules: this is the route set that ships.
    app = await createTestApp();
    routes = nestRoutes(app);
    const { school, platform } = buildOpenApiDocuments(app);
    docs = [
      ['school', school],
      ['platform', platform],
    ];
  });

  afterAll(async () => {
    await app.close();
  });

  it('enumerates the health route (the walk is not vacuous)', () => {
    expect(routes.map((r) => `${r.method} ${r.path}`)).toContain('GET /api/v1/health');
  });

  it('the enumerated routes are exactly the ones Express serves', () => {
    const fromNest = routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(expressRoutes(app).sort()).toEqual(fromNest);
  });

  it('R57: every state-changing route is classified for audit in the reviewed table', () => {
    const mutating = routes
      .filter((r) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(r.method))
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(mutating.length).toBeGreaterThan(0);
    expect(mutating).toEqual(Object.keys(MUTATION_AUDIT).sort());
  });

  it('R57: every audit action the table names is written somewhere in src (the table is not stale)', () => {
    const text = sourceText();
    const missing = Object.values(MUTATION_AUDIT)
      .flatMap((c) => (typeof c === 'string' ? [] : c))
      .filter((action) => !text.includes(`'${action}'`));
    expect(missing).toEqual([]);
  });

  it('R57 (slice 17): every audit action the table names is read back by a behavioural suite', () => {
    // The table says what a route writes; a suite that drives the route and reads the row back is
    // what proves it. An action named here and read back by no suite is an unproved claim.
    const suites = suiteTexts();
    expect(suites.length).toBeGreaterThan(50);
    const unproved = auditActions().filter((action) => !suites.some((text) => text.includes(`'${action}'`)));
    expect(unproved.sort()).toEqual([]);
  });

  it('R57 (slice 17): every stored row of a route audit action names its actor and its subject', async () => {
    // Whole tables, every school any suite wrote (tests never truncate): a route that wrote its
    // row without the person who acted, or without what it acted on, is found here.
    const actions = auditActions();
    const checked = actions.filter((a) => !(a in ACTORLESS_ACTIONS));
    expect(Object.keys(ACTORLESS_ACTIONS).filter((a) => !actions.includes(a))).toEqual([]);
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    try {
      const school = await pg.query<{ action: string; rows: string }>(
        `SELECT action, count(*)::text AS rows FROM audit_log
          WHERE action = ANY($1)
            AND ((actor_user_id IS NULL AND actor_platform_user_id IS NULL) OR subject_id IS NULL)
          GROUP BY action`,
        [checked],
      );
      expect(school.rows).toEqual([]);
      const platform = await pg.query<{ action: string; rows: string }>(
        `SELECT action, count(*)::text AS rows FROM platform_audit_log
          WHERE action = ANY($1) AND (actor_platform_user_id IS NULL OR subject_id IS NULL)
          GROUP BY action`,
        [checked],
      );
      expect(platform.rows).toEqual([]);
      // Not vacuous: rows of these actions exist to be checked.
      const seen = await pg.query<{ n: string }>(
        `SELECT ((SELECT count(*) FROM audit_log WHERE action = ANY($1))
               + (SELECT count(*) FROM platform_audit_log WHERE action = ANY($1)))::text AS n`,
        [checked],
      );
      expect(Number(seen.rows[0]?.n)).toBeGreaterThan(0);
    } finally {
      await pg.end();
    }
  });

  it('R68: every route declares exactly one access decorator', () => {
    const wrong = routes
      .filter((r) => r.access.length !== 1)
      .map((r) => `${r.method} ${r.path} (${r.handler}): [${r.access.join(', ')}]`);
    expect(wrong).toEqual([]);
  });

  it('R68 (slice 17): every route guard, with its capabilities, capacity, provider or level, matches the reviewed table', () => {
    const actual = Object.fromEntries(
      routes
        .map((r): [string, string] => [`${r.method} ${r.path}`, r.guard])
        .sort(([a], [b]) => byPathThenMethod(a, b)),
    );
    if (process.env.PRINT_ROUTE_GUARDS) process.stdout.write(`${JSON.stringify(actual, null, 2)}
`);
    expect(actual).toEqual(ROUTE_GUARDS);
  });

  it('R68: the routes needing no capability match the reviewed snapshot', () => {
    const open = routes
      .flatMap(({ method, path, access: [only, ...more] }): [string, string, Access][] =>
        only !== undefined &&
        (only === 'public' ||
          only === 'authenticated-only' ||
          only === 'staff' ||
          only === 'capacity') &&
        more.length === 0
          ? [[method, path, only]]
          : [],
      )
      .sort((a, b) => `${a[1]} ${a[0]}`.localeCompare(`${b[1]} ${b[0]}`));
    expect(open).toEqual(NO_CAPABILITY_ROUTES);
  });

  it('R172: every @Webhook route lives under /webhooks/ and appears in no OpenAPI document', () => {
    const hooks = routes.filter((r) => r.access.includes('webhook'));
    expect(hooks.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /api/v1/webhooks/meta',
      'POST /api/v1/webhooks/meta',
      'POST /api/v1/webhooks/waha',
    ]);
    for (const [, doc] of docs) {
      expect(Object.keys(doc.paths).filter((path) => path.includes('webhooks'))).toEqual([]);
    }
    // §8.4: no SMS webhook is mounted while Sendpk is pull-only.
    expect(routes.some((r) => r.path.startsWith('/api/v1/webhooks/sms'))).toBe(false);
  });

  it('R80 lifted (contracts/slice-9.md §10 b): no source file under src references ErrorCode.SCHOOL_SUSPENDED, so no route answers it', () => {
    const text = sourceText();
    expect(text).not.toMatch(/ErrorCode\.SCHOOL_SUSPENDED/);
    expect(text).not.toMatch(/AllowWhenSuspended/);
  });

  it('R68, R163: every @RequireCapacity route lives under /me/ (the capacity tree names the capacity)', () => {
    const wrong = routes
      .filter((r) => r.access.includes('capacity'))
      .filter((r) => !r.path.startsWith('/api/v1/me/'))
      .map((r) => `${r.method} ${r.path}`);
    expect(wrong).toEqual([]);
  });

  it('R78: @AuthenticatedOnly and @RequireCapacity are only on /auth/logout and /me/*, so parent and student sessions reach nothing else', () => {
    const wrong = routes
      .filter((r) => r.access.includes('authenticated-only') || r.access.includes('capacity'))
      .filter((r) => !(r.path === '/api/v1/auth/logout' || r.path === '/api/v1/me' || r.path.startsWith('/api/v1/me/')))
      .map((r) => `${r.method} ${r.path}`);
    expect(wrong).toEqual([]);
  });

  it('R65: no GET route lives under an action path (no GET mutates)', () => {
    const wrong = routes
      .filter(
        (r) =>
          r.method === 'GET' &&
          /\/(login|logout|reset-password|verify-email|disable|enable|change-[a-z]+|issue-[a-z-]+)$/.test(r.path),
      )
      .map((r) => r.path);
    expect(wrong).toEqual([]);
  });

  it('R56: platform routes are exactly the PlatformModule routes, all under /platform', () => {
    const wrong = routes
      .filter((r) => r.inPlatformModule !== r.path.startsWith(PLATFORM_PREFIX))
      .map((r) => `${r.method} ${r.path} (${r.handler})`);
    expect(wrong).toEqual([]);
    expect(routes.some((r) => r.inPlatformModule)).toBe(true);
  });

  it('R56: every platform route is @PlatformSession or the one @Public login; nothing else uses @PlatformSession', () => {
    const wrong = routes
      .filter((r) => {
        const platformSession = r.access.includes('platform-session');
        if (!r.path.startsWith(PLATFORM_PREFIX)) return platformSession;
        const isLogin = r.method === 'POST' && r.path === '/api/v1/platform/auth/login';
        return isLogin ? r.access.join() !== 'public' : r.access.join() !== 'platform-session';
      })
      .map((r) => `${r.method} ${r.path} (${r.handler}): [${r.access.join(', ')}]`);
    expect(wrong).toEqual([]);
  });

  it('platform auth routes carry the reviewed levels; every other platform route is level full', () => {
    const platform = routes.filter((r) => r.access.includes('platform-session'));
    const auth = platform
      .filter((r) => r.path.startsWith('/api/v1/platform/auth/') || r.path === '/api/v1/platform/me')
      .map((r): [string, string, string] => [r.method, r.path, r.level ?? ''])
      .sort((a, b) => a[1].localeCompare(b[1]));
    expect(auth).toEqual(PLATFORM_AUTH_ROUTES);
    const notFull = platform
      .filter((r) => !auth.some(([m, p]) => m === r.method && p === r.path) && r.level !== 'full')
      .map((r) => `${r.method} ${r.path}: ${r.level}`);
    expect(notFull).toEqual([]);
  });

  it('OpenAPI: the platform document holds exactly the platform routes; the school document none', () => {
    const [[, school], [, platform]] = docs as [[string, OpenAPIObject], [string, OpenAPIObject]];
    expect(Object.keys(school.paths).filter((p) => p.startsWith(PLATFORM_PREFIX))).toEqual([]);
    const documented = Object.keys(platform.paths).map((p) => p.replace(/\{(\w+)\}/g, ':$1')).sort();
    const served = [...new Set(routes.filter((r) => r.inPlatformModule).map((r) => r.path))].sort();
    expect(documented).toEqual(served);
  });

  it('§3.9: every documented operation has a default response with the error envelope', () => {
    const missing: string[] = [];
    let operations = 0;
    for (const [name, doc] of docs) {
      for (const [path, item] of Object.entries(doc.paths)) {
        for (const verb of OPERATIONS) {
          const operation = item[verb];
          if (!operation) continue;
          operations++;
          const fallback = operation.responses.default;
          const schema =
            fallback && 'content' in fallback
              ? fallback.content?.['application/json']?.schema
              : undefined;
          if (
            !schema ||
            !('$ref' in schema) ||
            schema.$ref !== '#/components/schemas/ApiErrorDto'
          ) {
            missing.push(`${name}: ${verb.toUpperCase()} ${path}`);
          }
        }
      }
    }
    expect(operations).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it('R66: every id and *Id property or parameter in both documents is a string', () => {
    const offenders = docs.flatMap(([name, doc]) =>
      nonStringIds(JSON.parse(JSON.stringify(doc)) as JsonObject).map((p) => `${name}: ${p}`),
    );
    expect(offenders).toEqual([]);
  });

  it('R66: the walker reports integer, number and object-$ref ids wherever they sit', () => {
    const doc: JsonObject = {
      components: {
        schemas: {
          Ok: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              classId: { $ref: '#/components/schemas/Str' },
              guardianId: { type: ['string', 'null'] },
            },
          },
          Str: { type: 'string' },
          Obj: { type: 'object', properties: { id: { type: 'integer' } } },
        },
      },
      paths: {
        '/x': {
          get: {
            parameters: [{ in: 'query', name: 'sectionId', schema: { type: 'number' } }],
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { parentId: { $ref: '#/components/schemas/Obj' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    expect(nonStringIds(doc)).toEqual([
      '$.components.schemas.Obj.properties.id',
      '$.paths./x.get.parameters[0] (query sectionId)',
      '$.paths./x.get.responses.200.content.application/json.schema.properties.parentId',
    ]);
  });
});
