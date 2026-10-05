import { Capability, formatDay, todayInSchool } from '@asms/shared';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { api, isNetworkError, unwrap, unwrapWithDate } from '../api/client';
import type { DiaryEntryDto } from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { useSession } from '../auth/session';
import {
  discardItem,
  listLocalDiaryEntries,
  supersedeByServerEntry,
  type LocalDiaryEntry,
} from '../db/local.repository';
import { useCachedQuery } from '../db/use-cached-query';
import { useOnline } from '../net/connectivity';
import { remedyFor } from '../outbox/lanes';
import { outboxWorker, useLocalQuery } from '../outbox/runtime';
import { weekWindow } from '../platform/dates';
import { log } from '../platform/log';
import { errorFields } from '../platform/scrub';
import { Button } from '../ui/Button';
import { ListRow } from '../ui/ListRow';
import { Screen } from '../ui/Screen';
import { Sheet } from '../ui/Sheet';
import { localState, StateLine } from '../ui/StateLine';
import { EmptyState, OfflineNotice } from '../ui/states';
import { SyncChip } from '../ui/SyncChip';
import { colors, fontSize, space } from '../ui/theme';
import { DiaryEntrySheet, DiaryWindow, dueLine, entryView } from './DiaryEntrySheet';

// A section's diary — /classes/[sectionId]/diary (slice-16 §4.4). This week first, "Earlier"
// adds the week before (its own cached key). Entries written on this phone and not yet on the
// server are listed with their state line. No child's name appears: not secure.

type Page = { data: DiaryEntryDto[] };

function DiaryWeek({
  sectionId,
  back,
  onOpen,
  hide,
  onCount,
}: {
  sectionId: string;
  back: number;
  onOpen: (entry: DiaryEntryDto) => void;
  /** Server ids already shown as this phone's own rows. */
  hide: ReadonlySet<string>;
  /** How many entries the week holds, once it is loaded. */
  onCount: (back: number, count: number) => void;
}) {
  const { dateFrom, dateTo } = weekWindow(todayInSchool(), back);
  const query = useCachedQuery<Page>(
    queryKeys.sectionDiary(sectionId, dateFrom, dateTo, 1),
    `/api/v1/sections/${sectionId}/diary-entries`,
    { dateFrom, dateTo, limit: 25, page: 1 },
    () =>
      unwrapWithDate(
        api.GET('/api/v1/sections/{id}/diary-entries', {
          params: { path: { id: sectionId }, query: { dateFrom, dateTo, limit: 25, page: 1 } },
        }),
      ),
  );
  const count = query.data?.body.data.length;
  useEffect(() => {
    if (count !== undefined) onCount(back, count);
  }, [back, count, onCount]);
  return (
    <DiaryWindow
      query={query}
      range={{ dateFrom, dateTo }}
      hide={hide}
      rowTitle={(entry) => `${formatDay(entry.date)} · ${entry.subjectName}`}
      showEdited
      onOpen={onOpen}
      testID={`diary.week.${back}`}
      entryTestID={(entry) => `diary.entry.${entry.id}`}
      offlineMessage="This week's diary is not on this phone yet."
    />
  );
}

