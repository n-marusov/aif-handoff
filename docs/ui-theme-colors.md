# UI Theme Color Rules

Single source of truth for color/contrast pairing in the web UI. Tailwind theme tokens (`text-foreground`, `bg-card`, etc.) flip with light/dark theme. Mismatched pairings (semantic token on a fixed-color backdrop, or vice versa) silently lose contrast in one of the two themes.

This document is **append-only** when a real readability bug is found. Each fix should leave a Learnings entry so the rule does not get re-broken.

## Pair rules

### 1. Themed surfaces → semantic foreground tokens

When the background is a theme-flipping token, use a theme-flipping foreground:

| Background                 | Foreground                                 |
| -------------------------- | ------------------------------------------ |
| `bg-card`, `bg-background` | `text-foreground`, `text-muted-foreground` |
| `bg-secondary`, `bg-muted` | `text-foreground`, `text-muted-foreground` |
| `bg-popover`               | `text-popover-foreground`                  |

Both sides flip in lockstep, so contrast holds in both themes.

### 2. Fixed-color backgrounds → fixed-color foreground

When the background does NOT flip (an always-dark scrim, brand color, image overlay, gradient), do not use semantic tokens — they will be the wrong shade in one theme.

| Background                                 | Foreground                                     |
| ------------------------------------------ | ---------------------------------------------- |
| `bg-black/85` (modal scrim, image overlay) | `text-white`, `text-white/80`, `text-zinc-100` |
| `bg-white` (always-light surface)          | `text-zinc-900`, `text-black`                  |

Hover/focus/disabled states inherit the same rule — `hover:text-white` on a `text-white/80` base, never `hover:text-foreground` over a fixed-color base.

### 3. Branded fills → matching `*-foreground` token

When the background is a saturated brand fill, use the paired foreground token (designed for that fill), not raw white/black:

| Background       | Foreground                    |
| ---------------- | ----------------------------- |
| `bg-primary`     | `text-primary-foreground`     |
| `bg-destructive` | `text-destructive-foreground` |
| `bg-accent`      | `text-accent-foreground`      |

### 4. Avoid readable content directly on a portal/overlay backdrop

If a fullscreen/modal overlay needs labels (counters, close icons, hints), prefer one of:

1. Wrap the labels inside a themed panel (`DialogContent`-style `bg-card` container) so semantic tokens become legal again.
2. If the labels must float on the raw scrim, switch to fixed-color foreground (`text-white/80` over `bg-black/85`).

Never render `text-muted-foreground` directly on `bg-black/85` — it resolves to dark gray on dark scrim in light theme and disappears.

## Verification checklist

Before shipping any change that touches color classes:

- [ ] Toggle light theme → verify text is readable on its background.
- [ ] Toggle dark theme → verify text is readable on its background.
- [ ] Check hover/focus/disabled states in both themes, not just the resting state.
- [ ] Search the diff for `text-muted-foreground`, `text-foreground` paired with `bg-black`, `bg-white`, `bg-{color}-{n}` (fixed shades). Each match is a candidate for re-pairing.

## Learnings

Append a dated entry whenever you fix a theme-readability bug. Keep entries one or two lines: the symptom, the cause, the fix.

- **2026-04-28 — Fullscreen textarea overlay header.** Counter + collapse icon used `text-muted-foreground` on `bg-black/85` scrim. In light theme the muted token resolved to dark gray on dark scrim and was invisible. Fix: switched both elements to `text-white/80` with `hover:text-white`. File: `packages/web/src/components/ui/textarea.tsx`.
- **2026-05-24 — Markdown inline code in task logs.** Inline code used a pale amber foreground on a light themed log surface and became worse under browser selection. Fix: pair markdown code with `text-primary` on themed surfaces and force markdown selection to `bg-primary` + `text-primary-foreground`. Files: `packages/web/src/components/ui/markdown.tsx`, `packages/web/src/index.css`.
- **2026-08-16 — Heartbeat/activity indicator dots.** Added decorative status dots (`bg-emerald-500` running, `bg-amber-500` stalled) in `heartbeat-indicator.tsx` and `robot-blink.tsx`. These are non-text, `aria-label`-only affordances, so the fixed-color contrast rules for readable content do not apply; no text sits directly on them.
