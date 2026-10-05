import { ApiError, Capability, ErrorCode } from '@asms/shared';
import { fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AnnouncementDto,
  AudiencePreviewDto,
  DeliverySummaryDto,
  MeDto,
} from '../api/contracts';
import { queryClient } from '../api/query-client';
import { getDb } from '../db/database';
import { listUnfinished } from '../db/outbox.repository';
import { errorBody, resetDevice, type Handler } from '../test/fake-api';
import { meFixture } from '../test/fixtures';
import { eventually, renderSignedIn, setOnline } from '../test/screen';
import { AnnouncementScreen } from './AnnouncementScreen';
import { AnnounceScreen } from './AnnounceScreen';
import {
  audienceLabel,
  audiencesFor,
  deliveryLines,
  previewLine,
  reusedKeyId,
} from './announce-model';
import { ComposeScreen, createPreviewer } from './ComposeScreen';

// slice-16 §7.2, aligned with contracts/slice-14.md §2–§5, §12 (announce/compose.spec.tsx,
// announce/list.spec.tsx): the reduced picker's shapes, the debounced preview and its 429, the
// Idempotency-Key generated once per open and never stored, SMS_CAP_EXCEEDED's send-without-SMS
// with a new key, and the create-then-send gap leaving a draft the list can send.

const principal = (extra: string[] = []): MeDto =>
  meFixture({
    roles: ['principal'],
    capabilities: [
      Capability.ANNOUNCEMENT_SEND_SCHOOL,
      Capability.ANNOUNCEMENT_SEND_SCOPE,
      ...extra,
    ] as MeDto['capabilities'],
  });

function previewDto(patch: Partial<AudiencePreviewDto> = {}): AudiencePreviewDto {
  return {
    byAudience: [{ kind: 'everyone', persons: 83, targetId: null, targetName: null }],
    computedAt: '2026-10-04T04:00:00.000Z',
    recipients: { total: 83, guardians: 60, staff: 3, students: 20 },
    sms: { allowed: true, cap: 1000, legs: 40, remaining: 900, segments: 1, units: 40 },
    warnings: [],
    ...patch,
  };
}

function announcement(patch: Partial<AnnouncementDto> = {}): AnnouncementDto {
  return {
    attachmentMime: null,
    attachmentSizeBytes: null,
    audiences: [{ kind: 'everyone', roles: [], targetId: null, targetName: null }],
    body: 'School closes at noon.',
    cancelReason: null,
    cancelledAt: null,
    cancelledBy: null,
    category: 'general',
    createdAt: '2026-10-04T04:00:00.000Z',
    createdBy: '41',
    createdByName: 'Ayesha Khan',
    expiresOn: null,
    hasAttachment: false,
    holidayId: null,
    id: '800',
    messageType: 'announcement_normal',
    priority: 'normal',
    recipientCount: 0,
    scheduledAt: null,
    sendFailedAt: null,
    sentAt: null,
    smsSegments: null,
    status: 'draft',
    title: 'Early closing',
    updatedAt: '2026-10-04T04:00:00.000Z',
    ...patch,
  };
}

function delivery(): DeliverySummaryDto {
  return {
    announcementId: '801',
    byChannel: [{ channel: 'push', accepted: 1, delivered: 1, failed: 0, suppressed: 0 }],
    computedAt: '2026-10-04T04:00:00.000Z',
    messages: { delivered: 1, failed: 0, queued: 0, sending: 0, sent: 0, suppressed: 0 },
    recipients: { guardians: 1, staff: 0, students: 0, total: 1 },
    smsSegmentsPerMessage: null,
    smsUnitsReserved: 0,
    status: 'sent',
    suppressions: [],
  };
}

const page = (data: unknown[], limit = 25) => ({
  status: 200,
  body: { data, page: 1, limit, total: data.length },
});

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});
afterEach(() => queryClient.clear());

