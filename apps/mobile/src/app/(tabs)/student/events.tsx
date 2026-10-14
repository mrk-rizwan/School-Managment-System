import { FamilyEventsScreen } from '../../../events/EventScreens';

// /student/events (slice 38): the student's own events. Not secure: no name shown.
export default function OwnEventsRoute() {
  return <FamilyEventsScreen source={{ kind: 'own' }} />;
}
