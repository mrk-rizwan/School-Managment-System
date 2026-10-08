import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { BackHandler, Modal, ScrollView, Text } from 'react-native';
import { ModalSheet } from './ModalSheet';
import { Screen } from './Screen';

// slice-16 §13.2: FLAG_SECURE on every screen that shows a child's name, and on no other. The
// normative list is this table; every route file under (tabs) must be in it, so a new route is a
// decision, not an accident. A route is secure when it renders a screen with the `secure` prop.

const SECURE: Record<string, boolean> = {
  // Teacher (§4)
  'classes/index.tsx': false,
  'classes/[sectionId]/register.tsx': true,
  'classes/[sectionId]/diary/index.tsx': false,
  'classes/[sectionId]/diary/new.tsx': false,
  'classes/[sectionId]/students/index.tsx': true,
  'classes/[sectionId]/students/[studentId].tsx': true,
  // Phase 4 slice 30: Marks — the grid names children; the lists and the test form do not
  'marks/index.tsx': false,
  'marks/[sectionId]/index.tsx': false,
  'marks/[sectionId]/new.tsx': false,
  'marks/test/[id].tsx': true,
  // Slice 31: the term picker names no child; the sheet's preview does.
  'marks/[sectionId]/sheet.tsx': false,
  'marks/sheet/[id].tsx': true,
  // Parent (§5.1–5.4)
  'children/index.tsx': true,
  'children/[studentId]/attendance.tsx': true,
  'children/[studentId]/diary.tsx': true,
  'children/[studentId]/remarks.tsx': true,
  // Phase 3 slice 21: a child's fees and the deposit-slip form (the child's name in the title)
  'children/[studentId]/fees.tsx': true,
  'children/[studentId]/deposit-slip.tsx': true,
  // Student (§5.5)
  'student/index.tsx': true,
  'student/attendance.tsx': true,
  'student/diary.tsx': true,
  'student/remarks.tsx': true,
  // Everyone (§7.3): secure when the user is a guardian (set from capacities at render)
  'inbox/index.tsx': true,
  'inbox/[id].tsx': true,
  // Principal (§7.1, §7.2): no child's name
  'today/index.tsx': false,
  // The register again, in Today's stack (review M2): children's names
  'today/[sectionId]/register.tsx': true,
  'announce/index.tsx': false,
  'announce/new.tsx': false,
  'announce/[id].tsx': false,
  // Phase 3 slice 27: the Approvals tab names children (deposit slips) and shows money and slips
  'approvals/index.tsx': true,
  'approvals/sheet/[id].tsx': true,
  // Not secure: the user's own data, no child's name
  'home/index.tsx': false,
  'home/my-attendance.tsx': false,
  // Phase 3 slice 24: the staff member's own leave, no child's name
  'home/my-leave.tsx': false,
  // Phase 3 slice 25: the staff member's own payslips, no child's name
  'home/my-payslips.tsx': false,
  // Phase 3 slice 23: expense capture, no child's name
  'home/expenses/index.tsx': false,
  'home/expenses/new.tsx': false,
  'calendar.tsx': false,
  'more.tsx': false,
  'account/index.tsx': false,
  'account/change-password.tsx': false,
  'account/sync.tsx': false,
  'account/diagnostics.tsx': false,
};

const tabsDir = join(__dirname, '..', 'app', '(tabs)');

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name.endsWith('.tsx') && name !== '_layout.tsx' ? [path] : [];
  });
}

const rendersSecure = (source: string) => /<\w*Screen\b[^>]*\bsecure\b/.test(source);

test('every route under (tabs) has a decision in the table', () => {
  const onDisk = routeFiles(tabsDir).map((file) => relative(tabsDir, file).replace(/\\/g, '/'));
  expect(onDisk.sort()).toEqual(Object.keys(SECURE).sort());
});

test.each(Object.entries(SECURE))('%s secure: %s', (file, secure) => {
  const source = readFileSync(join(tabsDir, file), 'utf8');
  expect(rendersSecure(source)).toBe(secure);
});

describe('<Screen secure>', () => {
  test('prevents screen capture while mounted and allows it again on unmount', () => {
    const view = render(
      <Screen secure>
        <Text>Ali</Text>
      </Screen>,
    );
    expect(preventScreenCaptureAsync).toHaveBeenCalledTimes(1);
    const key = (preventScreenCaptureAsync as jest.Mock).mock.calls[0][0] as string;
    expect(allowScreenCaptureAsync).not.toHaveBeenCalled();
    view.unmount();
    expect(allowScreenCaptureAsync).toHaveBeenCalledWith(key);
  });

  test('a screen without it never touches the flag', () => {
    const view = render(
      <Screen>
        <Text>Home</Text>
      </Screen>,
    );
    view.unmount();
    expect(preventScreenCaptureAsync).not.toHaveBeenCalled();
    expect(allowScreenCaptureAsync).not.toHaveBeenCalled();
  });

  // Slice-27 review: a React Native <Modal> is its own Android window, outside the Activity's
  // FLAG_SECURE, so a slip or receipt in it could be captured. The sheet is drawn in the screen's
  // own tree, over the whole screen (not inside the scrolling content), and Back closes it.
  test('a sheet on a secure screen is drawn inside the screen tree, never in a Modal; Back closes it', () => {
    const back = jest.spyOn(BackHandler, 'addEventListener');
    const onClose = jest.fn();
    render(
      <Screen secure testID="slip.screen">
        <Text>Ali</Text>
        <ModalSheet visible title="Deposit slip" onClose={onClose} testID="slip.sheet">
          <Text>Rs 3,500</Text>
        </ModalSheet>
      </Screen>,
    );
    expect(screen.UNSAFE_queryAllByType(Modal)).toHaveLength(0);
    const sheet = within(screen.getByTestId('slip.screen')).getByTestId('slip.sheet');
    expect(within(sheet).getByText('Rs 3,500')).toBeOnTheScreen();
    // The first ScrollView is the screen's own content; the sheet is not inside it.
    expect(within(screen.UNSAFE_getAllByType(ScrollView)[0]!).queryByTestId('slip.sheet')).toBeNull();
    expect(preventScreenCaptureAsync).toHaveBeenCalled();

    const handler = back.mock.calls.at(-1)![1];
    expect(handler({ type: 'hardwareBackPress', timeStamp: 0 })).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId('slip.sheet.close'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

afterEach(() => jest.clearAllMocks());
