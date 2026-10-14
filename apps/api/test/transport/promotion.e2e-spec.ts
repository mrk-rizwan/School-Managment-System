// Slice 41, A8 (contracts/slice-41.md §2.7): promotion apply ends the year's live route assignments
// on the year's last day, and a not-continuing pupil's ends with the withdrawal; the new year needs
// a new assignment. The real AppModule, database and clock (the slice-35 world around today).
import type { NestExpressApplication } from '@nestjs/platform-express';
import { newIdempotencyKey } from '@asms/shared';
import { createTestApp } from '../core/app';
import { db } from '../fees/charges-support';
import { approvedSheet, detailOf, promotionHttp, promotionWorld, student } from '../promotion/support';
import { closeTestDb } from '../support/schools';
import { isoDay } from '../support/students';

describe('slice 41: promotion ends the route assignments (e2e)', () => {
  let app: NestExpressApplication;
  const h = promotionHttp(() => app);

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('A8: apply ends promoted pupils’ assignments on the year end and the leaver’s on the withdrawal', async () => {
    const w = await promotionWorld(() => app);
    const pass = await student(w, w.a5A, 'Hamza Tariq');
    const leaver = await student(w, w.a5A, 'Bilal Shah');
    const route = (await h.post('/transport-routes', { name: 'Gulberg' }, w.office, newIdempotencyKey()).expect(201)).body as { id: string };
    await h.post(`/transport-routes/${route.id}/amounts`, { amount: 1800, effectivePeriod: isoDay(0).slice(0, 7) }, w.office).expect(201);
    const ride = async (p: { studentId: bigint }) =>
      (
        (await h.post(`/transport-routes/${route.id}/assignments`, { studentId: p.studentId.toString(), startsOn: isoDay(0) }, w.office, newIdempotencyKey()).expect(201))
          .body as { id: string }
      ).id;
    const passRide = await ride(pass);
    const leaverRide = await ride(leaver);

    await approvedSheet(w, w.a5A, [
      [pass, true],
      [leaver, true],
    ]);
    const sheet = detailOf(await h.open(w.a5A.id, w.yearB.id, w.principal).expect(201));
    await h.decide(sheet.id, [{ enrolmentId: leaver.enrolmentId.toString(), decision: 'not_continuing', reason: 'Family moving abroad' }], w.principal).expect(200);
    await h.apply(sheet.id, w.principal).expect(200);

    const rows = await db().transportAssignment.findMany({ where: { schoolId: w.school.id }, orderBy: { id: 'asc' } });
    expect(rows.map((r) => [r.id.toString(), r.endsOn?.toISOString().slice(0, 10), r.endReason])).toEqual([
      [passRide, w.yearA.endsOn, 'Promotion applied'],
      [leaverRide, isoDay(0), 'Student withdrawn'],
    ]);
    const audits = await db().auditLog.findMany({ where: { schoolId: w.school.id, action: 'transport_assignment.ended' }, orderBy: { id: 'asc' } });
    expect(audits.map((a) => [a.subjectId?.toString(), (a.metadata as { via: string }).via])).toEqual([
      [leaverRide, 'status_change'],
      [passRide, 'promotion'],
    ]);
  });
});
