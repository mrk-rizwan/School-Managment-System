import type { Metadata } from 'next';
import { ResetForm } from './reset-form';

export const metadata: Metadata = { title: 'Choose a new password' };

// The link is ${APP_URL}/reset/{shortCode}#token=… (contracts/slice-2.md §3.3). The token is in
// the fragment, so the server never sees it; the form reads it in the browser.
export default async function ResetPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <ResetForm schoolCode={code} />;
}