describe('the reduced picker (slice-14 §12)', () => {
  test('broad kinds have no target; class and section carry one and both roles or parents only', () => {
    expect(audiencesFor({ kind: 'everyone' })).toEqual([{ kind: 'everyone' }]);
    expect(audiencesFor({ kind: 'staff' })).toEqual([{ kind: 'staff' }]);
    expect(audiencesFor({ kind: 'section', targetId: null, parentsOnly: false })).toBeNull();
    expect(audiencesFor({ kind: 'class', targetId: '20', parentsOnly: false })).toEqual([
      { kind: 'class', targetId: '20', roles: ['parents', 'students'] },
    ]);
    expect(audiencesFor({ kind: 'section', targetId: '12', parentsOnly: true })).toEqual([
      { kind: 'section', targetId: '12', roles: ['parents'] },
    ]);
  });

  test('audiences in words: classes, sections and staff by name; a student or family by kind', () => {
    expect(audienceLabel({ kind: 'section', targetName: 'Class 5 A' })).toBe('Class 5 A');
    expect(audienceLabel({ kind: 'staff_member', targetName: 'Imran Shah' })).toBe('Imran Shah');
    expect(audienceLabel({ kind: 'student', targetName: 'Ali Raza' })).toBe('One student');
    expect(audienceLabel({ kind: 'guardian', targetName: 'Imran Raza' })).toBe('One family');
    expect(audienceLabel({ kind: 'everyone', targetName: null })).toBe('Everyone');
  });

  test('a reused-key answer names its draft only when it carries an id', () => {
    const answer = (details: unknown) =>
      new ApiError(409, ErrorCode.IDEMPOTENCY_KEY_REUSED, 'reused', details, null);
    expect(reusedKeyId(answer({ announcementId: '800' }))).toBe('800');
    expect(reusedKeyId(answer(null))).toBeNull();
    expect(reusedKeyId(new TypeError('x'))).toBeNull();
  });

  test('the preview line, and the one with SMS not allowed', () => {
    expect(previewLine(previewDto())).toBe(
      'Reaches 83 people (60 parents, 20 students, 3 staff) · SMS: 40 units of 900 left',
    );
    expect(
      previewLine(
        previewDto({
          sms: { allowed: false, cap: 1000, legs: 0, remaining: 900, segments: 1, units: 0 },
        }),
      ),
    ).toMatch(/SMS: none for this message$/);
  });
});

