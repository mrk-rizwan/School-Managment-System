import { useLocalSearchParams } from 'expo-router';
import { ResultSheetScreen } from '../../../../results/ResultSheetScreen';

// /marks/sheet/[id] — the class teacher's result sheet (slice 31): preview, remarks, submit.
// Online only; secure (children's names and figures).
export default function MarksSheetRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ResultSheetScreen id={id} secure />;
}
