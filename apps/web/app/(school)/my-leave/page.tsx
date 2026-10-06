import type { Metadata } from 'next';
import { MyLeave } from './my-leave';

export const metadata: Metadata = { title: 'My leave' };

export default function MyLeavePage() {
  return <MyLeave />;
}
