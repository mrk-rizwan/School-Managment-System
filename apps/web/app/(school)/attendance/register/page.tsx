import type { Metadata } from 'next';
import { RegisterScreen } from './register-screen';

export const metadata: Metadata = { title: 'Attendance register' };

const one = (value: string | string[] | undefined) => (typeof value === 'string' ? value : undefined);

// `?section=&date=&period=` only preselect the screen (the console's "Record" links); the
// register is fetched by the browser (plan §1).
export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string | string[]; date?: string | string[]; period?: string | string[] }>;
}) {
  const { section, date, period } = await searchParams;
  const p = Number(one(period));
  return (
    <RegisterScreen
      initialSectionId={one(section)}
      initialDate={one(date)}
      initialPeriod={Number.isInteger(p) ? p : undefined}
    />
  );
}
