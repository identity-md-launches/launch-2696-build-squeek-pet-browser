# Squeek Pet design system

Source of truth: `src/styles.css` (tokens and components), `index.html` (shell), `src/main.ts` (view markup), `src/art.ts` (canvas art), `src/i18n.ts` (EN/VI copy and formatting), `src/share.ts` (local share image). Values below are copied from those files.

## Overview

A warm, cozy virtual-pet game for phones first. The pixel cage scene is the hero of every pet screen; the HTML around it is quiet: one system font, cream surfaces, one rust accent for the primary action per view, and thin borders instead of shadows. Density is relaxed, with 44px controls everywhere. The pixel art carries the personality; the interface stays plain so stats and actions read at a glance.

System-wide rules: one `<h1>` per screen, the main action high on the screen, live data in tabular figures, every state given in words (not only colour).

## Colors

Defined as custom properties on `:root` in `src/styles.css`; dark values override them inside `@media (prefers-color-scheme: dark)`. That media query is the only theme switch.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--color-bg` | `#fbf4e9` | `#1f1813` | Page background |
| `--color-surface` | `#fffaf2` | `#2a211a` | Cards, live strip, secondary buttons, inputs |
| `--color-sunken` | `#f1e4cf` | `#352a21` | Bar tracks, picker options, selected fur, hover |
| `--color-text` | `#3a2a1e` | `#f6ead9` | Body text, headings; toast background |
| `--color-text-muted` | `#6e5a48` | `#c9b39b` | Notes, labels, inactive tabs, input borders |
| `--color-line` | `#e3cfb2` | `#4a3a2d` | Borders and dividers |
| `--color-accent` | `#a5481a` | `#f0a060` | Primary button, active tab underline, pressed chip, links |
| `--color-accent-hover` | `#8c3c14` | `#f6b885` | Primary button hover |
| `--color-on-accent` | `#ffffff` | `#1f1813` | Text on accent |
| `--color-focus` | `#1f6fd1` | `#7fb8ff` | Focus ring |
| `--color-run` / `--color-rest` / `--color-off` | `#2f7d4f` / `#4a5fa8` / `#8a4b3b` | `#2f7d4f` / `#4a5fa8` / `#8a4b3b` | Live pill: Running / Resting / Offline or fault, always with white text and a word |
| `--color-danger` | `#a8322a` | `#ff8a7a` | Form errors, Start over, "(low)" stat cue |
| `--color-festival` | `#fff0c2` | `#4a3b14` | Festival banner |
| `--color-hunger`, `--color-happiness`, `--color-energy`, `--color-cleanliness` | `#e0904a`, `#e46a8a`, `#e6b52e`, `#4aa3c7` | same | Stat bar fills only (decorative; the number and label carry the meaning) |

The canvas scene uses its own fixed palettes in `src/art.ts` (`FURS`, `SKINS`, `HATS`, backgrounds) and does not change with the theme; it sits on a rounded `--color-sunken` frame.

Contrast: taste@1 passed its text-contrast check on the light entry page. Axe checks across all five screens, both languages and both themes reported no WCAG AA contrast violations. This is automated coverage, not a claim of full accessibility conformance; see `artifacts/validation.md` for limits.

## Typography

- Family: `--font-ui` = `system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`. No web fonts are loaded. Save-code text areas use `ui-monospace, SFMono-Regular, Menlo, monospace` because they hold code.
- Weights: 400 body, 600 labels, buttons and tabs, 700 brand, live values, pills.
- Scale (five sizes):

| Token | Size | Used by | Line height |
| --- | --- | --- | --- |
| `--text-sm` | 13px | `.small`, stat labels, tabs, pills, chips, `.btn-sm` | inherits 1.5 |
| `--text-md` | 16px | body, buttons, inputs (16px avoids iOS zoom) | 1.5 |
| `--text-lg` | 18px | `.h-sm` section headings, brand | 1.3 |
| `--text-xl` | 22px | `.h-md` screen titles, pet name | 1.2 |
| `--text-2xl` | 28px | `.h-lg` adopt headline only, `letter-spacing: -0.02em`, `text-wrap: balance` | 1.15 |

