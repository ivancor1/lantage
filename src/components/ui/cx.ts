export type ClassValue = string | false | null | undefined;

/**
 * Minimal class joiner. Deliberately not `clsx` — we only ever need falsy
 * filtering, and the design system forbids conditional colour anyway.
 */
export function cx(...parts: ClassValue[]): string {
  return parts.filter(Boolean).join(' ');
}
