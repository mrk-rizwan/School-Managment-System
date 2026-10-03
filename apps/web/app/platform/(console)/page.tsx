import { redirect } from 'next/navigation';

// /platform has no screen of its own: the console opens on the school list
// (PLATFORM_PATHS.home in lib/platform-session.ts, a client module this server page cannot read).
export default function PlatformHomePage() {
  redirect('/platform/schools');
}
