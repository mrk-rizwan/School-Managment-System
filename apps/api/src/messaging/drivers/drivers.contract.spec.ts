// Driver contract tests against the REAL providers (Phase 2 plan §3 "Tests"): run only with
// RUN_DRIVER_TESTS=1 and real credentials in the environment, never in CI. Each sends one
// message to DRIVER_TEST_PHONE (a number the operator owns) and checks the mapped outcome.
import { loadEnv } from '../../config/env';
import { SendpkSmsDriver } from './sms';
import { CloudApiDriver } from './whatsapp';

const enabled = process.env.RUN_DRIVER_TESTS === '1';
const describeReal = enabled ? describe : describe.skip;

describeReal('driver contracts (RUN_DRIVER_TESTS=1 only)', () => {
  const phone = process.env.DRIVER_TEST_PHONE ?? '';

  it('Sendpk: a send is accepted with a reference, and its status can be queried', async () => {
    const env = loadEnv();
    if (!env.SMS_API_KEY || !env.SMS_SENDER_ID) throw new Error('SMS_API_KEY and SMS_SENDER_ID are required');
    const driver = new SendpkSmsDriver({ baseUrl: env.SMS_API_URL, apiKey: env.SMS_API_KEY, senderId: env.SMS_SENDER_ID });
    const outcome = await driver.send(phone, 'ASMS: driver contract test. No action needed.');
    expect(outcome.kind).toBe('accepted');
    if (outcome.kind === 'accepted' && outcome.ref) {
      expect(['pending', 'delivered', 'failed']).toContain((await driver.fetchStatus(outcome.ref)).kind);
    }
  });

  it('Cloud API: a refused token maps to token_rejected', async () => {
    const env = loadEnv();
    const driver = new CloudApiDriver(env.META_GRAPH_VERSION);
    expect(await driver.verify(process.env.DRIVER_TEST_PHONE_NUMBER_ID ?? '1', 'not-a-real-token-0000000000')).toEqual({
      ok: false,
      reason: 'token_rejected',
    });
  });
});
