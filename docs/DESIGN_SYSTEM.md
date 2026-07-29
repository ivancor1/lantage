# Lantage — Design System

Source of truth for all UI work. Every value here is either **MEASURED** (read from live shipped CSS) or **DERIVED** (our adaptation). Build agents must not invent values outside this file.

## Provenance note

Ivan's reference was "flysoar.com." That domain is **parked and for sale** (301 → brandsly.com). The real product is **flysoar.ai** — a consumer flight-booking app. We pulled its live HTML, 8 CSS bundles, and 25 JS chunks on 2026-07-29 and extracted the design system verbatim.

What we take from flysoar.ai: the **engineering** — the three-tier glass system, the progressive-blur mask trick, the theme-flipping alpha ramp, the easing/duration scale, the pill geometry, the type treatment.

What we do **not** take: its light-first orientation and its blue brand gradient. Lantage is dark-only, monochrome, with one signal accent — matching both Ivan's brief ("black and white") and the Raven reference screenshots.

## 1. Palette

Off-black, blue-tinted neutrals (from flysoar.ai's dark theme — MEASURED). True `#000` is reserved for the immersive map shell only.

```css
:root {
  /* Neutrals — MEASURED from flysoar.ai dark theme */
  --n-0:  #08080c;   /* deepest surface, cards */
  --n-50: #0d1016;   /* page background */
  --n-100:#141821;   /* raised surface */
  --n-150:#1f2530;   /* input wells, hover */
  --n-200:#2b3340;
  --n-300:#374151;
  --n-400:#4b5563;
  --n-500:#9aa1ab;

  --map-shell: #000;  /* full-bleed map canvas only */

  /* Foreground — MEASURED */
  --fg:           #ffffff;
  --fg-secondary: #ffffffb8;  /* 72% */
  --fg-tertiary:  #ffffff75;  /* 46% */

  /* Hairlines — MEASURED */
  --border:        #ffffff1f;  /* 12% */
  --border-strong: #ffffff3d;  /* 24% */

  /* Signal accent — DERIVED. Monochrome UI, colour reserved for confidence/state.
     Matches the Raven reference: near-black with a single green signal. */
  --signal:        #78e6a0;   /* confirmed / high confidence — MEASURED (success-fg) */
  --signal-dim:    #78e6a021; /* 13% fill */
  --caution:       #ffb066;   /* degraded / low confidence — MEASURED */
  --caution-dim:   #ffb06624;
  --alert:         #ff8aa0;   /* refused / unmatchable — MEASURED */
  --alert-dim:     #ff8aa024;

  /* Theme-flipping alpha ramp — MEASURED. Use for tints/hairlines instead of
     hardcoding rgba, so a light theme (if ever added) needs no forks. */
  --w-05:#ffffff0d; --w-1:#ffffff1a; --w-2:#ffffff33; --w-3:#ffffff4d;
  --w-5:#ffffff80; --w-7:#ffffffb3; --w-9:#ffffffe6;
}
```

**Rule: colour carries meaning, never decoration.** A green ring means the system is confident. An orange ring means degraded input. Grey means unreviewed. If a designer wants colour for visual interest, the answer is no — this is the single most important thing separating an investigative tool from a consumer app.

## 2. Typography

```css
--font-sans: "Switzer", "Inter", ui-sans-serif, system-ui, sans-serif;
--font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
```

flysoar.ai ships **TWK Lausanne** (licensed, TYPE.WELTKERN). We can't use it without a licence. **Switzer** (Fontshare, free commercial) is the closest Swiss neo-grotesque match; Inter is the fallback. **JetBrains Mono** for all technical microlabels.

Base and treatment — MEASURED:

```css
html, body {
  font-size: 14px;          /* 14px base, not 16 */
  line-height: 1.5;
  letter-spacing: -0.006em; /* whole app runs slightly tight */
  -webkit-font-smoothing: antialiased;
}
```

| Role | Spec |
|---|---|
| Display / H1 | `clamp(2rem, 5vw, 2.5rem)`, weight **500**, `-0.02em`, lh 1.08 |
| Subhead | weight 500, `-0.012em` |
| Body | 14px / 1.5, weight 400 |
| **Mono eyebrow** | JetBrains Mono, 10.5px, `.08em`, uppercase, `--fg-tertiary` |
| Sans eyebrow | 10px, weight 700, `.05em`, uppercase, `--fg-tertiary` |
| Numerals | `font-variant-numeric: tabular-nums` — mandatory for coordinates, confidence %, result counts |

Headings are **medium (500), never bold.** This is what makes it read as instrument panel rather than marketing page.

The mono eyebrow is the signature Raven move — `§ 02 FIND STREET · STREET TARGETING`, `INPUT`, `MODEL VIEW`, `DIRECT INFERENCE`. Use it for every panel label, pipeline stage, and status annotation.

## 3. Glass — three tiers

flysoar.ai runs exactly three blur levels. Do not invent a fourth.

```css
--glass-scrim: blur(11px) saturate(112%);  /* header fade */
--glass-pill:  blur(16px) saturate(135%);  /* floating chrome */
--glass-heavy: blur(28px) saturate(150%);  /* overlay tier */
```

### 3a. Progressive-blur header scrim — MEASURED, the best trick on the site

The glass is **not on the header**. A fixed, pointer-transparent span sits underneath and fades its own blur out with a mask. This is why flysoar's header doesn't have the hard blur edge every other glass nav has.

```css
position: fixed; inset-inline: 0; top: 0; height: 112px;  /* 83px mobile */
background: linear-gradient(to bottom,
  color-mix(in srgb, var(--n-50) 58%, transparent) 0%,
  color-mix(in srgb, var(--n-50) 28%, transparent) 48%,
  transparent 100%);
backdrop-filter: var(--glass-scrim);
mask-image: linear-gradient(to bottom, #000 0%, #000 46%, transparent 100%);
transform: translateZ(0);
will-change: opacity, backdrop-filter;
transition: opacity .18s ease;   /* opacity 0↔1 on scroll */
```

### 3b. Pill glass — floating chrome

```css
border-radius: 9999px;
border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
background: linear-gradient(180deg,
  color-mix(in srgb, var(--n-0) 68%, transparent) 0%,
  color-mix(in srgb, var(--n-0) 46%, transparent) 100%);
box-shadow: inset 0 1px 0 rgba(255,255,255,.10),   /* edge light */
            0 10px 28px -18px rgba(0,0,0,.42);
backdrop-filter: var(--glass-pill);
transform: translateZ(0);
padding: 4px 8px;
```

### 3c. Cards are NOT blurred — MEASURED

This surprises people. flysoar's cards use near-opaque tints plus a hairline. Blur is reserved for floating chrome. Blurring cards over a map destroys legibility and costs frames.

```css
--glass-1: #08080cf2;  /* 95% */
--glass-2: #0a0a0edb;  /* 86% */
--glass-3: #14141ae6;  /* 90% */
--modal-surface: #0a0a0a;
--shadow-lift: 0 0 1px #ffffff2e, inset 0 0 2px #ffffff0a;  /* dark-mode lift, not drop */
--shadow-lg: 0 16px 30px -12px #000000a6, 0 6px 12px -8px #0000008c;
```

Modal backdrop — MEASURED: `backdrop-filter: blur(10px); background: #0006;` fade `.3s`.

**No noise/grain overlay. No SVG filters.** Edge light comes from the 1px inset white highlight, nothing else.

**Perf discipline — MEASURED:** every glass element gets `transform: translateZ(0)`, and flysoar sets `backdrop-filter: none !important` below 820px on several elements. We do the same, plus we kill blur entirely when the map is animating.

## 4. Controls

Everything is a pill: `border-radius: 9999px`. Universal focus — MEASURED:

```css
:focus-visible { outline: none; box-shadow: 0 0 0 2px rgba(154,161,171,.5), 0 0 0 3px var(--n-50); }
```

Press: `active:scale(.99)` (icon buttons `.96`). Disabled: `opacity:.45; pointer-events:none`.

| Variant | Spec |
|---|---|
| **Primary** | `h-44px`, pad `0 18px`, 1rem/600. **DERIVED:** flysoar's blue glossy gradient → flat `--fg` background with `--n-0` text. White-on-black is the Raven "Search →" / "Select This Result" button. |
| **Secondary** | `min-h-38px`, pad `0 15px`, .875rem/500, `bg --n-0`, `1px --border-strong`; hover `--n-100` + `--n-400` border |
| **Ghost** | transparent, `--fg-secondary`, pad `6px 10px`; hover `--n-100` + `--fg`; **selected = inset ring** `inset 0 0 0 1.5px var(--border-strong)`; transition `140ms cubic-bezier(.4,0,.2,1)` |
| **Icon** | `38×38` circle, `1px --border`, hover `--n-100` |
| **Chip** | `h-32px`, pad `0 12px`, .8rem |
| **Field cell** | `h-48px`, pad `0 16px`, radius pill; hover/focus `--n-100`; cells separated by `1px × 20px` hairline pseudo-element; input transparent, 15px/500, **16px on mobile** to kill iOS zoom |

## 5. Layout, radius, motion

```css
/* Radius — MEASURED */
--r-sm:6px; --r-md:10px; --r-lg:14px; --r-xl:18px;
--r-2xl:24px; --r-frame:24px; --r-nested:20px; --r-pill:9999px;

/* Easing — MEASURED */
--ease-spring: cubic-bezier(.16, 1, .3, 1);   /* signature, use for entrances */
--ease-smooth: cubic-bezier(.4, 0, .2, 1);    /* control state changes */
--ease-morph:  cubic-bezier(.22, 1, .36, 1);

/* Duration — MEASURED */
--d-hover:140ms; --d-base:150ms; --d-scrim:180ms;
--d-cta:200ms; --d-panel:340ms;
```

Layout — MEASURED: fixed header `grid-cols-[1fr_auto_1fr]`, pad `18px 28px` (mobile `14px 16px`); content widths **880px** and **1140px**; `env(safe-area-inset-*)` respected. Spacing on the Tailwind `.25rem` grid.

**Motion vocabulary** (MEASURED, adopt all of these):
- **Blur-in reveal** — `opacity:0 + blur(3–12px) + translateY(6–18px)` → clear. This is the house entrance animation.
- **Odometer digit roll** — 44px-tall mask, `transform 1.1s var(--ease-spring)`. Use for confidence percentages and result counts.
- **Shimmer sweep** — `background-clip:text` gradient sweep, 1.4s. Use for "analyzing…" states.
- `prefers-reduced-motion` honoured throughout — non-negotiable.

Libraries — MEASURED: **Framer Motion** (`AnimatePresence` page cross-fades) + **Lenis** smooth scroll (`data-lenis-prevent` on inner scrollers) + hand-written CSS keyframes. No GSAP, no Radix.

**Lantage-specific motion (DERIVED):** the search progression is the product's theatre. Region rings expand with `--ease-spring` over ~900ms; candidate pins stagger in at 40ms intervals; the map flies to a refined result with `map.flyTo({ curve: 1.42, speed: 0.8 })`. Never animate faster than the analyst can follow — this UI's job is to make a probabilistic result feel legible, not fast.

## 6. Stack

Next.js App Router (Turbopack) · **Tailwind CSS v4** CSS-first `@theme` (heavy `color-mix()`) · `next/font` for Inter/JetBrains Mono + manual `@font-face` for Switzer · **Lucide** icons · **MapLibre GL JS** (BSD-3 — *not* Mapbox GL v2+, which bills per map init and would meter an analyst who opens map views all day).

## 7. Tailwind v4 theme block

```css
@import "tailwindcss";

@theme {
  --font-sans: "Switzer", Inter, ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

  --color-n-0:#08080c;  --color-n-50:#0d1016; --color-n-100:#141821;
  --color-n-150:#1f2530; --color-n-200:#2b3340; --color-n-300:#374151;
  --color-n-400:#4b5563; --color-n-500:#9aa1ab;

  --color-fg:#ffffff; --color-fg-secondary:#ffffffb8; --color-fg-tertiary:#ffffff75;
  --color-border:#ffffff1f; --color-border-strong:#ffffff3d;

  --color-signal:#78e6a0;  --color-caution:#ffb066; --color-alert:#ff8aa0;

  --radius-sm:.375rem; --radius-md:.625rem; --radius-lg:.875rem;
  --radius-xl:1.125rem; --radius-2xl:1.5rem; --radius-frame:24px; --radius-nested:20px;

  --ease-spring:cubic-bezier(.16,1,.3,1);
  --ease-smooth:cubic-bezier(.4,0,.2,1);
}
```

## 8. Confidence display — the one component that matters most

Every result in Lantage carries uncertainty. How we render it is a product-integrity decision, not a styling one.

**Required:**
- Ring + percentage, tabular numerals, `--signal` / `--caution` / `--alert` by band.
- The **band label in mono eyebrow** next to it: `HIGH CONFIDENCE`, `DEGRADED INPUT`, `NOT MATCHABLE`.
- A one-line plain-English reason: *"4 of 5 results fall in this region"* — the Raven screenshots do this and it's why they read as credible.
- Every result panel carries a persistent `INVESTIGATIVE LEAD · VERIFY INDEPENDENTLY` footer in mono eyebrow. Not a dismissible toast. Permanent furniture.

**Forbidden:**
- A bare percentage with no band and no reason.
- Any confidence number on a result the quality gate flagged as unmatchable — show the refusal, not a number.
- Green for anything that isn't genuinely high-confidence. If everything looks confirmed, the colour system is worthless.
