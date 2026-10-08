import { useLocalSearchParams } from 'expo-router';
import { SheetPickerScreen } from '../../../../results/SheetPickerScreen';

// /marks/[sectionId]/sheet — the class teacher picks the term of the section's result sheet.
export default function SheetPickerRoute() {
  const { sectionId, yearId } = useLocalSearchParams<{ sectionId: string; yearId: string }>();
  return <SheetPickerScreen sectionId={sectionId} yearId={yearId ?? ''} />;
}
