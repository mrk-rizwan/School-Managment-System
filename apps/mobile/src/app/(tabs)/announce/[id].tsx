import { useLocalSearchParams } from 'expo-router';
import { AnnouncementScreen } from '../../../announce/AnnouncementScreen';

// /announce/[id] (slice-16 §7.2): one announcement and its delivery. No names: not secure.
export default function AnnouncementRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AnnouncementScreen id={id} />;
}
