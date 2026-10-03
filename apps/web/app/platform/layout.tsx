'use client';

import { SessionRedirects } from '@/components/session-redirects';
import { sessionRedirectFor } from '@/lib/platform-session';

// Everything under /platform: the sign-in screens (platform/(auth)) and the console
// (platform/(console)). Its own session, separate from the school console (plan §1).
// A client layout because it hands SessionRedirects a function, which a server component cannot.
export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SessionRedirects redirectFor={sessionRedirectFor} />
      {children}
    </>
  );
}
