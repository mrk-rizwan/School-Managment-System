import { NestExpressApplication } from '@nestjs/platform-express';
import { buildOpenApiDocuments } from '../../src/common/openapi';
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

  it('the platform document is separate and empty until slice 1', () => {
    expect(buildOpenApiDocuments(app).platform.paths).toEqual({});
  });
});
