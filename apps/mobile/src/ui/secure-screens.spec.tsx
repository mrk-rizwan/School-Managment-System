import { render } from '@testing-library/react-native';
import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Text } from 'react-native';
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
  // Parent (§5.1–5.4)
  'children/index.tsx': true,
  'children/[studentId]/attendance.tsx': true,
  'children/[studentId]/diary.tsx': true,
  'children/[studentId]/remarks.tsx': true,
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
  // Not secure: the user's own data, no child's name
  'home/index.tsx': false,
  'home/my-attendance.tsx': false,
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
});

afterEach(() => jest.clearAllMocks());
