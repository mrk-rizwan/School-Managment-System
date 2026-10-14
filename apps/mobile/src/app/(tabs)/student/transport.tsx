import { FamilyTransportScreen } from '../../../transport/TransportScreens';

// /student/transport (slice 41, R330): the student's own route. Not secure: no name shown.
export default function OwnTransportRoute() {
  return <FamilyTransportScreen source={{ kind: 'own' }} />;
}