describe('compose', () => {
  function composeRoutes(over: Record<string, Handler> = {}) {
    const previews: unknown[] = [];
    const creates: { key: string | null; body: unknown }[] = [];
    const routes: Record<string, Handler> = {
      'POST /api/v1/announcements/preview-audience': (request) => {
        previews.push(request.body);
        return { status: 200, body: previewDto() };
      },
      'POST /api/v1/announcements': (request) => {
        creates.push({ key: request.headers.get('Idempotency-Key'), body: request.body });
        return { status: 201, body: announcement() };
      },
      // Send-now answers `sending`; a job delivers it (the slice-14 change, wave F).
      'POST /api/v1/announcements/800/send': () => ({
        status: 200,
        body: announcement({ status: 'sending' }),
      }),
      'GET /api/v1/classes': () =>
        page(
          [
            {
              academicYearId: '3',
              academicYearName: '2026–27',
              attendanceMode: 'daily',
              createdAt: '2026-09-01T00:00:00.000Z',
              id: '20',
              name: 'Class 5',
              sortOrder: 1,
              status: 'active',
              updatedAt: '2026-09-01T00:00:00.000Z',
            },
          ],
          50,
        ),
      'GET /api/v1/classes/20/sections': () =>
        page(
          [
            { id: '12', name: 'A', archivedAt: null, classId: '20' },
            { id: '13', name: 'B', archivedAt: null, classId: '20' },
          ],
          50,
        ),
      ...over,
    };
    return { previews, creates, routes };
  }

  function fill(title = 'Early closing', body = 'School closes at noon.') {
    fireEvent.changeText(screen.getByTestId('announce.title'), title);
    fireEvent.changeText(screen.getByTestId('announce.body'), body);
  }

  test('the preview is debounced: several quick changes, one request with ids and the text', async () => {
    const { previews, routes } = composeRoutes();
    await renderSignedIn(<ComposeScreen />, principal(), routes);
    fireEvent.changeText(screen.getByTestId('announce.title'), 'E');
    fireEvent.changeText(screen.getByTestId('announce.title'), 'Ea');
    fill();
    await eventually(() =>
      expect(screen.getByTestId('announce.preview')).toHaveTextContent(
        'Reaches 83 people (60 parents, 20 students, 3 staff) · SMS: 40 units of 900 left',
      ),
    );
    expect(previews).toEqual([
      {
        audiences: [{ kind: 'everyone' }],
        priority: 'normal',
        title: 'Early closing',
        body: 'School closes at noon.',
      },
    ]);
  });

  test('section: class then section, both roles, or parents only', async () => {
    const { previews, routes } = composeRoutes();
    await renderSignedIn(<ComposeScreen />, principal(), routes);
    fireEvent.press(screen.getByTestId('announce.audience.section'));
    fireEvent.press(await screen.findByTestId('announce.class.20'));
    fireEvent.press(await screen.findByTestId('announce.section.12'));
    await eventually(() =>
      expect(previews.at(-1)).toMatchObject({
        audiences: [{ kind: 'section', targetId: '12', roles: ['parents', 'students'] }],
      }),
    );
    fireEvent.press(screen.getByTestId('announce.roles.parents'));
    await eventually(() =>
      expect(previews.at(-1)).toMatchObject({
        audiences: [{ kind: 'section', targetId: '12', roles: ['parents'] }],
      }),
    );
  });

  test('a 429 pauses counting and sending still works', async () => {
    const { routes } = composeRoutes({
      'POST /api/v1/announcements/preview-audience': () => ({
        status: 429,
        body: errorBody('RATE_LIMITED', 'Too many'),
        headers: { 'Retry-After': '7' },
      }),
    });
    await renderSignedIn(<ComposeScreen />, principal(), routes);
    fill();
    await eventually(() =>
      expect(screen.getByTestId('announce.preview')).toHaveTextContent(
        'Counting paused — try again in 7 s.',
      ),
    );
    expect(screen.getByTestId('announce.send')).toBeEnabled();
  });

  test('send: create with the key made when the form opened, then send; the key is never stored', async () => {
    let attempt = 0;
    const { creates, routes } = composeRoutes();
    const create = routes['POST /api/v1/announcements']!;
    routes['POST /api/v1/announcements'] = (request) => {
      attempt += 1;
      creates.push({ key: request.headers.get('Idempotency-Key'), body: request.body });
      // The first try dies on the way: a retry carries the same key.
      if (attempt === 1) return 'network';
      creates.pop();
      return create(request);
    };
    await renderSignedIn(<ComposeScreen />, principal(), routes);
    fill();
    fireEvent.press(screen.getByTestId('announce.send'));
    fireEvent.press(await screen.findByTestId('announce.confirm.send'));
    await eventually(() =>
      expect(screen.getByTestId('announce.confirm.message')).toHaveTextContent(
        'No connection. Sending needs a connection.',
      ),
    );
    fireEvent.press(screen.getByTestId('announce.confirm.send'));
    await eventually(() => expect(router.back).toHaveBeenCalled());
    expect(creates).toHaveLength(2);
    expect(creates[0]!.key).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(creates[1]!.key).toBe(creates[0]!.key);
    expect(creates[1]!.body).toEqual({
      title: 'Early closing',
      body: 'School closes at noon.',
      category: 'general',
      priority: 'normal',
      audiences: [{ kind: 'everyone' }],
    });
    // Online only: nothing in the outbox, and the key in no row of the database.
    expect(await listUnfinished()).toEqual([]);
    const db = await getDb();
    const rows = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM cache');
    expect(JSON.stringify(rows)).not.toContain(creates[0]!.key!);
  });

  test('SMS_CAP_EXCEEDED: the words, and "Send without SMS" makes the same draft normal and sends it', async () => {
    let sends = 0;
    const patches: unknown[] = [];
    const { creates, routes } = composeRoutes({
      'POST /api/v1/announcements/800/send': () => {
        sends += 1;
        return sends === 1
          ? {
              status: 409,
              body: errorBody('SMS_CAP_EXCEEDED', 'cap', {
                smsUnits: 120,
                remaining: 40,
                cap: 1000,
              }),
            }
          : { status: 200, body: announcement({ status: 'sending' }) };
      },
      'PATCH /api/v1/announcements/800': (request) => {
        patches.push(request.body);
        return { status: 200, body: announcement({ priority: 'normal' }) };
      },
    });
    await renderSignedIn(<ComposeScreen />, principal(), routes);
    fill();
    fireEvent.press(screen.getByTestId('announce.priority.urgent'));
    fireEvent.press(screen.getByTestId('announce.send'));
    fireEvent.press(await screen.findByTestId('announce.confirm.send'));
    await eventually(() =>
      expect(screen.getByTestId('announce.confirm.message')).toHaveTextContent(
        'This needs 120 SMS units; 40 are left this month. Send as normal (no SMS) or ask the platform to raise the cap.',
      ),
    );
    fireEvent.press(screen.getByTestId('announce.confirm.withoutSms'));
    await eventually(() => expect(router.back).toHaveBeenCalled());
    // One announcement only: never a duplicate draft.
    expect(creates).toHaveLength(1);
    expect(creates[0]!.body).toMatchObject({ priority: 'urgent' });
    expect(patches).toEqual([{ priority: 'normal' }]);
    expect(sends).toBe(2);
  });

  test('a failure between create and send leaves a draft: sending again only sends', async () => {
    let sends = 0;
    const { creates, routes } = composeRoutes({
      'POST /api/v1/announcements/800/send': () => {
        sends += 1;
        return sends === 1 ? 'network' : { status: 200, body: announcement({ status: 'sent' }) };
      },
    });
    await renderSignedIn(<ComposeScreen />, principal(), routes);
    fill();
    fireEvent.press(screen.getByTestId('announce.send'));
    fireEvent.press(await screen.findByTestId('announce.confirm.send'));
    await eventually(() =>
      expect(screen.getByTestId('announce.confirm.message')).toHaveTextContent(
        'Saved as a draft but not sent. Send again, or send it from the list.',
      ),
    );
    // The draft is saved: its content is locked; Send draft sends that id and nothing else.
    expect(screen.getByTestId('announce.locked')).toHaveTextContent(
      'Saved as a draft. Send it, or edit it from the list.',
    );
    expect(screen.getByTestId('announce.title').props.editable).toBe(false);
    expect(screen.getByTestId('announce.body').props.editable).toBe(false);
    for (const id of ['priority.urgent', 'category.exam', 'audience.staff']) {
      expect(screen.getByTestId(`announce.${id}`)).toBeDisabled();
    }
    fireEvent.press(screen.getByTestId('announce.confirm.send'));
    await eventually(() => expect(router.back).toHaveBeenCalled());
    expect(creates).toHaveLength(1);
    expect(sends).toBe(2);
  });

  test.each([
    ['SMS_TOO_LONG', 409, 'Shorten the message or send as normal.'],
    ['ANNOUNCEMENT_NO_RECIPIENTS', 409, 'Nobody would receive this. Choose another audience.'],
  ])('%s → its words', async (code, status, words) => {
    const { routes } = composeRoutes({
      'POST /api/v1/announcements/800/send': () => ({ status, body: errorBody(code, 'x') }),
    });
    await renderSignedIn(<ComposeScreen />, principal(), routes);
    fill();
    fireEvent.press(screen.getByTestId('announce.send'));
    fireEvent.press(await screen.findByTestId('announce.confirm.send'));
    await eventually(() =>
      expect(screen.getByTestId('announce.confirm.message')).toHaveTextContent(words),
    );
  });

  test('a class or section no longer available: one sentence', async () => {
    const { routes } = composeRoutes({
      'POST /api/v1/announcements': () => ({
        status: 422,
        body: errorBody('VALIDATION_FAILED', 'Invalid', {
          fields: [
            { path: 'audiences[0].targetId', code: 'REFERENCE_NOT_FOUND', message: 'not found' },
          ],
        }),
      }),
    });
    await renderSignedIn(<ComposeScreen />, principal(), routes);
    fill();
    fireEvent.press(screen.getByTestId('announce.send'));
    fireEvent.press(await screen.findByTestId('announce.confirm.send'));
    await eventually(() =>
      expect(screen.getByTestId('announce.confirm.message')).toHaveTextContent(
        'That class or section is not available.',
      ),
    );
  });

  test('IDEMPOTENCY_KEY_REUSED: the draft already saved is opened', async () => {
    const { routes } = composeRoutes({
      'POST /api/v1/announcements': () => ({
        status: 409,
        body: errorBody('IDEMPOTENCY_KEY_REUSED', 'reused'),
      }),
      'GET /api/v1/announcements': () =>
        page([announcement({ id: '799', title: 'Another draft' }), announcement()]),
    });
    await renderSignedIn(<ComposeScreen />, principal(), routes);
    fill();
    fireEvent.press(screen.getByTestId('announce.send'));
    fireEvent.press(await screen.findByTestId('announce.confirm.send'));
    // Found by its exact title, not by being first on the page.
    await eventually(() =>
      expect(router.replace).toHaveBeenCalledWith({
        pathname: '/announce/[id]',
        params: { id: '800' },
      }),
    );
  });

  test('IDEMPOTENCY_KEY_REUSED with no draft of that title: the list, never a guess', async () => {
    const { routes } = composeRoutes({
      'POST /api/v1/announcements': () => ({
        status: 409,
        body: errorBody('IDEMPOTENCY_KEY_REUSED', 'reused'),
      }),
      'GET /api/v1/announcements': () => page([announcement({ id: '799', title: 'Another' })]),
    });
    await renderSignedIn(<ComposeScreen />, principal(), routes);
    fill();
    fireEvent.press(screen.getByTestId('announce.send'));
    fireEvent.press(await screen.findByTestId('announce.confirm.send'));
    await eventually(() => expect(router.replace).toHaveBeenCalledWith('/announce'));
  });

  test('after a 429 no preview request goes out until the named wait has passed', async () => {
    let clock = 1_000_000;
    let calls = 0;
    const states: string[] = [];
    const { routes } = composeRoutes({
      'POST /api/v1/announcements/preview-audience': () => {
        calls += 1;
        return calls === 1
          ? {
              status: 429,
              body: errorBody('RATE_LIMITED', 'Too many'),
              headers: { 'Retry-After': '7' },
            }
          : { status: 200, body: previewDto() };
      },
    });
    await renderSignedIn(<ComposeScreen />, principal(), routes);
    const previewer = createPreviewer(
      (state) => states.push(state.kind),
      () => clock,
    );
    const json = JSON.stringify({ audiences: [{ kind: 'everyone' }], priority: 'normal' });
    previewer.want(json);
    await previewer.run(json);
    expect(states).toEqual(['paused']);
    clock += 6_000;
    await previewer.run(json);
    expect(calls).toBe(1);
    clock += 2_000;
    await previewer.run(json);
    expect(calls).toBe(2);
    expect(states).toEqual(['paused', 'ready']);
  });

  test('offline: "Needs a connection", no preview, Send disabled', async () => {
    const { previews, routes } = composeRoutes();
    await renderSignedIn(<ComposeScreen />, principal(), routes);
    setOnline(false);
    fill();
    expect(await screen.findByTestId('announce.offline')).toBeOnTheScreen();
    expect(screen.getByTestId('announce.send')).toBeDisabled();
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(previews).toEqual([]);
  });

  test('a title or message with an identity number or phone is refused before any request', async () => {
    const { creates, routes } = composeRoutes();
    await renderSignedIn(<ComposeScreen />, principal(), routes);
    fill('Call 03001234567', 'Body');
    fireEvent.press(screen.getByTestId('announce.send'));
    expect(
      await screen.findByText('Do not type an identity number or a phone number here.'),
    ).toBeOnTheScreen();
    expect(creates).toEqual([]);
  });
});

