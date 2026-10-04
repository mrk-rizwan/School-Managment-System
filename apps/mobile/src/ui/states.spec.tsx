import { ApiError, ErrorCode } from '@asms/shared';
import { fireEvent, render, screen } from '@testing-library/react-native';
import {
  EmptyState,
  ErrorState,
  formatAsOf,
  LoadingState,
  NoPermissionState,
  OfflineNotice,
} from './states';

// slice-15 §11: the four states and the offline notice, with "as of" in school time.

describe('the four states', () => {
  test('loading', () => {
    render(<LoadingState />);
    expect(screen.getByTestId('state.loading')).toBeOnTheScreen();
  });

  test('empty', () => {
    render(<EmptyState title="No holidays this month" />);
    expect(screen.getByText('No holidays this month')).toBeOnTheScreen();
  });

  test('error with the API message, and retry', () => {
    const retry = jest.fn();
    render(
      <ErrorState
        error={new ApiError(409, ErrorCode.STALE_STATUS, 'Changed by someone else.', null, null)}
        onRetry={retry}
      />,
    );
    expect(screen.getByText('Changed by someone else.')).toBeOnTheScreen();
    fireEvent.press(screen.getByTestId('state.retry'));
    expect(retry).toHaveBeenCalled();
  });

  test('error without a response says the school cannot be reached', () => {
    render(<ErrorState error={new TypeError('Network request failed')} />);
    expect(
      screen.getByText('Cannot reach the school. Check your connection and try again.'),
    ).toBeOnTheScreen();
  });

  test('no permission', () => {
    render(<NoPermissionState />);
    expect(screen.getByText('You do not have access')).toBeOnTheScreen();
  });
});

describe('"as of" in school time (Asia/Karachi)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-04T06:00:00.000Z'));
  });
  afterEach(() => jest.useRealTimers());

  test('today: the time only', () => {
    // 04:32 UTC is 09:32 in Karachi.
    expect(formatAsOf('2026-10-04T04:32:00.000Z')).toBe('as of 09:32');
  });

  test('an earlier day: with the date', () => {
    expect(formatAsOf('2026-10-02T04:32:00.000Z')).toBe('as of 2 Oct 2026, 09:32');
  });

  test('device time is flagged', () => {
    expect(formatAsOf('2026-10-04T04:32:00.000Z', true)).toBe('as of 09:32 (device time)');
  });

  test('the offline notice shows it', () => {
    render(<OfflineNotice serverTime="2026-10-04T04:32:00.000Z" />);
    expect(screen.getByTestId('state.offline')).toHaveTextContent(
      'Offline — showing what was saved, as of 09:32.',
    );
  });
});
