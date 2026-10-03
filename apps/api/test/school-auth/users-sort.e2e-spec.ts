// GET /users sorts on the name the list shows (contract slice-2 §5.1): COALESCE(staff, guardian),
// so staff and guardian accounts interleave alphabetically, in both directions and across pages.
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from '../core/app';
import { createSchoolSession, createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb } from '../support/schools';
import { createGuardianUser } from './support';

type PageBody = { data: { fullName: string }[]; total: number };

describe('users list sorted by the displayed name', () => {
  let app: NestExpressApplication;
  let cookie: string;
  const db = () => testDb();

  beforeAll(async () => {
    app = await createTestApp();
    const school = await createSchool();
    const principal = await createSchoolUser(db(), school, { systemRole: 'principal', fullName: 'Echo Principal' });
    cookie = (await createSchoolSession(db(), school, principal)).cookie;
    await createSchoolUser(db(), school, { systemRole: 'teacher', fullName: 'Bravo Staff' });
    await createSchoolUser(db(), school, { systemRole: 'teacher', fullName: 'Delta Staff' });
    for (const name of ['Alpha Guardian', 'Charlie Guardian', 'Foxtrot Guardian']) {
      const g = await createGuardianUser(db(), school);
      await db().guardian.updateMany({ where: { schoolId: school.id, id: g.guardianId }, data: { fullName: name } });
    }
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const names = async (query: string): Promise<PageBody> =>
    (await request(app.getHttpServer()).get(`/api/v1/users?${query}`).set('Cookie', cookie).expect(200)).body as PageBody;

  const ascending = ['Alpha Guardian', 'Bravo Staff', 'Charlie Guardian', 'Delta Staff', 'Echo Principal', 'Foxtrot Guardian'];

  it('ascending by default and with sort=fullName', async () => {
    expect((await names('limit=50')).data.map((u) => u.fullName)).toEqual(ascending);
    expect((await names('sort=fullName&limit=50')).data.map((u) => u.fullName)).toEqual(ascending);
  });

  it('descending with sort=-fullName', async () => {
    expect((await names('sort=-fullName&limit=50')).data.map((u) => u.fullName)).toEqual([...ascending].reverse());
  });

  it('pages follow the same order, and total counts every match', async () => {
    const second = await names('sort=fullName&limit=2&page=2');
    expect(second.data.map((u) => u.fullName)).toEqual(['Charlie Guardian', 'Delta Staff']);
    expect(second.total).toBe(6);
    const lastDesc = await names('sort=-fullName&limit=4&page=2');
    expect(lastDesc.data.map((u) => u.fullName)).toEqual(['Bravo Staff', 'Alpha Guardian']);
  });

  it('filters still apply under the raw page query', async () => {
    const guardians = await names('kind=guardian&sort=-fullName&limit=50');
    expect(guardians.data.map((u) => u.fullName)).toEqual(['Foxtrot Guardian', 'Charlie Guardian', 'Alpha Guardian']);
    expect(guardians.total).toBe(3);
    const q = await names('q=staff&limit=50');
    expect(q.data.map((u) => u.fullName)).toEqual(['Bravo Staff', 'Delta Staff']);
    expect((await names('kind=student&limit=50')).total).toBe(0);
  });
});