- Numbers that change (Seeds, stats, live values) use `font-variant-numeric: tabular-nums`.
- `body` sets `overflow-wrap: anywhere` so long pet names never overflow; tabs allow natural wrapping and use zero-minimum grid tracks; care actions also wrap. Short standalone buttons retain `white-space: nowrap`. Quest detail text can shrink and wrap at enlarged text sizes.
- Sentence case for interface copy; EN / VI are conventional language codes. No tracked kicker text. `Intl.NumberFormat`, `Intl.DateTimeFormat` and `Intl.RelativeTimeFormat` in `src/i18n.ts` format changing data with the chosen locale; dates and reset times use UTC. The root `lang` changes with the language.

## Layout

- Spacing steps: `--space-1` 4px, `--space-2` 8px, `--space-3` 12px, `--space-4` 16px, `--space-5` 24px, `--space-6` 32px. Inside a group 8 to 12px; between groups 24px (`main { gap: var(--space-5) }`).
- Width: header, tabs and `main` share `max-inline-size: 64rem`, centered, 16px inline padding. Adopt content caps at 34rem; prose at 65ch.
- Mobile first (checked at 320, 390, 768): header, then a five-column tab grid (the longer Wardrobe label gets a slightly wider track), then one column: pet name, canvas (`aspect-ratio: 240 / 144`, full width), mood line, 2×2 stat grid, four care actions, picker, Seed-cap note and share controls. The `.home-data` stack follows: live strip, records, then milestones. Records use a two-column definition list; dates sit below values.
- `@media (min-width: 56rem)`: the home screen becomes two columns (`1.5fr` scene and care, `1fr` `.home-data` stack); the banner and away card span both. Tabs grow to 16px.
- `@media (max-width: 40rem)`: utilities wrap; the Seed balance sits below the language/sound controls. The header itself can wrap for enlarged text.
- `@media (max-width: 22rem)`: tabs lose their side padding and the live grid drops to 2 columns.
- Logical properties (`inline-size`, `padding-inline`, `inset-block-end`) throughout. No horizontal scroll was measured on all five screens in both languages at 320, 390, 768 or 1440. A separate 200% root-font enlargement check passed at 390; this is not browser-native zoom.

## Elevation and depth

Flat. Surfaces separate by tone (`--color-surface` on `--color-bg`) and 1px `--color-line` borders. No box shadows on surfaces (the one inset shadow draws the seed glyph in `.seed-dot`). The only floating layer is `.toast`: fixed to the bottom inside the safe area, `pointer-events: none`, cleared after 4 s.

## Shapes

`--radius-sm` 8px for buttons, inputs, picker options and fur tiles; `--radius-md` 12px for the canvas, cards, live strip, banner and toast; `--radius-pill` for pills, chips and bars. The pixel art keeps hard edges (`image-rendering: pixelated`).

## Components

