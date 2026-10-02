import { ErrorCode } from '@asms/shared';
import { AlertCircleIcon, InboxIcon, LockIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api/errors';

// The four states every list screen has (plan §3.10). DataTable uses them; screens that are not
// tables use them directly, so every empty or failed screen looks the same.

function StateFrame({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {icon}
      </div>
      <div className="max-w-sm space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {children}
      </div>
    </div>
  );
}

export function LoadingState({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-4" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({
  title = 'Nothing here yet',
  description,
  action,
}: {
  title?: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <StateFrame icon={<InboxIcon className="size-5" />} title={title}>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      {action && <div className="pt-2">{action}</div>}
    </StateFrame>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const apiError = error instanceof ApiError ? error : null;
  return (
    <StateFrame icon={<AlertCircleIcon className="size-5" />} title="Something went wrong">
      <p className="text-sm text-muted-foreground">
        {apiError?.message ?? 'The request failed. Check your connection and try again.'}
      </p>
      {apiError?.requestId && (
        <p className="text-xs text-muted-foreground">
          Reference: <span className="font-mono">{apiError.requestId}</span>
        </p>
      )}
      {onRetry && (
        <div className="pt-2">
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </StateFrame>
  );
}

export function NoPermissionState({
  description = 'Your account does not have access to this. Ask your principal if you need it.',
}: {
  description?: string;
}) {
  return (
    <StateFrame icon={<LockIcon className="size-5" />} title="You do not have access">
      <p className="text-sm text-muted-foreground">{description}</p>
    </StateFrame>
  );
}

/** True when the API refused on permission grounds: show NoPermissionState, not ErrorState. */
export function isPermissionDenied(error: unknown): boolean {
  return error instanceof ApiError && error.code === ErrorCode.PERMISSION_DENIED;
}
