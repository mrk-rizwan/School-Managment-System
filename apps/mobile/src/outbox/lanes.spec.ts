import { LANES, ONLINE_ONLY_ACTIONS } from './lanes';

// R162 and slice-15 §7.3.

test('no online-only action is an outbox lane', () => {
  const lanes = Object.keys(LANES);
  for (const action of ONLINE_ONLY_ACTIONS) expect(lanes).not.toContain(action);
  for (const lane of Object.values(LANES)) {
    expect(lane.path).not.toMatch(
      /change-password|revoke-others|logout|arrivals|amend|cover|announcements/,
    );
  }
});

test('slice 15 ships exactly the device_register lane, server-idempotent, no header', () => {
  expect(LANES).toEqual({
    device_register: expect.objectContaining({
      method: 'POST',
      path: '/api/v1/me/devices',
      idempotencyHeader: false,
      coalesces: false,
      remedy: null,
    }),
  });
});