| Component | Source | Use and states |
| --- | --- | --- |
| Button `.btn` | `styles.css` `.btn`, `.btn-primary`, `.btn-sm`, `.btn-wide`, `.btn-danger` | 44px min height (`.btn-sm` 40px). Primary emphasis marks Feed on Home, Adopt, and ready quest claims. Collect and Share stay neutral on Home. Press scales to 0.96 (off under reduced motion); hover only with `(hover: hover)`. Unaffordable Buy buttons use `aria-disabled="true"` and explain the shortfall in a toast. |
| Tabs `.tabs` | `index.html` nav, `styles.css` `.tabs` | Hash links; the current one gets `aria-current="page"` and a 3px accent underline. Hidden before adoption. Wrapping labels retain the underline and 44px minimum height. |
| Language switch `.language-switch` | `index.html`, `switchLanguage()` in `main.ts` | EN / VI buttons, 40×44px minimum, `aria-pressed` and current-language underline. Preserves typed form values; changes all interface copy and `html.lang`. |
| Icon button `.icon-btn` | header Sound toggle | 44px square, `aria-pressed`, labelled "Sound"; off by default. |
| Stat meter `.stat` | `statBars()` in `main.ts` | Label, value, `role="meter"` bar; low values add translated text cues, “(low)” or “(high)” for hunger; no CSS-generated English remains. |
| Progress `.bar` | quests, growth, block progress | `role="progressbar"` with `aria-valuenow`. |
| Picker `.picker` / `.opt` | `pickerHtml()` | Opened by Feed or Play (`aria-expanded`), focus moves to the first option, Escape closes and returns focus. Food options show pantry counts, visible prices, prices in words in their accessible names, and `aria-disabled` with muted text plus an explanatory message when unaffordable. |
| Live strip `.live` | `liveStrip()` | Checking, Running, Resting, Sensor fault, stale and Offline states; updated at the existing cadence; focus on the stream link is restored after replacement. Resting shows estimated last-run time or `n/a`. |
| Pill `.pill` | live strip | Coloured dot plus a word. |
| Card `.card` | away card, quest items, records | Surface plus border; never nested. |
| Records `.records-grid` | `recordsCard()` in `main.ts` | Two columns of label, tabular value and UTC date. Missing data shows `n/a`. |
| Milestones `.milestones` | `milestonesCard()` in `main.ts` | Three newest known events, one sentence and relative time each. Unknown event types omitted; unavailable state says `n/a`. |
| Share `.share-tools` | `sharePanel()` in `main.ts`, `src/share.ts` | Inline disclosure, local preview image, Download image link, conditional native Share and Close image. Escape closes and returns focus. No modal or upload. Blob URLs are revoked on close, language change and reset. |
| Chip `.chip` | Wardrobe | Toggle buttons with `aria-pressed`. |
| Field `.field` | adopt name, save code | Visible label wraps the control; errors in an `aria-live` line linked by `aria-describedby`, `aria-invalid` on failure. |
| Fur tile `.fur` | adopt form | Radio input over a pixel portrait; checked tile gets accent border and bold label; focus ring via `:has(input:focus-visible)`. |
| Banner `.banner` | festival | `role="status"`, minutes left. |
| Toast `.toast` | `#toast` | Polite live region, stable element, auto-clears. |
| Scene canvas | `art.ts` `drawScene` | Poses: idle (blinks), eat, run, sleep, happy, grumpy. About 8 fps; grumpy runs at half speed; reduced motion uses a slow two-frame walk once per second, with a still wheel/background, no bobbing and no confetti. Other reduced-motion poses stay still. |

The 1200×630 share image uses the same light cream/rust palette and local system font as the interface. Its 240×144 scene is drawn with smoothing disabled, then scaled to 648×389. Name and stage sit above it; earned Seeds and days together sit beside it; the Squeekchain line and site address complete the image. Raster composition has its own export-sized type hierarchy in `src/share.ts`, separate from the website’s five-size CSS scale. The scene preserves the current pose, fur, stage and equipped cosmetics.

## Do's and don'ts

- Do start a new screen as a `<h1 class="h-md">` followed by `.group` sections with `<h2 class="h-sm">`, inside `main`'s grid gap.
- Do use one `.btn-primary` per view; everything else is `.btn` or `.chip`.
- Do take colours from the role tokens; add a role token instead of reusing one by value.
- Do pair every colour state with a word (pill text, "(low)").
- Don't add shadows to surfaces, nest cards, or add new font sizes beyond the five tokens.
- Don't use `transition: all`; list properties and drop motion under `prefers-reduced-motion`.
- Keep all copy in `src/i18n.ts`, using matching interpolation names in both languages; format data with the shared `Intl` helpers.
- Recipe for one more screen: add its id to `route()` in `main.ts`, a `<a href="#/name">` in the tabs (and raise the `.tabs` column count), a `nameView()` returning `<h1 class="h-md">` plus `.group` sections built from `.card`, `.items`, `.chips` and `.btn`, then rebuild.


Design review used the pinned Better Interface guidance by Jakub Krehel (MIT) and documentation method adapted from Paul Bakaus’s Impeccable (Apache-2.0). Source records: [Better Interface](https://github.com/jakubkrehel/skills/tree/267330e1adfc66a718fb65fa6918c1f06d0a689e/skills/better-interface), [Impeccable document reference](https://github.com/pbakaus/impeccable/blob/9d715cc4f5564a990ca8345abfdd5df6dc9b41c8/skill/reference/document.md). Their license notices are retained in `artifacts/design-guidance-LICENSE.txt`.
