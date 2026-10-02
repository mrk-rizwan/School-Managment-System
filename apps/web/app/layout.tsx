import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { connection } from 'next/server';
import { Providers } from './providers';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: { default: 'ASMS', template: '%s · ASMS' },
  description: 'School management',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Render per request so Next can stamp the CSP nonce from proxy.ts on its scripts.
  // A prerendered page would carry no nonce and its scripts would be blocked.
  await connection();

  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full bg-background text-foreground">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
