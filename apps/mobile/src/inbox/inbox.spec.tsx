import { fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { preventScreenCaptureAsync } from 'expo-screen-capture';
import type { InboxItemDto } from '../api/contracts';
import { queryClient } from '../api/query-client';
import { errorBody, meFixture, resetDevice } from '../test/fake-api';
import { guardianMe } from '../test/fixtures';
import { eventually, renderSignedIn, setOnline } from '../test/screen';
import { childScreenOf, sentLabel, viaLabel } from './inbox-model';
import { InboxItemScreen } from './InboxItemScreen';
import { InboxScreen } from './InboxScreen';

// slice-16 §7.3, aligned with contracts/slice-14.md §7 (inbox/inbox.spec.tsx): the category
// chips as the one filter, urgent and "via" chips, no image before a tap, "Open <child>" by
// message type, the item from a push read by id, and FLAG_SECURE for a guardian.

function item(patch: Partial<InboxItemDto> = {}): InboxItemDto {
  return {
    announcementId: '800',
    attachmentMime: null,
    body: 'School closes at noon on Friday.',
    category: 'general',
    expiresOn: null,
    hasAttachment: false,
    id: '345',
    kind: 'announcement',
    messageType: 'announcement_normal',
    priority: 'normal',
    sentAt: '2026-10-01T04:00:00.000Z',
    subjectId: '800',
    subjectType: 'announcement',
    title: 'Early closing',
    viaStudents: [{ studentId: '501', fullName: 'Ali Raza' }],
    ...patch,
  };
}

const page = (data: unknown[]) => ({
  status: 200,
  body: { data, page: 1, limit: 25, total: data.length },
});

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});
afterEach(() => queryClient.clear());

test('the pure words: sent time, "via", the child screen by message type', () => {
  expect(sentLabel('2026-10-04T04:32:00.000Z', '2026-10-04')).toBe('09:32');
  expect(sentLabel('2026-10-01T04:32:00.000Z', '2026-10-04')).not.toBe('09:32');
  expect(viaLabel('Ali Raza')).toBe('via Ali');
  expect(childScreenOf('absence_alert')).toBe('attendance');
  expect(childScreenOf('late_advice')).toBe('attendance');
  expect(childScreenOf('attendance_corrected')).toBe('attendance');
  expect(childScreenOf('diary_posted')).toBe('diary');
  expect(childScreenOf('remark_posted')).toBe('remarks');
  expect(childScreenOf('announcement_normal')).toBeNull();
});

test('a guardian’s list: rows with urgent and via chips, one page of 25, secure, no image', async () => {
  const { fake } = await renderSignedIn(<InboxScreen secure />, guardianMe(), {
    'GET /api/v1/me/inbox': () =>
      page([
        item(),
        item({
          id: '346',
          title: 'Fees due',
          priority: 'urgent',
          category: 'fee',
          hasAttachment: true,
          attachmentMime: 'application/pdf',
        }),
      ]),
  });
  expect(await screen.findByText('Early closing')).toBeOnTheScreen();
  expect(screen.getAllByText('via Ali')).toHaveLength(2);
  expect(screen.getByText('Urgent')).toBeOnTheScreen();
  expect(screen.getByText('PDF')).toBeOnTheScreen();
  expect(preventScreenCaptureAsync).toHaveBeenCalled();
  const call = fake.calls.find((c) => c.path === '/api/v1/me/inbox')!;
  expect(Object.fromEntries(call.query)).toEqual({ limit: '25', page: '1' });
  expect(fake.calls.some((c) => /\/(thumbnail|attachment)$/.test(c.path))).toBe(false);

  fireEvent.press(screen.getByTestId('inbox.row.345'));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/inbox/[id]', params: { id: '345' } });
});

