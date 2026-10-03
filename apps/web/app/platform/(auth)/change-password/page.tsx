import type { Metadata } from 'next';
import { ChangePasswordForm } from './change-password-form';

export const metadata: Metadata = { title: 'Change password' };

export default function PlatformChangePasswordPage() {
  return <ChangePasswordForm />;
}
