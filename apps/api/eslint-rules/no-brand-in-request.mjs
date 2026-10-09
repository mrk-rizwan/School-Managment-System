// Local type-aware rule: nothing the request fills may be, or contain, a tenant brand.
//
// Closes the slice-0 residual risk (docs/WORKLOG.md): the name-based bans in eslint.config.mjs
// see `SchoolId` written by name, not a brand reached through `Parameters<typeof f>[0]`, an
// alias or a generic. This rule asks the type checker instead.
//
// 1. A parameter of a @Controller method carrying any parameter decorator must be typed as a
//    class, so the ValidationPipe has something to validate. Allowed otherwise: `string` under
//    @Param('key') / @Query('key'), and the SANCTIONED decorators below, which return trusted
//    server-side values rather than client input.
// 2. Every decorated method parameter (anywhere, constructors excepted) and every field of a
//    class with a decorated field (a DTO: class-validator decorates its fields) must not contain
//    a brand at any depth: properties, array and tuple elements, union and intersection members,
//    generic and alias type arguments, index signatures. A brand is a property keyed by a
//    `declare const x: unique symbol` declared in src/tenancy/** - detected through that
//    symbol's declaration, never by a type's name, so every present and future brand is covered.
import ts from 'typescript';

/**
 * Parameter decorators whose value is server-side, matched by name AND by the file that declares
 * them, so a local function of the same name is not trusted. `checkBrand: false` only where the
 * value legitimately holds a SchoolId: the session the server resolved from the cookie or bearer.
 */