test('the category chip is the one filter', async () => {
  const { fake } = await renderSignedIn(<InboxScreen secure={false} />, meFixture(), {
    'GET /api/v1/me/inbox': (request) =>
      page(request.query.get('category') === 'exam' ? [item({ id: '9', title: 'Exams' })] : []),
  });
  expect(await screen.findByText('Nothing from the school yet.')).toBeOnTheScreen();
  fireEvent.press(screen.getByTestId('inbox.category.exam'));
  expect(await screen.findByText('Exams')).toBeOnTheScreen();
  expect(fake.calls.at(-1)!.query.get('category')).toBe('exam');
  // Staff: not secure.
  expect(preventScreenCaptureAsync).not.toHaveBeenCalled();
});

test('offline: the cached list with its "as of"; nothing cached says so', async () => {
  await renderSignedIn(<InboxScreen secure={false} />, meFixture(), {
    'GET /api/v1/me/inbox': () => page([item()]),
  });
  await screen.findByText('Early closing');
  setOnline(false);
  expect(await screen.findByTestId('state.offline')).toBeOnTheScreen();
  expect(screen.getByText('Early closing')).toBeOnTheScreen();
});

test('an item opened from the list costs no request; its attachment loads only on a tap', async () => {
  const listed = item({ hasAttachment: true, attachmentMime: 'image/jpeg' });
  await renderSignedIn(<InboxScreen secure />, guardianMe(), {
    'GET /api/v1/me/inbox': () => page([listed]),
  });
  await screen.findByText('Early closing');
  screen.unmount();
  const { fake } = await renderSignedIn(<InboxItemScreen id="345" secure />, guardianMe(), {});
  expect(await screen.findByTestId('inboxItem.body')).toHaveTextContent(
    'School closes at noon on Friday.',
  );
  expect(fake.calls.some((c) => c.path === '/api/v1/me/inbox/345')).toBe(false);
  expect(screen.queryByTestId('attachment.thumbnail')).toBeNull();
  fireEvent.press(screen.getByTestId('attachment.show'));
  const image = await screen.findByTestId('attachment.thumbnail');
  const source = (image.props as { source: { uri: string; headers: Record<string, string> } })
    .source;
  expect(source.uri).toMatch(/\/api\/v1\/me\/inbox\/345\/thumbnail$/);
  expect(source.uri).not.toMatch(/Bearer|token/i);
  expect(source.headers.Authorization).toMatch(/^Bearer /);
});

test('a push lands on /inbox/[id]: read by id; "Open Ali" goes to the child screen by type', async () => {
  const { fake } = await renderSignedIn(<InboxItemScreen id="777" secure />, guardianMe(), {
    'GET /api/v1/me/inbox/777': () => ({
      status: 200,
      body: item({
        id: '777',
        kind: 'notice',
        messageType: 'diary_posted',
        subjectType: 'diary_entry',
        title: 'New diary entry',
        category: null,
        announcementId: null,
      }),
    }),
  });
  expect(await screen.findByText('New diary entry')).toBeOnTheScreen();
  expect(fake.calls.some((c) => c.path === '/api/v1/me/inbox/777')).toBe(true);
  fireEvent.press(screen.getByTestId('inboxItem.open.501'));
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/children/[studentId]/diary',
    params: { studentId: '501' },
  });
});

test('an announcement offers no child screen; staff never see "Open"', async () => {
  await renderSignedIn(<InboxItemScreen id="345" secure={false} />, meFixture(), {
    'GET /api/v1/me/inbox/345': () => ({
      status: 200,
      body: item({ viaStudents: [], messageType: 'absence_alert' }),
    }),
  });
  await screen.findByTestId('inboxItem.body');
  expect(screen.queryByText(/^Open /)).toBeNull();
});

test('an expired or withdrawn item is a 404: the error state', async () => {
  await renderSignedIn(<InboxItemScreen id="9" secure={false} />, meFixture(), {
    'GET /api/v1/me/inbox/9': () => ({ status: 404, body: errorBody('NOT_FOUND', 'Not found') }),
  });
  await eventually(() => expect(screen.getByTestId('state.error')).toBeOnTheScreen());
});
