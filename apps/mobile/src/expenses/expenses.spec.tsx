import { Capability } from '@asms/shared';
import { fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { launchCameraAsync } from 'expo-image-picker';
import { queryClient } from '../api/query-client';
import { listLocalExpenses } from '../db/local.repository';
import { listByState } from '../db/outbox.repository';
import { resetDevice } from '../test/fake-api';
import { CACHE, DOCUMENT, fileExists, putFile } from '../test/file-system';
import { meFixture, teacherMe, TODAY } from '../test/fixtures';
import { eventually, renderSignedIn, setOnline, settleOutbox } from '../test/screen';
import { ExpenseComposeScreen } from './ExpenseComposeScreen';
import { ExpensesCard } from './ExpensesCard';
import { ExpensesScreen } from './ExpensesScreen';

// Phase 3 slice 23 (§3.9, R207): an expense and its receipt captured offline.

const clerk = () => meFixture({ roles: ['office_staff'], capabilities: [Capability.EXPENSE_RECORD] });

beforeEach(async () => {
  await resetDevice();
  setOnline(true);
});
afterEach(() => queryClient.clear());

test('only an expense.record holder sees the Home card', async () => {
  await renderSignedIn(<ExpensesCard />, teacherMe(), {});
  expect(screen.queryByTestId('home.expenses')).toBeNull();
  await renderSignedIn(<ExpensesCard />, clerk(), {});
  fireEvent.press(await screen.findByTestId('home.expenses.open'));
  expect(router.push).toHaveBeenCalledWith('/home/expenses');
});

test('save offline: the body, one outbox row whose id is the Idempotency-Key; the receipt waits', async () => {
  putFile(`${CACHE}ImagePicker/bill.jpg`, 900_000);
  (launchCameraAsync as jest.Mock).mockResolvedValueOnce({
    canceled: false,
    assets: [{ uri: `${CACHE}ImagePicker/bill.jpg`, width: 1200, height: 1600, mimeType: 'image/jpeg' }],
  });
  const { fake } = await renderSignedIn(<ExpenseComposeScreen />, clerk(), {
    'POST /api/v1/expenses': () => ({
      status: 201,
      body: { id: '900', expenseNo: 4, status: 'recorded' },
    }),
  });
  setOnline(false);
  fireEvent.press(await screen.findByTestId('expenseCompose.category.stationery'));
  fireEvent.changeText(screen.getByTestId('expenseCompose.amount'), '450');
  fireEvent.changeText(screen.getByTestId('expenseCompose.description'), 'Chalk and dusters');
  fireEvent.changeText(screen.getByTestId('expenseCompose.payee'), 'Ali Traders');
  fireEvent.press(screen.getByTestId('expenseCompose.camera'));
  expect(await screen.findByTestId('expenseCompose.receiptChosen')).toBeOnTheScreen();
  fireEvent.press(screen.getByTestId('expenseCompose.save'));
  await eventually(() => expect(router.back).toHaveBeenCalled());

  const [item] = await listByState('pending');
  expect(item!.lane).toBe('expense');
  expect(JSON.parse(item!.body)).toEqual({
    category: 'stationery',
    amount: 450,
    spentOn: TODAY,
    description: 'Chalk and dusters',
    payee: 'Ali Traders',
    method: 'cash',
  });
  const [local] = await listLocalExpenses();
  expect(local).toMatchObject({ amount: 450, state: 'queued', outbox: { id: item!.id } });
  expect(local!.receipt).toMatchObject({ state: 'waiting', outboxId: null });
  expect(fileExists(`${DOCUMENT}outbox/${local!.receipt!.fileName}`)).toBe(true);

  setOnline(true);
  await settleOutbox();
  const post = fake.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/expenses')!;
  expect(post.headers.get('Idempotency-Key')).toBe(item!.id);
  expect(post.body).not.toHaveProperty('stagedUploadId');
});

test('whole rupees only, and no identity number or phone in the text', async () => {
  await renderSignedIn(<ExpenseComposeScreen />, clerk(), {});
  fireEvent.press(await screen.findByTestId('expenseCompose.category.water'));
  fireEvent.changeText(screen.getByTestId('expenseCompose.amount'), '12.50');
  fireEvent.changeText(screen.getByTestId('expenseCompose.description'), 'Paid 35202-1234567-1');
  fireEvent.press(screen.getByTestId('expenseCompose.save'));
  expect(await screen.findByTestId('expenseCompose.amount.error')).toHaveTextContent(
    'Enter whole rupees, 1 or more.',
  );
  expect(screen.getByTestId('expenseCompose.description.error')).toHaveTextContent(
    'Do not type an identity number or a phone number here.',
  );
  expect(await listByState('pending')).toEqual([]);
});

test('the list shows what is on the phone and a refused one offers edit and resend', async () => {
  await renderSignedIn(<ExpenseComposeScreen />, clerk(), {
    'POST /api/v1/expenses': () => ({
      status: 422,
      body: {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Some fields are invalid.',
          details: { fields: [{ path: 'spentOn', code: 'INVALID_VALUE', message: 'spentOn must be no later than today' }] },
        },
      },
    }),
  });
  setOnline(false);
  fireEvent.press(await screen.findByTestId('expenseCompose.category.fuel'));
  fireEvent.changeText(screen.getByTestId('expenseCompose.amount'), '3000');
  fireEvent.changeText(screen.getByTestId('expenseCompose.description'), 'Generator diesel');
  fireEvent.press(screen.getByTestId('expenseCompose.save'));
  await eventually(() => expect(router.back).toHaveBeenCalled());
  setOnline(true);
  await settleOutbox();

  await renderSignedIn(<ExpensesScreen />, clerk(), {});
  const [local] = await listLocalExpenses();
  fireEvent.press(await screen.findByTestId(`expenses.local.${local!.id}`));
  expect(await screen.findByTestId('expenses.sheet.state')).toHaveTextContent(/Not saved/);
  fireEvent.press(screen.getByTestId('expenses.remedy.edit'));
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/home/expenses/new',
    params: { resend: local!.id },
  });
});
