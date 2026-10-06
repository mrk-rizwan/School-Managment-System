// Control 4 / R62 for the wave K table (migration 20261006170000_slice21_payment_claims), at the
// database: a claim written for school A is not found by a school-B query and not changed by a
// school-B write, and every composite foreign key refuses another school's student, guardian,
// decider or payment. Slice 21's build adds the repository-level probe beside its repository.
import { closeTestDb, createTwoSchools, testDb, type TestSchool } from '../support/schools';
import { expectIsolated } from '../support/isolation';
import { createSchoolUser } from '../support/school-session';
import { createClassWithSection, createGuardian, createStudent, day, enrol, isoDay, linkGuardian } from '../support/students';

const db = () => testDb();

/** One school's parents of a claim: a clerk, an enrolled student and a guardian with a login link. */
async function parents(school: TestSchool) {
  const clerk = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
  const { year, section } = await createClassWithSection(db(), school);
  const student = await createStudent(db(), school);
  await enrol(db(), school, student, section);
  const guardian = await createGuardian(db(), school);
  await linkGuardian(db(), school, student, guardian, { canLogin: true });
  return { clerk, year, student, guardian };
}
type Parents = Awaited<ReturnType<typeof parents>>;

const claim = (schoolId: TestSchool['id'], p: Parents, over: { studentId?: bigint; guardianId?: bigint } = {}) =>
  db().paymentClaim.create({
    data: {
      schoolId, studentId: over.studentId ?? p.student.id, guardianId: over.guardianId ?? p.guardian.id, method: 'jazzcash',
      claimedAmount: 1000, paidOn: day(isoDay()), reference: 'JC-1',
    },
  });

/** Refused by the database (a composite FK naming school B's parent from school A, or a trigger). */
const refused = (write: Promise<unknown>) => expect(write).rejects.toThrow();

describe('wave K tenant isolation (database level)', () => {
  afterAll(() => closeTestDb());

  it('payment_claims: invisible and unwritable from another school; another school\'s student, guardian, decider or payment is refused', async () => {
    const two = await createTwoSchools();
    const [a, b] = [await parents(two.a), await parents(two.b)];
    await expectIsolated(two, {
      create: async () => (await claim(two.a.id, a)).id,
      read: (schoolId, id) => db().paymentClaim.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().paymentClaim.findMany({ where: { schoolId } }),
      write: async (schoolId, id) =>
        (await db().paymentClaim.updateMany({ where: { schoolId, id }, data: { status: 'withdrawn', decidedAt: new Date(), decidedBy: b.clerk.userId } })).count,
      snapshot: (row) => (row as { status: string }).status,
    });
    await refused(claim(two.b.id, b, { studentId: a.student.id }));
    await refused(claim(two.b.id, b, { guardianId: a.guardian.id }));
    const claimB = await claim(two.b.id, b);
    await refused(db().paymentClaim.updateMany({ where: { schoolId: two.b.id, id: claimB.id }, data: { status: 'withdrawn', decidedAt: new Date(), decidedBy: a.clerk.userId } }));
    const paymentA = await db().payment.create({
      data: {
        schoolId: two.a.id, academicYearId: a.year.id, payerGuardianId: a.guardian.id, method: 'jazzcash', amount: 1000, reference: 'JC-1',
        receivedOn: day(isoDay()), recordedBy: a.clerk.userId, verifiedBy: a.clerk.userId, advanceForStudentId: a.student.id,
      },
    });
    await db().paymentClaim.updateMany({
      where: { schoolId: two.b.id, id: claimB.id },
      data: { imageObjectKey: `${two.b.id}/01ARZ3NDEKTSV4RRFFQ69G5FAV.jpg`, imageMime: 'image/jpeg', imageSizeBytes: 1000 },
    });
    await refused(
      db().paymentClaim.updateMany({
        where: { schoolId: two.b.id, id: claimB.id },
        data: { status: 'verified', decidedBy: b.clerk.userId, decidedAt: new Date(), verifiedAmount: 1000, paymentId: paymentA.id },
      }),
    );
    expect((await db().paymentClaim.findFirst({ where: { schoolId: two.b.id, id: claimB.id } }))?.status).toBe('pending');
    // payments.claim_id: a payment never names another school's claim.
    const claimA = await claim(two.a.id, a);
    await refused(
      db().payment.create({
        data: {
          schoolId: two.b.id, academicYearId: b.year.id, payerGuardianId: b.guardian.id, method: 'jazzcash', amount: 1000, reference: 'JC-1',
          receivedOn: day(isoDay()), recordedBy: b.clerk.userId, verifiedBy: b.clerk.userId, advanceForStudentId: b.student.id, claimId: claimA.id,
        },
      }),
    );
  });
});
