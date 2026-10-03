import { NestExpressApplication } from '@nestjs/platform-express';
import { HealthModule } from '../../src/modules/health/health.module';
import { PlatformModule } from '../../src/modules/platform/platform.module';
import { buildOpenApiDocuments, schoolDocumentModules } from '../../src/openapi-documents';
import { WebhooksModule } from '../../src/webhooks/webhooks.module';
import { createTestApp } from './app';
import { TestCoreModule } from './test.controller';

describe('OpenAPI helpers', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp({ imports: [TestCoreModule] });
  });

  afterAll(async () => {
    await app.close();
  });

  it('R66: a path id is documented as a pattern-checked string, once', () => {
    const { school } = buildOpenApiDocuments(app);
    const params = school.paths['/api/v1/test/items/{id}']?.get?.parameters ?? [];
    const ids = params.filter((p) => 'name' in p && p.name === 'id');
    expect(ids).toEqual([
      expect.objectContaining({ in: 'path', schema: expect.objectContaining({ type: 'string', pattern: '^[1-9][0-9]{0,18}$' }) }),
    ]);
  });

  it('@ApiPaginated and @ApiErrors document the page shape and the envelope', () => {
    const { school } = buildOpenApiDocuments(app);
    const responses = school.paths['/api/v1/test/things']?.get?.responses ?? {};
    expect(JSON.stringify(responses['200'])).toContain('#/components/schemas/ItemDto');
    expect(JSON.stringify(responses['422'])).toContain('#/components/schemas/ApiErrorDto');
    expect(JSON.stringify(responses.default)).toContain('#/components/schemas/ApiErrorDto');
  });

  it('the platform document is separate: platform routes there, test and school routes not', () => {
    const { school, platform } = buildOpenApiDocuments(app);
    expect(Object.keys(platform.paths)).toContain('/api/v1/platform/auth/login');
    expect(Object.keys(platform.paths).every((p) => p.startsWith('/api/v1/platform/'))).toBe(true);
    expect(Object.keys(school.paths)).toContain('/api/v1/test/things');
    expect(Object.keys(school.paths).some((p) => p.startsWith('/api/v1/platform/'))).toBe(false);
  });

  it('the webhooks are in no document: WebhooksModule is outside the school bucket and the platform tree', () => {
    const modules = schoolDocumentModules(app);
    expect(modules).toContain(HealthModule);
    expect(modules).not.toContain(WebhooksModule);
    expect(modules).not.toContain(PlatformModule);
    const { school, platform } = buildOpenApiDocuments(app);
    const paths = [...Object.keys(school.paths), ...Object.keys(platform.paths)];
    expect(paths.some((p) => p.startsWith('/api/v1/webhooks'))).toBe(false);
  });
});
