<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Lantage

Image-intelligence workbench for investigators. Read `docs/MASTER_PLAN.md` before working on anything; read `docs/DESIGN_SYSTEM.md` before touching UI.

**Stack:** Next.js 16.2 (App Router, Turbopack) · React 19.2 · Tailwind v4 · MapLibre GL 6 · Supabase · Modal (GPU inference) · TypeScript strict.

## Next.js 16 deltas that will bite you

Verified against `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md` on 2026-07-29. Do not write these from memory.

1. **Async Request APIs are mandatory.** Synchronous access is *fully removed*. `await` all of: `cookies()`, `headers()`, `draftMode()`, and `params` / `searchParams` in `page.tsx`, `layout.tsx`, `route.ts`, `default.tsx`.
   ```tsx
   export default async function Page(props: PageProps<'/case/[id]'>) {
     const { id } = await props.params;
   }
   ```
   This matters most for Supabase SSR, which reads cookies on every server call.

2. **`middleware.ts` is now `proxy.ts`.** Export a function named `proxy`. **The `edge` runtime is NOT supported in `proxy`** — it runs `nodejs` and that is not configurable. Config flags renamed too (`skipMiddlewareUrlNormalize` → `skipProxyUrlNormalize`).
   ```ts
   // proxy.ts
   export function proxy(request: Request) {}
   ```

3. **Type helpers are generated, not hand-written.** `PageProps<'/route'>`, `LayoutProps<'/route'>`, `RouteContext<'/route'>` are globally available after `npx next typegen`. Use them instead of inventing prop types.

4. **`next lint` is removed** and `next build` no longer lints. Run `npx eslint .` directly. ESLint uses flat config.

5. **Turbopack is the default** for `dev` and `build`. Don't add `--turbopack`. Turbopack config lives at `turbopack` in `next.config.ts`, no longer under `experimental`.

6. **Parallel routes require `default.js`.** If you add a parallel route, add its default.

7. `next/image` changed defaults for `minimumCacheTTL`, `imageSizes`, `qualities`, local images with query strings, and local-IP access. Check the doc before configuring images.

## Non-negotiable product rules

These are encoded in `src/lib/contracts/types.ts`. Import the invariants; do not reimplement or bypass them.

- **No result without cited evidence.** `Candidate.evidence` is a non-empty tuple by construction, and every `Evidence` needs a `verifiable` string saying how a human independently checks it. If a signal can't be checked, it's telemetry, not evidence.
- **Confidence is a band plus a reason**, never a bare percentage. `ConfidenceBand` + `Confidence.reason` are both required.
- **Street precision must be earned.** Call `assertStreetPrecisionIsEarned()`. `precision: 'street'` requires a `vpr-match` or `signage-ocr` in the evidence chain — inference alone cannot support it (best published 1 km accuracy on the only area-weighted benchmark is 0.7%).
- **A failed quality gate returns no ranking.** Call `assertRefusalIsHonoured()`. Show the refusal.
- **Never assert authenticity.** `AuthenticityVerdict` has no `'authentic'` variant on purpose. Only `'no-indicators-found'`.
- **`LEAD_DISCLAIMER` is permanent UI furniture** on every result surface. Not a dismissible toast.
- **Never log or persist plate characters, and never undo upstream blur.** Mapillary ToS §12 requires technical safeguards against it, and we ship no ALPR.

## Boundaries — do not build these

Scraped face index · license-plate recognition · MLS listing-photo index. See `docs/MASTER_PLAN.md` §1, §7, §8 for why. If a task seems to require one of these, stop and say so rather than working around it.

## Conventions

- TypeScript strict. No `any` in exported signatures.
- Server-side secrets never reach the client. Supabase service-role key is server-only.
- Every search writes an immutable audit record. Never `UPDATE` or `DELETE` audit rows.
- Comments explain constraints the code can't show — not what the next line does.
- Tailwind utilities + the `.glass-*` / `.eyebrow-*` primitives in `globals.css`. Don't hand-roll glass; don't invent tokens outside `DESIGN_SYSTEM.md`.
