// Route and OpenAPI hygiene over the REAL application (no test-only modules): the R68 snapshot
// of routes that need no capability, the §3.9 rule that every operation documents the error
// envelope, and R66 (every id in the document is a string).
import { RequestMethod, Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { OpenAPIObject } from '@nestjs/swagger';
import { AuthenticatedOnly, Public, RequireCapability } from '../../src/common/auth/route-access';
import { API_PREFIX } from '../../src/common/http';
import { buildOpenApiDocuments } from '../../src/common/openapi';
import { createTestApp } from './app';

type Access = 'public' | 'authenticated-only' | 'capability';
interface Route {
  method: string;
  path: string;
  access: Access[];
  handler: string;
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
  ['capability', keyOf(RequireCapability('probe'))],
];

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
        const access = ACCESS_KEYS.filter(
          ([, key]) =>
            reflector.getAllAndOverride<unknown>(key, [handler, controller]) !== undefined,
        ).map(([label]) => label);
        for (const c of controllerPaths) {
          for (const m of asArray(methodPaths)) {
            routes.push({
              method: RequestMethod[method],
              path: joinPath(API_PREFIX, c, m),
              access,
              handler: `${controller.name}.${name}`,
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
// reviewed change: a new @Public() or @AuthenticatedOnly() route widens what an anonymous or
// any signed-in caller can reach, and must be agreed in review, not just appended.
const NO_CAPABILITY_ROUTES: [string, string, Access][] = [['GET', '/api/v1/health', 'public']];

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

  it('R68: every route declares exactly one access decorator', () => {
    const wrong = routes
      .filter((r) => r.access.length !== 1)
      .map((r) => `${r.method} ${r.path} (${r.handler}): [${r.access.join(', ')}]`);
    expect(wrong).toEqual([]);
  });

  it('R68: the routes needing no capability match the reviewed snapshot', () => {
    const open = routes
      .flatMap(({ method, path, access: [only, ...more] }): [string, string, Access][] =>
        only !== undefined && only !== 'capability' && more.length === 0
          ? [[method, path, only]]
          : [],
      )
      .sort((a, b) => `${a[1]} ${a[0]}`.localeCompare(`${b[1]} ${b[0]}`));
    expect(open).toEqual(NO_CAPABILITY_ROUTES);
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
