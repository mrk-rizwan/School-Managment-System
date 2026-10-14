import { todayInSchool } from '@asms/shared';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { api, unwrap } from '../api/client';
import type { MyDriverRouteDto, MyTransportDto } from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import type { FamilySource } from '../family/source';
import { useOnline } from '../net/connectivity';
import { ListRow } from '../ui/ListRow';
import { Screen } from '../ui/Screen';
import { Sheet } from '../ui/Sheet';
import { EmptyState, ErrorState, LoadingState } from '../ui/states';
import { colors, fontSize, space } from '../ui/theme';
import { boardings, ridersLine, spanLine, stopLine } from './transport';

// Transport on the phone (Phase 5 slice 41, contracts/slice-41.md §3, R330): a family's route —
// route, stop, pickup time and driver name, no child's name (not secure) — and a staff driver's
// routes with the riders' names by stop (secure). Online only and never cached on the phone.

function NeedsConnection({ title, testID, secure }: { title: string; testID: string; secure?: boolean }) {
  return (
    <Screen title={title} testID={testID} secure={secure}>
      <EmptyState title="Needs a connection" description="Transport is read online only." />
    </Screen>
  );
}

/** /children/[studentId]/transport and /student/transport. */
export function FamilyTransportScreen({ source }: { source: FamilySource }) {
  const online = useOnline();
  const studentId = source.kind === 'child' ? source.studentId : null;
  const query = useQuery({
    queryKey: queryKeys.familyTransport(studentId),
    queryFn: (): Promise<MyTransportDto> =>
      source.kind === 'child'
        ? unwrap(api.GET('/api/v1/me/children/{id}/transport', { params: { path: { id: source.studentId } } }))
        : unwrap(api.GET('/api/v1/me/student/transport')),
    enabled: online,
  });
  if (!online) return <NeedsConnection title="Transport" testID="familyTransport.screen" />;
  const current = query.data?.current ?? null;
  return (
    <Screen title="Transport" testID="familyTransport.screen" refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : current === null ? (
        <EmptyState title="No school transport" description="Ask the school office to arrange a route." />
      ) : (
        <Sheet testID="familyTransport.route">
          <View style={styles.block}>
            <Text style={styles.title}>{current.routeName}</Text>
            <Text style={styles.body} testID="familyTransport.stop">
              {stopLine(current) ?? 'Stop not chosen yet'}
            </Text>
            <Text style={styles.body} testID="familyTransport.driver">
              {current.driverName === null ? 'Driver not named yet' : `Driver: ${current.driverName}`}
            </Text>
            <Text style={styles.caption}>{spanLine(current, todayInSchool())}</Text>
          </View>
        </Sheet>
      )}
    </Screen>
  );
}

function useDriverRoutes(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.driverRoutes,
    queryFn: (): Promise<MyDriverRouteDto[]> => unwrap(api.GET('/api/v1/me/staff/transport-routes')),
    enabled,
  });
}

/** The Home card: shown only to a staff member some vehicle names as its driver (online). */
export function MyRoutesCard() {
  const router = useRouter();
  const online = useOnline();
  const routes = useDriverRoutes(online);
  const list = routes.data ?? [];
  if (list.length === 0) return null;
  return (
    <Sheet testID="home.myRoutes">
      <ListRow
        title="My routes"
        detail={list.map((r) => r.name).join(', ')}
        onPress={() => router.push('/home/my-routes')}
        testID="home.myRoutes.open"
      />
    </Sheet>
  );
}

/** /home/my-routes: each route's stops in order with who boards there. Names children: secure. */
export function MyRoutesScreen({ secure }: { secure?: boolean }) {
  const online = useOnline();
  const routes = useDriverRoutes(online);
  if (!online) return <NeedsConnection title="My routes" testID="myRoutes.screen" secure={secure} />;
  return (
    <Screen
      title="My routes"
      testID="myRoutes.screen"
      secure={secure}
      refreshing={routes.isRefetching}
      onRefresh={() => void routes.refetch()}
    >
      {routes.isPending ? (
        <LoadingState />
      ) : routes.isError ? (
        <ErrorState error={routes.error} onRetry={() => void routes.refetch()} />
      ) : routes.data.length === 0 ? (
        <EmptyState title="No routes" description="No school vehicle names you as its driver." />
      ) : (
        routes.data.map((route) => (
          <Sheet key={route.id} testID={`myRoutes.route.${route.id}`}>
            <View style={styles.block}>
              <Text style={styles.title}>{route.name}</Text>
              <Text style={styles.caption}>{`${route.vehicleRegistration} · ${ridersLine(route)}`}</Text>
            </View>
            {boardings(route).map((b, i) => (
              <ListRow
                key={`${route.id}-${i}`}
                title={b.detail === null ? b.title : `${b.title} · ${b.detail}`}
                detail={b.names.length === 0 ? 'Nobody boards here' : b.names.join(', ')}
                testID={`myRoutes.route.${route.id}.stop.${i}`}
              />
            ))}
          </Sheet>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  block: { gap: space.xs, paddingVertical: space.sm },
  title: { fontSize: fontSize.body, fontWeight: '600', color: colors.foreground },
  body: { fontSize: fontSize.body, color: colors.foreground },
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
});
