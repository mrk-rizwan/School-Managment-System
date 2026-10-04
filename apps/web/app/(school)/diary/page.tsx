import type { Metadata } from 'next';
import { DiaryHome } from './diary-home';

export const metadata: Metadata = { title: 'Diary' };

export default function DiaryPage() {
  return <DiaryHome />;
}
