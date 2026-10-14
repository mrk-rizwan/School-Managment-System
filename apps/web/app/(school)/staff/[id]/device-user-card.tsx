'use client';

import { Capability, DEVICE_USER_ID_PATTERN } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { staffAttendanceApi } from '@/lib/api/school-staff-attendance-contract';
import type { StaffDto } from '@/lib/api/school-staff-contract';
import { useCapabilities } from '@/lib/school-session';
import { staffKeys } from '../_lib/staff-ui';

// Phase 5 slice 44 (contracts/slice-44.md §2.3, A11): the member's user number on the school's
// biometric device, under attendance.staff.manage and never on one's own record. Blank clears it.
// A later mapping does not repair punches already received.

const schema = z.object({
  deviceUserId: z
    .string()
    .trim()
    .refine((v) => v === '' || DEVICE_USER_ID_PATTERN.test(v), 'Use 1 to 40 letters, digits or symbols, with no spaces.'),
});
type Values = z.infer<typeof schema>;

export function DeviceUserCard({ staff, isSelf }: { staff: StaffDto; isSelf: boolean }) {
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { deviceUserId: staff.deviceUserId ?? '' },
  });
  const save = useMutation({
    mutationFn: (deviceUserId: string | null) =>
      unwrap(
        staffAttendanceApi.PATCH('/api/v1/staff/{id}/device-user', {
          params: { path: { id: staff.id } },
          body: { deviceUserId },
        }),
      ),
    onSuccess: (result) => {
      toast.success(result.deviceUserId ? `Device user id set to ${result.deviceUserId}.` : 'Device user id cleared.');
      void queryClient.invalidateQueries({ queryKey: staffKeys.detail(staff.id) });
    },
    onError: (error) => applyApiError(form, error),
  });

  if (!can(Capability.ATTENDANCE_STAFF_MANAGE)) return null;
  const onSubmit = form.handleSubmit(({ deviceUserId }) => {
    const next = deviceUserId === '' ? null : deviceUserId;
    if (next !== staff.deviceUserId) save.mutate(next);
  });

  return (
    <Card className="mt-6 max-w-2xl" data-testid="device-user-card">
      <CardHeader>
        <CardTitle>Biometric device</CardTitle>
        <CardDescription>
          {isSelf
            ? 'Your own device user id is set by another member of staff.'
            : 'The number this person uses on the school’s attendance device. Punches with it mark their attendance.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isSelf ? (
          <p className="text-sm">{staff.deviceUserId ?? 'Not set'}</p>
        ) : (
          <form noValidate onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
            <FormRootError form={form} />
            <div className="w-56">
              <FormField control={form.control} name="deviceUserId" label="Device user id" maxLength={40} hint="Leave blank to clear." />
            </div>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
