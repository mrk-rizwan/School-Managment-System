// The field-encryption AAD of each identity-number column is part of every stored ciphertext:
// changing a string makes existing rows undecryptable. These are pinned, not derived.
import { bFormAad, guardianCnicAad, identityAad, staffCnicAad } from '../../src/common/identity';
import { closeTestDb, createSchool } from '../support/schools';

describe('identity-number AAD strings', () => {
  afterAll(closeTestDb);

  it('stays schoolId|table|column for each encrypted identity column', async () => {
    const { id } = await createSchool();
    expect(staffCnicAad(id)).toBe(`${id}|staff|cnic`);
    expect(guardianCnicAad(id)).toBe(`${id}|guardians|cnic`);
    expect(bFormAad(id)).toBe(`${id}|students|b_form`);
    expect(identityAad(id, { table: 'staff', column: 'cnic' })).toBe(`${id}|staff|cnic`);
    expect(identityAad(id, { table: 'guardians', column: 'cnic' })).toBe(`${id}|guardians|cnic`);
    expect(identityAad(id, { table: 'students', column: 'b_form' })).toBe(`${id}|students|b_form`);
  });
});
