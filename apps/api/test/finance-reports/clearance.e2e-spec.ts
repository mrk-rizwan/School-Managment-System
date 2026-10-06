// Slice 22's dues clearance (phase-3-financial.md §3.1, A7, R204, R233; contracts/slice-22.md §5):
// open charges across every enrolment and year, the child's advance, and the principal's override,
// which is an audit row and lapses when a newer charge opens. The real AppModule and database.
import { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp } from '../core/app';
import { closeTestDb } from '../support/schools';
import { createAcademicYear, createClass, createSection, enrol, isoDay } from '../support/students';
import { db, karachi, runMonth, structure } from '../fees/charges-support';
import { reportsHttp } from './support';

interface Clearance {
  studentId: string;
  outstanding: number;
  openCharges: { id: string; academicYearId: string; outstanding: number }[];
  advance: number;
  cleared: boolean;
  override: { byUserId: string; byName: string; at: string; reason: string } | null;
}

describe('slice 22: dues clearance (e2e)', () => {
  let app: NestExpressApplication;
  const h = reportsHttp(() => app);
  const { get, post, err } = h;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('R204, A7: across every enrolment and year; the override is a principal decision that lapses with a newer charge', async () => {
    const w = await h.world();
    // Arrears from an earlier, closed year: Hamza owed 3,000 there and left it unpaid.
    const old = await createAcademicYear(db(), w.school, { startsOn: isoDay(-560), endsOn: isoDay(-201), status: 'closed' });
    const oldClass = await createClass(db(), w.school, old);
    const oldSection = await createSection(db(), w.school, oldClass);
    await enrol(db(), w.school, { id: w.a.studentId }, oldSection, { startedOn: isoDay(-560), status: 'left', endedOn: isoDay(-201) });
    await structure(w.school, { academicYearId: old.id, classId: oldClass.id, feeHeadId: w.heads.tuition, amount: 3000, effectiveFrom: isoDay(-560).slice(0, 7) }, w.principal.user.userId);
    const oldMonth = isoDay(-300).slice(0, 7);
    await db().academicYear.updateMany({ where: { schoolId: w.school.id, id: old.id }, data: { status: 'active' } });
    await runMonth(app, w.school, old, oldMonth, karachi(`${oldMonth}-01`));
    await db().academicYear.updateMany({ where: { schoolId: w.school.id, id: old.id }, data: { status: 'closed' } });
    // An advance for Hamza this year: paying the current charge and 1,200 more.
    await h.pay(w, w.office, { guardianId: w.g1, studentIds: [w.a.studentId], amount: 4200 });

    const read = async (by = w.office) => (await get(`/students/${w.a.studentId}/dues-clearance`, by).expect(200)).body as Clearance;
    let clearance = await read();
    expect([clearance.outstanding, clearance.advance, clearance.cleared, clearance.override]).toEqual([3000, 1200, false, null]);
    expect(clearance.openCharges.map((c) => [c.academicYearId, c.outstanding])).toEqual([[old.id.toString(), 3000]]);
    // Hira owes only this year's.
    expect((await get(`/students/${w.b.studentId}/dues-clearance`, w.office).expect(200)).body).toEqual(
      expect.objectContaining({ outstanding: 3000, cleared: false }),
    );

    // The office holds certificate.issue but is not a principal (R233); a teacher holds neither key.
    expect(err(await post(`/students/${w.a.studentId}/dues-clearance/override`, { reason: 'Leaving for abroad' }, w.office).expect(403)).error.details).toEqual({
      reason: 'principal_required',
    });
    await post(`/students/${w.a.studentId}/dues-clearance/override`, { reason: 'Leaving for abroad' }, w.teacher).expect(403);
    await get(`/students/${w.a.studentId}/dues-clearance`, w.teacher).expect(403);
    await post(`/students/${w.a.studentId}/dues-clearance/override`, { reason: 'x' }, w.principal).expect(422);

    clearance = (await post(`/students/${w.a.studentId}/dues-clearance/override`, { reason: 'Leaving for abroad' }, w.principal).expect(200)).body as Clearance;
    expect([clearance.outstanding, clearance.cleared]).toEqual([3000, true]);
    expect(clearance.override).toEqual(
      expect.objectContaining({ byUserId: w.principal.user.userId.toString(), reason: 'Leaving for abroad' }),
    );
    const [row] = await h.audit(w.school, 'dues_clearance.overridden');
    expect([row?.subjectType, row?.subjectId, (row?.metadata as { outstanding: number }).outstanding]).toEqual(['student', w.a.studentId, 3000]);

    // A charge opened after the override (the advance pays 1,200 of it): the override lapses.
    await h.manualCharge(w, w.a, 2000, isoDay(3));
    clearance = await read();
    expect([clearance.outstanding, clearance.advance, clearance.cleared, clearance.override]).toEqual([3800, 0, false, null]);
  });

  it('R232: a principal who is a guardian of the child may not override, even as the only principal', async () => {
    const w = await h.world();
    await h.parentOf(w, w.principal.user, w.a);
    const refused = await post(`/students/${w.a.studentId}/dues-clearance/override`, { reason: 'Leaving for abroad' }, w.principal);
    expect([refused.status, err(refused).error.details?.reason]).toEqual([409, 'own_child']);
    expect(await h.audit(w.school, 'dues_clearance.overridden')).toHaveLength(0);
    // Another child of the school is not theirs: allowed.
    await post(`/students/${w.c.studentId}/dues-clearance/override`, { reason: 'Leaving for abroad' }, w.principal).expect(200);
  });

  it('the override lapses when the outstanding rises above what it overrode (a voided payment reopens an old charge)', async () => {
    const w = await h.world();
    // Hira pays 1,000 of her 3,000; the principal overrides the 2,000 left.
    const part = await h.pay(w, w.office, { guardianId: w.g1, studentIds: [w.b.studentId], amount: 1000 });
    let clearance = (await post(`/students/${w.b.studentId}/dues-clearance/override`, { reason: 'Leaving the city' }, w.principal).expect(200)).body as Clearance;
    expect([clearance.outstanding, clearance.cleared]).toEqual([2000, true]);
    // The payment is voided: the same old charge owes 3,000 again, and no charge is newer.
    await post(`/payments/${part.id}/void`, { reason: 'Recorded against the wrong child' }, w.principal).expect(200);
    clearance = (await get(`/students/${w.b.studentId}/dues-clearance`, w.office).expect(200)).body as Clearance;
    expect([clearance.outstanding, clearance.cleared, clearance.override]).toEqual([3000, false, null]);
  });

  it('404 for another school or no such student', async () => {
    const w = await h.world();
    const other = await h.world({ name: 'Other School' });
    await get(`/students/${other.a.studentId}/dues-clearance`, w.principal).expect(404);
    await post(`/students/${other.a.studentId}/dues-clearance/override`, { reason: 'Not ours' }, w.principal).expect(404);
    await get('/students/999999999/dues-clearance', w.principal).expect(404);
  });
});
