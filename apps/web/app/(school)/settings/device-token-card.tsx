'use client';

import { Capability } from '@asms/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CopyIcon, KeyRoundIcon, PowerOffIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { unwrap } from '@/lib/api/client';
import { toastApiError } from '@/lib/api/errors';
import { staffAttendanceApi, type DeviceTokenDto } from '@/lib/api/school-staff-attendance-contract';
import { formatDateTime } from '@/lib/format';
import { DEFAULT_PASSWORD_HINT, schoolKeys, useBlockedActions, useCapabilities } from '@/lib/school-session';

// Phase 5 slice 44 (contracts/slice-44.md §2.1, R344): the school's biometric device token. Only
// its hash is kept, so the token is shown once, in the dialog that rotates it; afterwards the card
// says only whether one exists and when it was made. Rotating stops the old token at once; turning
// the device off removes the token, so every punch is refused until a new one is created.

export function DeviceTokenCard({ rotatedAt }: { rotatedAt: string | null }) {
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const isBlocked = useBlockedActions();
  const blocked = isBlocked('device_token.rotate');
  const revokeBlocked = isBlocked('device_token.revoke');
  const [confirming, setConfirming] = useState(false);
  const [turningOff, setTurningOff] = useState(false);
  const [issued, setIssued] = useState<DeviceTokenDto | null>(null);

  const rotate = useMutation({
    mutationFn: () => unwrap(staffAttendanceApi.POST('/api/v1/school/device-token/rotate')),
    onSuccess: (token) => {
      setConfirming(false);
      setIssued(token);
      void queryClient.invalidateQueries({ queryKey: schoolKeys.settings });
    },
    onError: (error) => {
      setConfirming(false);
      toastApiError(error);
    },
  });

  const revoke = useMutation({
    mutationFn: () => unwrap(staffAttendanceApi.POST('/api/v1/school/device-token/revoke')),
    onSuccess: () => {
      setTurningOff(false);
      toast.success('The device is turned off. Its token no longer works.');
      void queryClient.invalidateQueries({ queryKey: schoolKeys.settings });
    },
    onError: (error) => {
      setTurningOff(false);
      toastApiError(error);
    },
  });

  if (!can(Capability.SCHOOL_SETTINGS_MANAGE)) return null;
  const exists = rotatedAt != null;

  return (
    <Card data-testid="device-token-card">
      <CardHeader>
        <CardTitle>Biometric device</CardTitle>
        <CardDescription>
          The device, or the program that reads it, sends staff punches with this token. It marks a member present
          (or late) on their first punch of a working day; a day the office has already marked is never changed.
        </CardDescription>
        <CardAction className="flex gap-2">
          {exists && (
            <Button
              variant="outline"
              size="sm"
              disabled={revokeBlocked}
              title={revokeBlocked ? DEFAULT_PASSWORD_HINT : undefined}
              onClick={() => setTurningOff(true)}
            >
              <PowerOffIcon />
              Turn off device
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={blocked}
            title={blocked ? DEFAULT_PASSWORD_HINT : undefined}
            onClick={() => setConfirming(true)}
          >
            <KeyRoundIcon />
            {exists ? 'Replace token' : 'Create token'}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="text-sm" data-testid="device-token-status">
        {exists ? (
          <p>
            A token is set, made {formatDateTime(rotatedAt)}. It is not shown again; replace it if it is lost.
          </p>
        ) : (
          <p className="text-muted-foreground">No token yet: the device cannot send punches.</p>
        )}
        {blocked && <p className="mt-2 text-muted-foreground">{DEFAULT_PASSWORD_HINT}</p>}
      </CardContent>

      <Dialog open={confirming} onOpenChange={(open) => !rotate.isPending && setConfirming(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{exists ? 'Replace the device token?' : 'Create a device token?'}</DialogTitle>
            <DialogDescription>
              {exists
                ? 'The current token stops working at once. Punches are refused until the device has the new one.'
                : 'The token is shown once. Copy it into the device program straight away.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={rotate.isPending}>
              Cancel
            </Button>
            <Button onClick={() => rotate.mutate()} disabled={rotate.isPending}>
              {rotate.isPending ? 'Working…' : exists ? 'Replace token' : 'Create token'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={turningOff} onOpenChange={(open) => !revoke.isPending && setTurningOff(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Turn off the biometric device?</DialogTitle>
            <DialogDescription>
              The token stops working at once and every punch is refused. Staff attendance is then marked by the office
              until you create a new token.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTurningOff(false)} disabled={revoke.isPending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => revoke.mutate()} disabled={revoke.isPending}>
              {revoke.isPending ? 'Working…' : 'Turn off device'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={issued !== null} onOpenChange={(open) => !open && setIssued(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>The new device token</DialogTitle>
            <DialogDescription>Copy it now. It will not be shown again.</DialogDescription>
          </DialogHeader>
          {issued && (
            <div className="grid gap-3">
              <div className="flex gap-2">
                <Input readOnly value={issued.token} aria-label="Device token" className="font-mono text-xs" onFocus={(e) => e.target.select()} />
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Copy the token"
                  onClick={() =>
                    void navigator.clipboard.writeText(issued.token).then(
                      () => toast.success('Token copied.'),
                      () => toast.error('Could not copy. Select the token and copy it by hand.'),
                    )
                  }
                >
                  <CopyIcon />
                </Button>
              </div>
              <Alert>
                <AlertTitle>Keep it like a password</AlertTitle>
                <AlertDescription>
                  Anyone with this token can send punches for your school. If it leaks, replace it.
                </AlertDescription>
              </Alert>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setIssued(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
