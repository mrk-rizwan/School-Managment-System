// A4: after-commit callbacks run once the transaction has committed AND left the context, so a
// callback's repository call runs outside the closed transaction, and a callback that opens its
// own transaction gets its own after-commit step.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { MessageRepository } from '../../src/repositories/message.repository';
import { OwnSchoolRepository } from '../../src/repositories/own-school.repository';
import { AfterCommit } from '../../src/tenancy/after-commit';
import { closeTestDb } from '../support/schools';
import { asSchool, messagingApp, messagingSchool, tx } from './support';

describe('AfterCommit (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    ({ app } = await messagingApp());
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('a repository call inside a callback runs outside the committed transaction', async () => {
    const school = await messagingSchool();
    const afterCommit = app.get(AfterCommit, { strict: false });
    const schools = app.get(OwnSchoolRepository, { strict: false });
    const seen: { name?: string; error?: unknown; registerRefused?: boolean } = {};
    await asSchool(app, school.id, () =>
      tx.run(async () => {
        afterCommit.register(async () => {
          try {
            seen.name = (await schools.find(school.id))?.name;
          } catch (error) {
            seen.error = error;
          }
          // Outside any transaction: registering directly is refused, as anywhere else.
          try {
            afterCommit.register(() => Promise.resolve());
            seen.registerRefused = false;
          } catch {
            seen.registerRefused = true;
          }
        });
        return Promise.resolve();
      }),
    );
    expect(seen.error).toBeUndefined();
    expect(seen.name).toBe('Iqra Model School');
    expect(seen.registerRefused).toBe(true);
  });

  it('a callback that opens a transaction and registers another callback has that one run too', async () => {
    const school = await messagingSchool();
    const afterCommit = app.get(AfterCommit, { strict: false });
    const messages = app.get(MessageRepository, { strict: false });
    const order: string[] = [];
    await asSchool(app, school.id, () =>
      tx.run(async () => {
        afterCommit.register(async () => {
          order.push('outer');
          await tx.run(async () => {
            await messages.find(school.id, 1n);
            afterCommit.register(async () => {
              order.push('inner');
              await messages.find(school.id, 1n);
              order.push('inner read');
            });
          });
        });
        return Promise.resolve();
      }),
    );
    expect(order).toEqual(['outer', 'inner', 'inner read']);
  });

  it('nothing runs when the transaction rolls back', async () => {
    const school = await messagingSchool();
    const afterCommit = app.get(AfterCommit, { strict: false });
    let ran = false;
    await expect(
      asSchool(app, school.id, () =>
        tx.run(() => {
          afterCommit.register(() => {
            ran = true;
            return Promise.resolve();
          });
          return Promise.reject(new Error('roll back'));
        }),
      ),
    ).rejects.toThrow('roll back');
    expect(ran).toBe(false);
  });
});
