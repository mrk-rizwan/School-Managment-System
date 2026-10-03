import { SchoolConsole } from './school-console';

// The school console (plan §1, §3.10): one layout, its sidebar built from GET /me's effective
// capabilities. Everything inside is fetched by the browser with the school cookie.
export default function SchoolLayout({ children }: { children: React.ReactNode }) {
  return <SchoolConsole>{children}</SchoolConsole>;
}
