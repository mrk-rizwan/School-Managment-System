import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { queryKeys } from '../api/query-keys';
import { useOnline, useOnlineOnly } from '../net/connectivity';
import { ListRow } from '../ui/ListRow';
import { Screen } from '../ui/Screen';
import { Sheet } from '../ui/Sheet';
import { EmptyState, ErrorState, LoadingState } from '../ui/states';
import { colors, fontSize } from '../ui/theme';
import { api, unwrap } from '../api/client';
import { fetchTerms, sheetFailure } from './results';

/** POST /sections/:id/result-sheets: 201 a new sheet, 200 the open one; behind useOnlineOnly. */
const openSheet = (sectionId: string, termId: string | null) =>
  unwrap(
    api.POST('/api/v1/sections/{id}/result-sheets', {
      params: { path: { id: sectionId } },
      body: { termId },
    }),
  );

// /marks/[sectionId]/sheet (slice 31): the class teacher picks the term (or the year's final) and
// the section's sheet opens — created by the POST, or the open one. Online only.

export function SheetPickerScreen({ sectionId, yearId }: { sectionId: string; yearId: string }) {
  const router = useRouter();
  const online = useOnline();
  const gate = useOnlineOnly('open_result_sheet');
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const terms = useQuery({
    queryKey: queryKeys.yearTerms(yearId),
    queryFn: () => fetchTerms(yearId),
    enabled: online && yearId !== '',
  });

  async function open(termId: string | null) {
    if (!gate.enabled || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const sheet = await openSheet(sectionId, termId);
      router.push({ pathname: '/marks/sheet/[id]', params: { id: sheet.id } });
    } catch (error) {
      setFailure(sheetFailure(error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title="Result sheet" testID="sheetPicker.screen">
      {!online ? (
        <EmptyState
          title="Needs a connection"
          description="Result sheets are opened online only."
        />
      ) : terms.isPending ? (
        <LoadingState />
      ) : terms.isError ? (
        <ErrorState error={terms.error} onRetry={() => void terms.refetch()} />
      ) : (
        <Sheet title="Which term?">
          {terms.data.map((t) => (
            <ListRow
              key={t.id}
              title={t.name}
              detail={`${t.startsOn} to ${t.endsOn}`}
              onPress={() => void open(t.id)}
              testID={`sheetPicker.term.${t.id}`}
            />
          ))}
          <ListRow
            title="Final result"
            detail="The whole year, once its terms are published"
            onPress={() => void open(null)}
            testID="sheetPicker.final"
          />
        </Sheet>
      )}
      {failure !== null ? (
        <Text style={styles.error} testID="sheetPicker.failure">
          {failure}
        </Text>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  error: { fontSize: fontSize.small, color: colors.destructive },
});
