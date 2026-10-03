import type { Metadata } from 'next';
import { TotpEnrolment } from './totp-enrolment';

export const metadata: Metadata = { title: 'Set up authenticator' };

export default function PlatformEnrolPage() {
  return <TotpEnrolment />;
}
