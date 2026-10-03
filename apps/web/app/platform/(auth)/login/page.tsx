import type { Metadata } from 'next';
import { PlatformLoginForm } from './platform-login-form';

export const metadata: Metadata = { title: 'Platform sign in' };

export default function PlatformLoginPage() {
  return <PlatformLoginForm />;
}
