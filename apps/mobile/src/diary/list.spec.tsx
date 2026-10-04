import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { queryClient } from '../api/query-client';
import { queryKeys } from '../api/query-keys';
import { listLocalDiaryEntries, saveDiaryEntry } from '../db/local.repository';
import { listByState } from '../db/outbox.repository';
import { errorBody, resetDevice, type Handler } from '../test/fake-api';
import { DOCUMENT, putFile } from '../test/file-system';
import { diaryEntry, teacherMe, TODAY } from '../test/fixtures';
import { eventually, renderSignedIn, setOnline, settleOutbox } from '../test/screen';
import { weekWindow } from './dates';
import { SectionDiaryScreen } from './SectionDiaryScreen';

// slice-16 §4.4 (diary/list.spec.tsx): the section's diary with this phone's unsent entries.

const LIST = 'GET /api/v1/sections/12/diary-entries';
const CREATE = 'POST /api/v1/sections/12/diary-entries';

const page = (data: unknown[]) => ({
  status: 200,
  body: { data, page: 1, limit: 25, total: data.length },
});

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});
afterEach(() => queryClient.clear());

async function mount(routes: Record<string, Handler>) {
  const result = await renderSignedIn(<SectionDiaryScreen sectionId="12" />, teacherMe(), routes);
  await screen.findByTestId('diary.screen');
  return result;
}

test('this week from Monday to today, rows with subject, topic, due date, "edited", and a photo marker — no image', async () => {
  const { fake } = await mount({
    [LIST]: () =>
      page([
        diaryEntry({
          dueOn: TODAY,
          attachmentMime: 'image/jpeg',
          hasAttachment: true,
          updatedAt: '2026-10-04T05:00:00.000Z',
        }),
      ]),
  });
  const row = await screen.findByTestId('diary.entry.300');
  expect(row).toHaveTextContent(/English/);
  expect(row).toHaveTextContent(/Reading: chapter 3/);
  expect(row).toHaveTextContent(/Due /);
  expect(row).toHaveTextContent(/edited/);
  expect(row).toHaveTextContent(/Photo/);
  const call = fake.calls.find((c) => c.path === '/api/v1/sections/12/diary-entries')!;
  expect(call.query.get('dateFrom')).toBe(weekWindow(TODAY, 0).dateFrom);
  expect(call.query.get('dateTo')).toBe(TODAY);
  expect(call.query.get('limit')).toBe('25');
  expect(fake.calls.some((c) => /\/(thumbnail|attachment)$/.test(c.path))).toBe(false);
});

test('"Earlier" adds the week before as its own read', async () => {
  const { fake } = await mount({ [LIST]: () => page([]) });
  fireEvent.press(await screen.findByTestId('diary.earlier'));
  await screen.findByTestId('diary.week.1');
  const froms = fake.calls
    .filter((c) => c.path.endsWith('/diary-entries'))
    .map((c) => c.query.get('dateFrom'));
  expect(froms).toEqual([weekWindow(TODAY, 0).dateFrom, weekWindow(TODAY, 1).dateFrom]);
});

test('an entry written offline shows "Saved on device" above the server rows, then "Saved on server"', async () => {
  await mount({
    [LIST]: () => page([]),
    [CREATE]: () => ({ status: 201, body: { id: '301', sectionId: '12' } }),
  });
  setOnline(false);
  const { localEntryId } = await saveDiaryEntry(
    '12',
    { date: TODAY, subjectId: '7', topic: 'Pages 12–14' },
    null,
  );
  await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.local }));
  await eventually(() =>
    expect(screen.getByTestId(`diary.local.${localEntryId}.state`)).toHaveTextContent(
      'Saved on device',
    ),
  );
  setOnline(true);
  await settleOutbox();
  await eventually(() =>
    expect(screen.getByTestId(`diary.local.${localEntryId}.state`)).toHaveTextContent(
      /Saved on server at/,
    ),
  );
});

test('DIARY_ENTRY_EXISTS: "Open the existing entry" re-targets the waiting photo to it', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
    buttons?.find((b) => b.text === 'Attach')?.onPress?.();
  });
  await mount({
    [LIST]: () => page([diaryEntry()]),
    [CREATE]: () => ({
      status: 409,
      body: errorBody('DIARY_ENTRY_EXISTS', 'Already written for this date and subject.', {
        entryId: '300',
      }),
    }),
    'POST /api/v1/uploads': () => 'network',
  });
  // After startup (its sweep deletes files no row points at): the photo the teacher just took.
  putFile(`${DOCUMENT}outbox/p1.jpg`);
  const { localEntryId } = await saveDiaryEntry(
    '12',
    { date: TODAY, subjectId: '7', topic: 'Reading again' },
    { id: 'p1', fileName: 'p1.jpg', mime: 'image/jpeg', sizeBytes: 1000 },
  );
  await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.local }));
  await settleOutbox();
  await eventually(() =>
    expect(screen.getByTestId(`diary.local.${localEntryId}.state`)).toHaveTextContent(
      'Not saved: Already written for this date and subject.',
    ),
  );
  fireEvent.press(screen.getByTestId(`diary.local.${localEntryId}`));
  const sheet = await screen.findByTestId('diary.entrySheet');
  fireEvent.press(within(sheet).getByTestId('diary.remedy.open'));
  await eventually(() => expect(alert).toHaveBeenCalled());
  await eventually(async () => {
    const photo = (await listByState('pending')).find((i) => i.lane === 'diary_attachment');
    expect(photo?.path).toBe('/api/v1/diary-entries/300');
  });
  expect(alert).toHaveBeenCalledWith(
    'Attach to the existing entry?',
    expect.any(String),
    expect.any(Array),
  );
  expect((await listLocalDiaryEntries('12'))[0]).toMatchObject({
    state: 'superseded_by_server',
    serverId: '300',
  });
});

test('the entry sheet loads the attachment only on a tap, with the bearer in a header', async () => {
  await mount({
    [LIST]: () =>
      page([
        diaryEntry({
          attachmentMime: 'image/png',
          hasAttachment: true,
          attachmentSizeBytes: 1_258_291,
        }),
      ]),
  });
  fireEvent.press(await screen.findByTestId('diary.entry.300'));
  const sheet = await screen.findByTestId('diary.entrySheet');
  expect(within(sheet).queryByTestId('attachment.thumbnail')).toBeNull();
  expect(within(sheet).getByText('1.2 MB — opens on tap')).toBeOnTheScreen();
  fireEvent.press(within(sheet).getByTestId('attachment.show'));
  const image = within(sheet).getByTestId('attachment.thumbnail');
  expect(image.props.source).toEqual({
    uri: 'http://api.test/api/v1/diary-entries/300/thumbnail',
    headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Bearer /) }),
  });
});
