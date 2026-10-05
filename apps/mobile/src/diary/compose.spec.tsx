import { Capability } from '@asms/shared';
import { fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { launchImageLibraryAsync } from 'expo-image-picker';
import { ImageManipulator } from 'expo-image-manipulator';
import { queryClient } from '../api/query-client';
import { getAttachment, listLocalDiaryEntries } from '../db/local.repository';
import { listByState } from '../db/outbox.repository';
import { resetDevice } from '../test/fake-api';
import { CACHE, DOCUMENT, fileExists, putFile } from '../test/file-system';
import { assignment, meFixture, teacherMe, TODAY } from '../test/fixtures';
import { eventually, renderSignedIn, setOnline, settleOutbox } from '../test/screen';
import { ownSubjects } from '../classes/subjects';
import { DiaryComposeScreen } from './DiaryComposeScreen';

// slice-16 §4.4, §4.5 (diary/compose.spec.tsx).

const subjects = {
  'GET /api/v1/subjects': () => ({
    status: 200,
    body: {
      data: [
        { id: '7', name: 'English', code: null, archivedAt: null, createdAt: '', updatedAt: '' },
        { id: '8', name: 'Urdu', code: null, archivedAt: null, createdAt: '', updatedAt: '' },
      ],
      page: 1,
      limit: 50,
      total: 2,
    },
  }),
};

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});
afterEach(() => queryClient.clear());

describe('where the subjects come from', () => {
  test('a subject teacher only: their own subjects on the section, no school list', async () => {
    const me = teacherMe({
      assignments: [
        assignment({ role: 'subject_teacher', subjectId: '7', subjectName: 'English' }),
      ],
    });
    expect(ownSubjects(me, Capability.DIARY_WRITE, '12', '20')).toEqual([
      { id: '7', name: 'English' },
    ]);
    const { fake } = await renderSignedIn(
      <DiaryComposeScreen sectionId="12" classId="20" />,
      me,
      subjects,
    );
    expect(await screen.findByTestId('diaryCompose.subject.7')).toBeOnTheScreen();
    expect(screen.queryByTestId('diaryCompose.subject.8')).toBeNull();
    expect(fake.calls.some((c) => c.path === '/api/v1/subjects')).toBe(false);
  });

  test('scope from MeDto.capabilityScopes: school-wide is the school list; none assigned is none', () => {
    const principal = meFixture({ roles: ['principal'], capabilities: [Capability.DIARY_WRITE] });
    expect(ownSubjects(principal, Capability.DIARY_WRITE, '12', '20')).toBe('all');
    // A teacher default with no assignment on the section is not a school-wide grant (rule 13).
    expect(ownSubjects(teacherMe({ assignments: [] }), Capability.DIARY_WRITE, '12', '20')).toEqual(
      [],
    );
    // A subject teacher granted the key school-wide gets the school's list.
    const granted = teacherMe({
      assignments: [
        assignment({ role: 'subject_teacher', subjectId: '7', subjectName: 'English' }),
      ],
    });
    granted.capabilityScopes = granted.capabilityScopes.map((s) =>
      s.capability === Capability.DIARY_WRITE ? { ...s, scope: 'all' as const } : s,
    );
    expect(ownSubjects(granted, Capability.DIARY_WRITE, '12', '20')).toBe('all');
    // A cached /me from before slice 14 has no scopes: the narrower reading.
    const { capabilityScopes: _dropped, ...old } = principal;
    expect(ownSubjects(old as typeof principal, Capability.DIARY_WRITE, '12', '20')).toEqual([]);
  });

  test('a class teacher (or cover): the school list, 50 a page', async () => {
    expect(ownSubjects(teacherMe(), Capability.DIARY_WRITE, '12', '20')).toBe('all');
    const { fake } = await renderSignedIn(
      <DiaryComposeScreen sectionId="12" />,
      teacherMe(),
      subjects,
    );
    expect(await screen.findByTestId('diaryCompose.subject.8')).toBeOnTheScreen();
    expect(fake.calls.find((c) => c.path === '/api/v1/subjects')!.query.get('limit')).toBe('50');
  });
});

