import type { Metadata } from 'next';
import { TermsAndResults } from './terms-results';

export const metadata: Metadata = { title: 'Terms and results' };

export default function TermsPage() {
  return <TermsAndResults />;
}
