import type { Metadata, Viewport } from 'next';
import { fontVariables } from '@/lib/fonts';
import './globals.css';

export const metadata: Metadata = {
  title: 'Lantage',
  description: 'Image-intelligence workbench for investigators.',
};

export const viewport: Viewport = {
  /* Dark only — there is no light theme, and the browser chrome should agree. */
  colorScheme: 'dark',
  themeColor: '#08080c',
  width: 'device-width',
  initialScale: 1,
  /* The map is full-bleed, so the shell must reach under the notch/home bar.
     Components that need the inset read env(safe-area-inset-*) themselves. */
  viewportFit: 'cover',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    /* data-theme is the explicit dark contract every surface keys off. There are
       no `dark:` variants anywhere in this app — it has exactly one theme. */
    <html data-theme="dark" lang="en" className={`${fontVariables} h-full`}>
      <body className="min-h-full bg-n-50 text-fg">{children}</body>
    </html>
  );
}
