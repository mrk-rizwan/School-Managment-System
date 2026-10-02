import createClient from 'openapi-fetch';
import type { paths as SchoolPaths } from './school';
import type { paths as PlatformPaths } from './platform';
import { toApiError } from './errors';

// Browser-only clients. Requests go to this origin and Next rewrites /api/* to the API, so the
// session cookie is first-party. Never call these from a server component or route handler:
// school data is fetched by the browser with the user's cookie, never by the Next server
// (plan §1), and the relative base URL fails on the server by design.
const common = {
  credentials: 'same-origin',
  headers: { Accept: 'application/json' },
} as const;

// The generated paths already carry the full prefix (/api/v1/..., /api/v1/platform/...), so the
// base URL is empty: requests are origin-relative.
export const schoolApi = createClient<SchoolPaths>({ ...common, baseUrl: '' });
export const platformApi = createClient<PlatformPaths>({ ...common, baseUrl: '' });

/**
 * Returns the data of an openapi-fetch call or throws an ApiError, so TanStack Query sees a
 * failure as an error. Usage: `queryFn: () => unwrap(schoolApi.GET('/api/v1/health'))`.
 */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await call;
  if (!response.ok) throw toApiError(response, error);
  return data as T;
}