test('save: the body, one outbox row whose id is the Idempotency-Key, the local entry "Saved on device"', async () => {
  const { fake } = await renderSignedIn(<DiaryComposeScreen sectionId="12" />, teacherMe(), {
    ...subjects,
    'POST /api/v1/sections/12/diary-entries': () => ({
      status: 201,
      body: { id: '300', sectionId: '12' },
    }),
  });
  setOnline(false);
  fireEvent.press(await screen.findByTestId('diaryCompose.subject.7'));
  fireEvent.changeText(screen.getByTestId('diaryCompose.topic'), 'Pages 12–14');
  fireEvent.changeText(screen.getByTestId('diaryCompose.assignment'), 'Exercise 4');
  fireEvent.press(screen.getByTestId('diaryCompose.save'));
  await eventually(() => expect(router.back).toHaveBeenCalled());
  const [item] = await listByState('pending');
  expect(JSON.parse(item!.body)).toEqual({
    date: TODAY,
    subjectId: '7',
    topic: 'Pages 12–14',
    assignment: 'Exercise 4',
  });
  const [entry] = await listLocalDiaryEntries('12');
  expect(entry).toMatchObject({ topic: 'Pages 12–14', state: 'queued', outbox: { id: item!.id } });
  setOnline(true);
  await settleOutbox();
  const post = fake.calls.find((c) => c.method === 'POST')!;
  expect(post.headers.get('Idempotency-Key')).toBe(item!.id);
  expect(post.body).not.toHaveProperty('stagedUploadId');
});

test('a photo is downscaled, stored in the app folder, and waits in the same transaction', async () => {
  putFile(`${CACHE}ImagePicker/pick.jpg`, 4_000_000);
  (launchImageLibraryAsync as jest.Mock).mockResolvedValueOnce({
    canceled: false,
    assets: [
      { uri: `${CACHE}ImagePicker/pick.jpg`, width: 4000, height: 3000, mimeType: 'image/jpeg' },
    ],
  });
  await renderSignedIn(<DiaryComposeScreen sectionId="12" />, teacherMe(), subjects);
  setOnline(false);
  fireEvent.press(await screen.findByTestId('diaryCompose.subject.7'));
  fireEvent.changeText(screen.getByTestId('diaryCompose.topic'), 'Board work');
  fireEvent.press(screen.getByTestId('diaryCompose.library'));
  expect(await screen.findByTestId('diaryCompose.photoChosen')).toBeOnTheScreen();
  const manipulate = ImageManipulator.manipulate as jest.Mock;
  expect(manipulate.mock.results[0]!.value.resizes).toEqual([{ width: 1600 }]);
  // The picker's own copy is gone; nothing went to the camera roll.
  expect(fileExists(`${CACHE}ImagePicker/pick.jpg`)).toBe(false);
  fireEvent.press(screen.getByTestId('diaryCompose.save'));
  await eventually(() => expect(router.back).toHaveBeenCalled());
  const [entry] = await listLocalDiaryEntries('12');
  expect(entry!.photo).toMatchObject({ state: 'waiting', outboxId: null, mime: 'image/jpeg' });
  expect(fileExists(`${DOCUMENT}outbox/${entry!.photo!.fileName}`)).toBe(true);
  expect(await getAttachment(entry!.photo!.id)).not.toBeNull();
  // Only the entry is queued; the photo goes once the entry has a server id.
  expect((await listByState('pending')).map((i) => i.lane)).toEqual(['diary_entry']);
});

test('a photo over 5 MB after downscaling is refused before it is stored', async () => {
  (globalThis as { __manipulatedSize?: number }).__manipulatedSize = 6 * 1024 * 1024;
  try {
    putFile(`${CACHE}ImagePicker/big.jpg`);
    (launchImageLibraryAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [
        { uri: `${CACHE}ImagePicker/big.jpg`, width: 1000, height: 1000, mimeType: 'image/jpeg' },
      ],
    });
    await renderSignedIn(<DiaryComposeScreen sectionId="12" />, teacherMe(), subjects);
    fireEvent.press(await screen.findByTestId('diaryCompose.library'));
    expect(await screen.findByText('Photo too large')).toBeOnTheScreen();
    expect(screen.queryByTestId('diaryCompose.photoChosen')).toBeNull();
  } finally {
    delete (globalThis as { __manipulatedSize?: number }).__manipulatedSize;
  }
});

test('an identity number or a phone in the topic is refused before saving', async () => {
  await renderSignedIn(<DiaryComposeScreen sectionId="12" />, teacherMe(), subjects);
  fireEvent.press(await screen.findByTestId('diaryCompose.subject.7'));
  fireEvent.changeText(screen.getByTestId('diaryCompose.topic'), 'Call 0300 1234567 about Ali');
  fireEvent.press(screen.getByTestId('diaryCompose.save'));
  expect(await screen.findByTestId('diaryCompose.topic.error')).toHaveTextContent(
    'Do not type an identity number or a phone number here.',
  );
  expect(await listByState('pending')).toEqual([]);
});
