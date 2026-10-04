import { formatDay } from '@asms/shared';
import { ListRow } from './ListRow';
import { ModalSheet } from './ModalSheet';

/** The last `days` school days counted back from `today`, newest first (YYYY-MM-DD, UTC math). */
export function lastDays(today: string, days = 30): string[] {
  const start = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: days + 1 }, (_, back) =>
    new Date(start - back * 86_400_000).toISOString().slice(0, 10),
  );
}

/**
 * A date, on or before today and at most 30 days back (slice-16 §12): a list, not a calendar
 * widget. The server is the judge of the academic year and the teaching day.
 */
export function DateSheet({
  visible,
  today,
  value,
  onPick,
  onClose,
  title = 'Date',
}: {
  visible: boolean;
  today: string;
  value: string;
  onPick: (date: string) => void;
  onClose: () => void;
  title?: string;
}) {
  return (
    <ModalSheet visible={visible} title={title} onClose={onClose} testID="dateSheet">
      {lastDays(today).map((date) => (
        <ListRow
          key={date}
          title={date === today ? `Today, ${formatDay(date)}` : formatDay(date)}
          value={date === value ? 'Chosen' : null}
          onPress={() => onPick(date)}
          testID={`dateSheet.${date}`}
        />
      ))}
    </ModalSheet>
  );
}
