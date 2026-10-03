import type { Metadata } from 'next';
import { ForgotForm } from './forgot-form';

export const metadata: Metadata = { title: 'Forgot password' };

export default function ForgotPage() {
  return <ForgotForm />;
}
