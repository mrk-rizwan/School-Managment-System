import type { Metadata } from 'next';
import { VerifyEmail } from './verify-email';

export const metadata: Metadata = { title: 'Verify email' };

// The link is ${APP_URL}/verify-email/{shortCode}#token=… (contracts/slice-2.md §3.5). Nothing
// is verified on load: mail scanners open links, so only the button press verifies.
export default async function VerifyEmailPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <VerifyEmail schoolCode={code} />;
}
