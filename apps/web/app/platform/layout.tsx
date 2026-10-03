import { PlatformSessionRedirects } from './session-redirects';

// Everything under /platform: the sign-in screens (platform/(auth)) and the console
// (platform/(console)). Its own session, separate from the school console (plan §1).
export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PlatformSessionRedirects />
      {children}
    </>
  );
}