describe('the list and one announcement', () => {
  test('usage only with school.settings.manage; status badges; a draft is sent from the list', async () => {
    let sent = false;
    await renderSignedIn(<AnnounceScreen />, principal([Capability.SCHOOL_SETTINGS_MANAGE]), {
      'GET /api/v1/messaging/usage': () => ({
        status: 200,
        body: {
          cap: 1000,
          remaining: 880,
          months: [{ yearMonth: '2026-10', byChannel: [{ channel: 'sms', count: 120 }] }],
        },
      }),
      'GET /api/v1/announcements': () =>
        page([
          announcement(),
          announcement({
            id: '801',
            title: 'Exam week',
            status: 'sent',
            sentAt: '2026-10-03T04:00:00.000Z',
            recipientCount: 83,
          }),
          announcement({ id: '802', title: 'Fees reminder', status: 'sending' }),
        ]),
      'POST /api/v1/announcements/800/send': () => {
        sent = true;
        return { status: 200, body: announcement({ status: 'sent' }) };
      },
    });
    expect(await screen.findByText('SMS this month: 120 of 1000 · 880 left')).toBeOnTheScreen();
    expect(screen.getByText('Draft')).toBeOnTheScreen();
    expect(screen.getByText('Sent')).toBeOnTheScreen();
    expect(screen.getByText('Sending…')).toBeOnTheScreen();
    expect(screen.queryByTestId('announce.sendDraft.801')).toBeNull();
    expect(screen.queryByTestId('announce.sendDraft.802')).toBeNull();
    fireEvent.press(screen.getByTestId('announce.sendDraft.800'));
    await eventually(() => expect(sent).toBe(true));
  });

  test('without school.settings.manage there is no usage card and no usage request', async () => {
    const { fake } = await renderSignedIn(<AnnounceScreen />, principal(), {
      'GET /api/v1/announcements': () => page([]),
    });
    expect(await screen.findByText('No announcements yet.')).toBeOnTheScreen();
    expect(screen.queryByTestId('announce.usage')).toBeNull();
    expect(fake.calls.some((c) => c.path === '/api/v1/messaging/usage')).toBe(false);
  });

  test('a sent announcement: delivery per channel as accepted, delivered, failed, suppressed', async () => {
    const delivery: DeliverySummaryDto = {
      announcementId: '801',
      byChannel: [
        { channel: 'push', accepted: 10, delivered: 9, failed: 1, suppressed: 0 },
        { channel: 'whatsapp', accepted: 40, delivered: 38, failed: 1, suppressed: 2 },
        { channel: 'sms', accepted: 5, delivered: 5, failed: 0, suppressed: 0 },
        { channel: 'email', accepted: 0, delivered: 0, failed: 0, suppressed: 0 },
      ],
      computedAt: '2026-10-04T04:00:00.000Z',
      messages: { delivered: 50, failed: 2, queued: 0, sending: 0, sent: 3, suppressed: 2 },
      recipients: { guardians: 60, staff: 3, students: 20, total: 83 },
      smsSegmentsPerMessage: 1,
      smsUnitsReserved: 5,
      status: 'sent',
      suppressions: [{ reason: 'duplicate_phone', count: 2 }],
    };
    expect(deliveryLines(delivery)[1]).toBe(
      'WhatsApp: 40 accepted · 38 delivered · 1 failed · 2 suppressed',
    );
    await renderSignedIn(<AnnouncementScreen id="801" />, principal(), {
      'GET /api/v1/announcements/801': () => ({
        status: 200,
        body: announcement({ id: '801', status: 'sent', sentAt: '2026-10-03T04:00:00.000Z' }),
      }),
      'GET /api/v1/announcements/801/delivery': () => ({ status: 200, body: delivery }),
    });
    expect(await screen.findByText('83 people')).toBeOnTheScreen();
    expect(
      screen.getByText('SMS: 5 accepted · 5 delivered · 0 failed · 0 suppressed'),
    ).toBeOnTheScreen();
    expect(screen.queryByTestId('announcement.send')).toBeNull();
  });
});

