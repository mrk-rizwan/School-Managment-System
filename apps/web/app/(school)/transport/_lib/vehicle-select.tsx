'use client';

import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { OPTIONS_LIMIT, unwrap } from '@/lib/api/client';
import { transportApi } from '@/lib/api/school-transport-contract';
import { transportKeys } from './transport-ui';

/** The vehicles in use, as one select ("No vehicle" first). */
export function VehicleSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const id = useId();
  const query = { page: 1, limit: OPTIONS_LIMIT, status: 'active' as const };
  const vehicles = useQuery({
    queryKey: transportKeys.vehicles(query),
    queryFn: () => unwrap(transportApi.GET('/api/v1/vehicles', { params: { query } })),
  });
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>Vehicle</Label>
      <NativeSelect id={id} value={value} disabled={vehicles.isPending} onChange={(e) => onChange(e.target.value)}>
        <option value="">No vehicle yet</option>
        {(vehicles.data?.data ?? []).map((v) => (
          <option key={v.id} value={v.id}>
            {v.registration} · {v.capacity} seats{v.driverName ? ` · ${v.driverName}` : ''}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}
