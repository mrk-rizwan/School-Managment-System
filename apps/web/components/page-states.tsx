import { ErrorCode } from '@asms/shared';
import { AlertCircleIcon, ArrowLeftIcon, InboxIcon, LockIcon } from 'lucide-react';
import Link from 'next/link';
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
  // Rule 24: not a failure but a prompt; retrying cannot help until the password is changed.
  if (apiError?.code === ErrorCode.DEFAULT_PASSWORD_BLOCKS_ACTION) {
    return (
      <StateFrame icon={<LockIcon className="size-5" />} title="Change your password first">
        <p className="text-sm text-muted-foreground">
          Managing user accounts and roles is off while you use the default password.
        </p>
        <div className="pt-2">
          <Link href="/account" className="text-sm font-medium underline underline-offset-4">
            Change your password
          </Link>
        </div>
      </StateFrame>
    );
  }
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

/** The link back to the list (or record) a screen was opened from, above its header. */
export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeftIcon className="size-4" />
      {children}
    </Link>
  );
}

/** The bordered card a state is shown in when it stands in for a whole screen. */
export function StateCard({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border bg-card">{children}</div>;
}

/** The part of a TanStack Query result `QueryStates` reads. */
type ScreenQuery<T> = {
  data: T | undefined;
  isPending: boolean;
  error: unknown;
  refetch: () => unknown;
};

/**
 * A screen built on one query: loading, no permission, not found (a 404, when `notFound` is
 * given) and failed, each in a StateCard; `children` renders the data once it is there.
 */
export function QueryStates<T>({
  query,
  notFound,
  noPermission,
  loadingRows = 5,
  children,
}: {
  query: ScreenQuery<T>;
  notFound?: { title: string; description: string };
  /** The sentence under "You do not have access", when the default does not fit. */
  noPermission?: string;
  loadingRows?: number;
  children: (data: T) => React.ReactNode;
}) {
  if (query.isPending) {
    return (
      <StateCard>
        <LoadingState rows={loadingRows} />
      </StateCard>
    );
  }
  if (query.error || query.data === undefined) {
    const { error } = query;
    return (
      <StateCard>
        {isPermissionDenied(error) ? (
          <NoPermissionState description={noPermission} />
        ) : notFound && error instanceof ApiError && error.status === 404 ? (
          <EmptyState title={notFound.title} description={notFound.description} />
        ) : (
          <ErrorState error={error} onRetry={() => void query.refetch()} />
        )}
      </StateCard>
    );
  }
  return children(query.data);
}
