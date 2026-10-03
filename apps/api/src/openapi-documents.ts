// The two OpenAPI documents (§3.9). Kept out of common/openapi.ts, which every controller imports
// for @ApiErrors: this file imports PlatformModule, and the cycle would leave ApiErrors undefined
// while the platform controllers load.
import { INestApplication, Type } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { PlatformModule } from './modules/platform/platform.module';

/** PlatformModule and every module it imports, recursively. */
function platformModules(): Set<unknown> {
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

/**
 * School and platform documents, so school and mobile clients carry no platform types. The
 * platform document is PlatformModule's tree; the school document is every other module.
 */
export function buildOpenApiDocuments(app: INestApplication): {
  school: OpenAPIObject;
  platform: OpenAPIObject;
} {
  const platformSet = platformModules();
  const schoolModules = [...app.get(ModulesContainer).values()]
    .map((module) => module.metatype)
    .filter((metatype): metatype is Type => !platformSet.has(metatype));
  const school = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('ASMS school API').setVersion('1').build(),
    { include: schoolModules },
  );
  const platform = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('ASMS platform API').setVersion('1').build(),
    { include: [PlatformModule], deepScanRoutes: true },
  );
  return { school, platform };
}