describe('a send that failed five times, and a send in progress (slice-14 change, wave F)', () => {
  test('the list says "Sending failed. Try again." and offers Send', async () => {
    let sent = false;
    await renderSignedIn(<AnnounceScreen />, principal(), {
      'GET /api/v1/announcements': () =>
        page([announcement({ sendFailedAt: '2026-10-04T05:00:00.000Z' })]),
      'POST /api/v1/announcements/800/send': () => {
        sent = true;
        return { status: 200, body: announcement({ status: 'sending' }) };
      },
    });
    expect(await screen.findByText('Sending failed. Try again.')).toBeOnTheScreen();
    fireEvent.press(screen.getByTestId('announce.sendDraft.800'));
    await eventually(() => expect(sent).toBe(true));
  });

  test('the page says so too; a new send shows "Sending…" at once', async () => {
    let sent = false;
    await renderSignedIn(<AnnouncementScreen id="800" />, principal(), {
      // A new send clears sendFailedAt on the server.
      'GET /api/v1/announcements/800': () => ({
        status: 200,
        body: sent
          ? announcement({ status: 'sending' })
          : announcement({ sendFailedAt: '2026-10-04T05:00:00.000Z' }),
      }),
      'POST /api/v1/announcements/800/send': () => {
        sent = true;
        return { status: 200, body: announcement({ status: 'sending' }) };
      },
      'GET /api/v1/announcements/800/delivery': () => ({ status: 200, body: delivery() }),
    });
    expect(await screen.findByTestId('announcement.sendFailed')).toHaveTextContent(
      'Sending failed. Try again.',
    );
    fireEvent.press(screen.getByTestId('announcement.send'));
    await eventually(() =>
      expect(screen.getByTestId('announcement.status')).toHaveTextContent('Sending…'),
    );
    expect(screen.queryByTestId('announcement.sendFailed')).toBeNull();
  });

  test('while sending, the page reads itself again every 3 s; it stops once sent', async () => {
    let reads = 0;
    await renderSignedIn(<AnnouncementScreen id="801" />, principal(), {
      'GET /api/v1/announcements/801': () => {
        reads += 1;
        return {
          status: 200,
          body: announcement({ id: '801', status: reads < 3 ? 'sending' : 'sent' }),
        };
      },
      'GET /api/v1/announcements/801/delivery': () => ({ status: 200, body: delivery() }),
    });
    await screen.findByTestId('announcement.status');
    await eventually(() => expect(reads).toBeGreaterThanOrEqual(3), 9000);
    await eventually(() =>
      expect(screen.getByTestId('announcement.status')).toHaveTextContent('Sent'),
    );
    const settled = reads;
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(reads).toBe(settled);
  }, 20000);
});

test('no announce or inbox source uses the word "read" (R150, plan §0.13)', () => {
  const root = join(__dirname, '..');
  for (const file of [
    'announce/announce-model.ts',
    'announce/AnnounceScreen.tsx',
    'announce/AnnouncementScreen.tsx',
    'announce/ComposeScreen.tsx',
    'inbox/inbox-model.ts',
    'inbox/InboxScreen.tsx',
    'inbox/InboxItemScreen.tsx',
    'app/(tabs)/inbox/index.tsx',
    'app/(tabs)/inbox/[id].tsx',
  ]) {
    const text = readFileSync(join(root, file), 'utf8');
    expect({ file, read: /\bread\b/i.test(text) }).toEqual({ file, read: false });
  }
});