export function SectionDiaryScreen({
  sectionId,
  classId,
}: {
  sectionId: string;
  classId?: string;
}) {
  const router = useRouter();
  const online = useOnline();
  const { me } = useSession();
  const [weeks, setWeeks] = useState(1);
  // Entries per loaded week: "No entries." once every week shown is loaded and empty.
  const [counts, setCounts] = useState<Record<number, number>>({});
  const onCount = useCallback(
    (back: number, count: number) =>
      setCounts((known) => (known[back] === count ? known : { ...known, [back]: count })),
    [],
  );
  const noEntries = Array.from({ length: weeks }, (_, back) => counts[back]).every((n) => n === 0);
  const [open, setOpen] = useState<DiaryEntryDto | null>(null);
  const [openLocal, setOpenLocal] = useState<LocalDiaryEntry | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const local = useLocalQuery(queryKeys.localDiary(sectionId), () =>
    listLocalDiaryEntries(sectionId),
  );
  const localEntries = (local.data ?? []).filter((entry) => entry.state !== 'superseded_by_server');
  // A local entry the server has confirmed is shown once — as the phone's row with its state.
  const hide = new Set(localEntries.flatMap((e) => (e.serverId ? [e.serverId] : [])));
  const canWrite = me?.body.capabilities.includes(Capability.DIARY_WRITE) ?? false;

  async function openExisting(entry: LocalDiaryEntry) {
    setMessage(null);
    try {
      const page = await unwrap(
        api.GET('/api/v1/sections/{id}/diary-entries', {
          params: {
            path: { id: sectionId },
            query: {
              dateFrom: entry.date,
              dateTo: entry.date,
              subjectId: entry.subjectId,
              limit: 25,
            },
          },
        }),
      );
      const existing = page.data[0];
      if (existing === undefined) {
        setMessage('The existing entry could not be found. Pull to refresh and try again.');
        return;
      }
      const retarget = async (attach: boolean) => {
        await supersedeByServerEntry(entry.id, existing.id, attach);
        setOpenLocal(null);
        setOpen(existing);
        await local.refetch();
        if (attach) void outboxWorker.trigger('enqueued');
      };
      if (entry.photo?.state === 'waiting') {
        Alert.alert('Attach to the existing entry?', 'Your photo has not been sent yet.', [
          { text: 'Discard photo', style: 'destructive', onPress: () => void retarget(false) },
          { text: 'Attach', onPress: () => void retarget(true) },
        ]);
      } else await retarget(false);
    } catch (error) {
      if (isNetworkError(error)) {
        setMessage('No connection. Opening the existing entry needs a connection.');
      } else {
        log('error', 'diary.open_existing_failed', errorFields(error));
        setMessage('The existing entry could not be opened. Try again.');
      }
    }
  }

  function discard(entry: LocalDiaryEntry) {
    if (entry.outbox === null) return;
    const outboxId = entry.outbox.id;
    Alert.alert('Discard this entry?', 'It has not reached the school and will be lost.', [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: () =>
          void discardItem(outboxId).then(() => {
            setOpenLocal(null);
            return local.refetch();
          }),
      },
    ]);
  }

  const localState_ = (entry: LocalDiaryEntry) => localState(entry.outbox, entry.savedOnServerAt);
  const remedyOf = (entry: LocalDiaryEntry) =>
    entry.outbox?.state === 'failed' ? remedyFor('diary_entry', entry.outbox.responseCode) : null;

  return (
    <Screen
      title="Diary"
      accessory={<SyncChip />}
      banner={!online ? <OfflineNotice serverTime={null} /> : null}
      testID="diary.screen"
      footer={
        canWrite ? (
          <Button
            label="New entry"
            onPress={() =>
              router.push({
                pathname: '/classes/[sectionId]/diary/new',
                params: { sectionId, ...(classId ? { classId } : {}) },
              })
            }
            testID="diary.new"
          />
        ) : null
      }
    >
      {localEntries.length > 0 ? (
        <Sheet title="On this phone" testID="diary.local">
          {localEntries.map((entry) => (
            <View key={entry.id} style={styles.localRow}>
              <ListRow
                title={`${formatDay(entry.date)} · ${entry.topic}`}
                detail={dueLine(entry.dueOn)}
                value={entry.photo ? 'Photo' : null}
                onPress={() => setOpenLocal(entry)}
                testID={`diary.local.${entry.id}`}
              />
              <StateLine state={localState_(entry)} testID={`diary.local.${entry.id}.state`} />
              {entry.photo && entry.photo.state !== 'done' ? (
                <StateLine
                  state={
                    entry.photo.state === 'waiting'
                      ? { kind: 'device', retryInMinutes: null }
                      : localState(entry.photo.outbox, null)
                  }
                  testID={`diary.local.${entry.id}.photo`}
                />
              ) : null}
            </View>
          ))}
        </Sheet>
      ) : null}
      {Array.from({ length: weeks }, (_, back) => (
        <DiaryWeek
          key={back}
          sectionId={sectionId}
          back={back}
          onOpen={setOpen}
          hide={hide}
          onCount={onCount}
        />
      ))}
      <Button
        label="Earlier"
        variant="secondary"
        onPress={() => setWeeks(weeks + 1)}
        testID="diary.earlier"
      />
      {localEntries.length === 0 && noEntries ? <EmptyState title="No entries." /> : null}

      <DiaryEntrySheet
        entry={open ? entryView(open, open.subjectName) : null}
        attachmentBase={open ? `/api/v1/diary-entries/${open.id}` : null}
        onClose={() => setOpen(null)}
      />
      <DiaryEntrySheet
        entry={
          openLocal
            ? {
                id: openLocal.id,
                date: openLocal.date,
                heading: 'Diary entry',
                topic: openLocal.topic,
                assignment: openLocal.assignment,
                learningOutcome: openLocal.learningOutcome,
                dueOn: openLocal.dueOn,
                authorName: null,
                edited: false,
                attachmentMime: null,
                attachmentSizeBytes: null,
              }
            : null
        }
        attachmentBase={null}
        onClose={() => setOpenLocal(null)}
      >
        {openLocal ? (
          <View style={styles.remedies}>
            <StateLine state={localState_(openLocal)} testID="diary.localSheet.state" />
            {openLocal.photo ? (
              <Text style={styles.caption}>
                {openLocal.photo.state === 'waiting'
                  ? 'Photo: waiting for its diary entry'
                  : openLocal.photo.state === 'done'
                    ? 'Photo: saved on server'
                    : 'Photo: queued'}
              </Text>
            ) : null}
            {remedyOf(openLocal) === 'open_existing' ? (
              <>
                <Text style={styles.caption}>Already written for this date and subject.</Text>
                <Button
                  label="Open the existing entry"
                  variant="secondary"
                  disabled={!online}
                  onPress={() => void openExisting(openLocal)}
                  testID="diary.remedy.open"
                />
              </>
            ) : null}
            {remedyOf(openLocal) === 'edit_resend' ? (
              <Button
                label="Edit and resend"
                variant="secondary"
                onPress={() => {
                  setOpenLocal(null);
                  router.push({
                    pathname: '/classes/[sectionId]/diary/new',
                    params: { sectionId, resend: openLocal.id, ...(classId ? { classId } : {}) },
                  });
                }}
                testID="diary.remedy.edit"
              />
            ) : null}
            {openLocal.outbox &&
            openLocal.outbox.state !== 'sending' &&
            openLocal.outbox.state !== 'done' ? (
              <Button
                label="Discard"
                variant="destructive"
                onPress={() => discard(openLocal)}
                testID="diary.remedy.discard"
              />
            ) : null}
            {message ? <Text style={styles.error}>{message}</Text> : null}
          </View>
        ) : null}
      </DiaryEntrySheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
  error: { fontSize: fontSize.small, color: colors.destructive },
  localRow: { paddingBottom: space.sm },
  remedies: { gap: space.sm },
});
