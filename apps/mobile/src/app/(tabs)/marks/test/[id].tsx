import { useLocalSearchParams } from 'expo-router';
import { MarksGridScreen } from '../../../../marks/MarksGridScreen';

// /marks/test/[id]?local=1 — the marks grid (plan §3.8). Children's names: secure.
export default function MarksGridRoute() {
  const { id, local } = useLocalSearchParams<{ id: string; local?: string }>();
  return <MarksGridScreen id={id} local={local === '1'} secure />;
}
