/**
 * Font loading for the app shell.
 *
 * Two different mechanisms, on purpose:
 *
 * - JetBrains Mono is on Google Fonts, so `next/font/google` self-hosts it and
 *   emits a hashed `font-family` name. That name is only reachable through the
 *   CSS variable declared below, which is why globals.css rebinds `--font-mono`
 *   to it rather than naming "JetBrains Mono" directly.
 *
 * - Switzer is Fontshare-licensed (free for commercial use) and is NOT on Google
 *   Fonts, so `next/font/google` cannot reach it. Its woff2 files live in
 *   public/fonts and are declared with hand-written `@font-face` rules at the end
 *   of globals.css — see docs/DESIGN_SYSTEM.md §6. Nothing to import for it here;
 *   it resolves by family name through `--font-sans`.
 */
import { JetBrains_Mono } from 'next/font/google';

/**
 * Variable font — weight is deliberately omitted so the whole 100..800 axis is
 * available to the mono eyebrows (400) and tabular figures (500) without extra
 * requests.
 */
export const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

/** The `@font-face` family name declared in globals.css. */
export const SANS_FAMILY = 'Switzer' as const;

/** Every font CSS variable the root <html> element needs, space-separated. */
export const fontVariables: string = jetbrainsMono.variable;