const SANCTIONED = [
  {
    name: 'CurrentSchoolSession',
    file: /\/src\/common\/auth\/school-session\.ts$/,
    checkBrand: false,
  },
  {
    name: 'CurrentPlatformSession',
    file: /\/src\/common\/auth\/platform-session\.ts$/,
    checkBrand: false,
  },
  // Phase 5: the school a biometric device's token resolved to (named exception 4, widened).
  {
    name: 'CurrentDevice',
    file: /\/src\/common\/auth\/device-token\.ts$/,
    checkBrand: false,
  },
  // `@IdParam() id: bigint`: ParseIdPipe turns the path segment into a checked bigint.
  { name: 'IdParam', file: /\/src\/common\/ids\.ts$/, checkBrand: true },
  // The framework's request and response objects, not deserialised client input.
  { name: 'Req', file: /\/node_modules\/@nestjs\/common\//, checkBrand: true },
  { name: 'Res', file: /\/node_modules\/@nestjs\/common\//, checkBrand: true },
];

// Names for the message only; detection never depends on them.
const BRAND_TYPE = {
  schoolIdBrand: 'SchoolId',
  scopeBrand: 'Scope',
  createdSchoolBrand: 'CreatedSchoolRow',
  principalIssueBrand: 'PrincipalIssueSchoolRow',
};

const TENANCY_FILE = /\/src\/tenancy\/[^/]+\.ts$/;
const posix = (path) => path.replace(/\\/g, '/');

/** The decorator's callee identifier: `@X()` and `@X` both give `X`. */
function decoratorId(decorator) {
  const expr = decorator.expression;
  const callee = expr.type === 'CallExpression' ? expr.callee : expr;
  return callee.type === 'Identifier' ? callee : null;
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Request-bound values are classes and never carry a tenant brand.' },
    schema: [],
    messages: {
      nonClass:
        'A request-decorated parameter must be typed as a class (a DTO the ValidationPipe checks), not {{what}}.',
      brand:
        '{{where}} contains the {{brand}} brand (at {{path}}). A tenant brand never comes from the request; take it from the session.',
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    if (!services?.program || !services.esTreeNodeToTSNodeMap) {
      throw new Error('asms/no-brand-in-request needs type information.');
    }
    const program = services.program;
    const checker = program.getTypeChecker();
    const tsNode = (node) => services.esTreeNodeToTSNodeMap.get(node);

    const isExternalFile = (sf) =>
      program.isSourceFileDefaultLibrary(sf) ||
      program.isSourceFileFromExternalLibrary(sf) ||
      posix(sf.fileName).includes('/node_modules/');

    const resolveAlias = (symbol) =>
      symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;

    /** The brand's unique-symbol name if `prop` is keyed by one declared in src/tenancy. */
    function brandOf(prop) {
      for (const decl of prop.declarations ?? []) {
        if (!decl.name || !ts.isComputedPropertyName(decl.name)) continue;
        const key = resolveAlias(checker.getSymbolAtLocation(decl.name.expression));
        for (const keyDecl of key?.declarations ?? []) {
          if (
            ts.isVariableDeclaration(keyDecl) &&
            keyDecl.type &&
            ts.isTypeOperatorNode(keyDecl.type) &&
            keyDecl.type.operator === ts.SyntaxKind.UniqueKeyword &&
            TENANCY_FILE.test(posix(keyDecl.getSourceFile().fileName))
          ) {
            return key.name;
          }
        }
      }
      return null;
    }

    /** Declared only in lib or node_modules, which cannot name a brand except via type arguments. */
    function isExternalType(type) {
      const decls = (type.aliasSymbol ?? type.getSymbol())?.declarations ?? [];
      return decls.length > 0 && decls.every((d) => isExternalFile(d.getSourceFile()));
    }

    /** The first brand in `type` at any depth, with the path to it, or null. */
    function findBrand(type, path, seen) {
      if (seen.has(type)) return null;
      seen.add(type);
      const children = [];
      if (type.isUnionOrIntersection()) for (const t of type.types) children.push([t, path]);
      for (const arg of type.aliasTypeArguments ?? []) children.push([arg, `${path}<>`]);
      const isObject = (type.flags & ts.TypeFlags.Object) !== 0;
      if (isObject && type.objectFlags & ts.ObjectFlags.Reference) {
        for (const arg of checker.getTypeArguments(type)) children.push([arg, `${path}[]`]);
      }
      // An external type's members are not walked (that would visit all of lib.d.ts and
      // @types/node); what it holds of ours arrives through its type arguments, walked above.
      if (isObject && !isExternalType(type)) {
        for (const prop of checker.getPropertiesOfType(type)) {
          const brand = brandOf(prop);
          if (brand) return { brand, path };
          children.push([checker.getTypeOfSymbol(prop), `${path}.${prop.getName()}`]);
        }
        for (const info of checker.getIndexInfosOfType(type)) {
          children.push([info.type, `${path}[key]`]);
        }
      }
      for (const [child, childPath] of children) {
        const found = findBrand(child, childPath, seen);
        if (found) return found;
      }
      return null;
    }

    function reportBrand(node, typeNode, where, root) {
      const type = typeNode
        ? checker.getTypeFromTypeNode(tsNode(typeNode))
        : checker.getTypeAtLocation(tsNode(node));
      const found = findBrand(type, root, new Set());
      if (!found) return;
      const brand = BRAND_TYPE[found.brand] ?? found.brand;
      context.report({ node, messageId: 'brand', data: { where, brand, path: found.path } });
    }

    /** The SANCTIONED entry this decorator resolves to, if any. */
    function sanctioned(decorator) {
      const id = decoratorId(decorator);
      const entry = id && SANCTIONED.find((s) => s.name === id.name);
      if (!entry) return null;
      const symbol = resolveAlias(checker.getSymbolAtLocation(tsNode(id)));
      const files = (symbol?.declarations ?? []).map((d) => posix(d.getSourceFile().fileName));
      return files.length > 0 && files.every((f) => entry.file.test(f)) ? entry : null;
    }

    const isController = (classNode) =>
      (classNode?.decorators ?? []).some((d) => decoratorId(d)?.name === 'Controller');

    /** Why `typeNode` is not a class, or null when it is one. */
    function notAClass(typeNode, decorator) {
      if (!typeNode) return 'an untyped parameter';
      const type = checker.getTypeFromTypeNode(tsNode(typeNode));
      if (type.isUnion()) return 'a union';
      if (type.isIntersection()) return 'an intersection';
      if (type.flags & ts.TypeFlags.String) {
        // @Param('id') / @Query('page'): one named string key.
        const expr = decorator.expression;
        const keyed =
          expr.type === 'CallExpression' &&
          ['Param', 'Query'].includes(decoratorId(decorator)?.name) &&
          expr.arguments[0]?.type === 'Literal' &&
          typeof expr.arguments[0].value === 'string';
        return keyed ? null : 'a primitive';
      }
      if (!(type.flags & ts.TypeFlags.Object)) return 'a primitive';
      const symbol = type.getSymbol();
      if (
        symbol &&
        symbol.flags & ts.SymbolFlags.Class &&
        !(type.objectFlags & ts.ObjectFlags.Anonymous)
      ) {
        return null;
      }
      if (symbol && symbol.flags & ts.SymbolFlags.Interface) return 'an interface';
      if (type.aliasSymbol) return 'a type alias';
      return 'an object type';
    }

    function checkParameter(param, method) {
      const decorators = param.decorators ?? [];
      if (decorators.length === 0 || method.kind === 'constructor') return;
      const target = param.type === 'TSParameterProperty' ? param.parameter : param;
      const typeNode = target.typeAnnotation?.typeAnnotation ?? null;
      const entries = decorators.map(sanctioned);

      if (isController(method.parent?.parent)) {
        decorators.forEach((decorator, i) => {
          if (entries[i]) return;
          const what = notAClass(typeNode, decorator);
          if (what) context.report({ node: param, messageId: 'nonClass', data: { what } });
        });
      }
      if (entries.every((entry) => entry?.checkBrand !== false)) {
        reportBrand(param, typeNode, 'A request-decorated parameter', 'parameter');
      }
    }

    return {
      MethodDefinition(method) {
        for (const param of method.value.params) checkParameter(param, method);
      },
      ClassBody(body) {
        const fields = body.body.filter((m) => m.type === 'PropertyDefinition' && !m.static);
        if (!fields.some((field) => (field.decorators ?? []).length > 0)) return;
        for (const field of fields) {
          const name = field.key.type === 'Identifier' ? field.key.name : 'field';
          reportBrand(field, field.typeAnnotation?.typeAnnotation ?? null, 'A DTO field', name);
        }
      },
    };
  },
};
