# Squeek Pet v2 validation

Worker checks performed on 2026-10-30 against the production `dist/`, served at a local `/preview/` subpath. These are local observations, not independent certification.

## Results

| Check | Actual result |
| --- | --- |
| `npm ci --cache /tmp/squeek-npm-cache` | Passed using the existing lockfile; package manifest, lockfile and build configuration unchanged. |
| `npm run typecheck` | Passed (`tsc --noEmit`). |
| `npm test` | Passed: 45 tests in two files (28 existing, 17 v2). |
| `npm run build` | Passed: TypeScript and Vite production export; 10 modules transformed. |
| Production Chromium interaction script | 92 passed, 0 failed; one separate WebKit check unperformed because its browser could not launch. |
| Axe WCAG A/AA checks | No violations in 20 scans: five screens × two languages × light/dark, at 1440 px. Included semantic names, valid ARIA, focusable controls and rendered text contrast. |
| Pinned taste@1 probe | 16/16 passed; entry page at 320, 390, 1440 and reduced motion. |
| Live API observation | Successful direct requests and production Chromium rendering from all three existing API endpoints. Records, dates and newest milestones displayed real values. |
| Real-network Chromium console | 0 errors and 0 warnings when checked. No application script errors captured in mocked interaction validation. |

The browser script ran with `PLAYWRIGHT_BROWSERS_PATH=/tmp/squeek-browsers node test/scratch/check-ui.mjs`. It used deterministic API fixtures and a controllable browser clock; advancing that clock did not wait in real time or increase actual API traffic. Temporary Playwright/axe dependencies and browser binaries were installed under `/tmp`, outside the repository. Scratch scripts, fixtures, logs and screenshots are test scaffolding and are not part of the submission.

The pinned probe was run from the repository root with:

```sh
IMD_PLAYWRIGHT=/tmp/squeek-browser/node_modules/playwright/index.mjs \
PLAYWRIGHT_BROWSERS_PATH=/tmp/squeek-browsers \
node .imd/reads/skills/design-critic/scripts/taste.mjs --out test/scratch/taste
```

Its first attempt reported that Playwright was absent. After the temporary install, the final run passed all 16 checks. The probe evaluates the entry page; the separate interaction script and visual inspection cover adopted Home and other screens.

## Functional coverage

- **Festival regression:** unit and browser reproduction uses a fresh save adopted at 08:05 UTC, with an already fetched batch whose newest qualifying event is the 40 km milestone at 04:04:30.819Z. No festival starts. Tests also isolate the first-fetch cutoff independently of the birth guard, reverse event order, check pre-birth events within the last hour, existing watermarks, future timestamps and replayed IDs. An event after adoption can start a festival.
- **Records and last ran:** parsed actual `{ value, occurredAt }` record objects; verified speed × 0.0036, daily distance / 1e6, rpm / 1000 and half-hour passes. Real Home displayed 5.86 km/h, 11.67 km, 111.3 rpm and 1,827 passes, with October 27–29 dates. Last ran uses the newest positive half-hour bucket with noon-based Squeek-day mapping; zero, unknown, unsorted and future buckets are tested.
- **Milestones:** the three newest known event types sort by `occurredAt`, use the requested numeric payloads and show localized relative times. Real Home showed 40 km lifetime, 10 km in one Squeek day, and a four-day streak of at least 5 km/day. Unknown types are ignored. Blocked records/events show `n/a`.
- **Care/economy:** adoption validation and escaped names, Feed from pantry, on-the-spot food purchase, unaffordable food keyboard activation, free Play, Clean, Pet, buying/equipping cosmetics and quest claims were exercised. Pantry counts include zero. Accessible food names include prices in words in EN and VI. At the cap, a persistent note shows the exact UTC window reset time. Existing prices, effects, caps, XP thresholds and decay rates were retained.
- **Lifetime Seeds:** the initial gift is excluded. Units cover accumulating run credits, collected away credits and quest rewards, then spending without reducing lifetime earnings. Browser checks exercise the actual run, away collection and quest-claim handlers.
- **Away ordering:** held the stats response until after status, then held status until after stats. Both orders showed 400 passes / 200 Seeds for the fixture window, collected once, and showed no second award after reload. Unknown logs remain pending; merged unresolved windows and the settlement marker are unit tested.
- **Localization/migration:** toggled both languages on every screen, including menu names, items, notes, quest titles, status/records, errors, toasts, About and away copy; scanned visible text and accessible labels for untranslated dictionary entries. Reload preserved the language; a Vietnamese browser migrated a v1 save without the three new fields to documented defaults. Invalid import text survives switching language and its error changes language. Valid save-code import restored the pet and language. Pre-adoption language persistence also passed.
- **Share:** bought and equipped the party hat, mint wheel and meadow. The downloaded PNG’s signature and dimensions were checked (1200×630), then pixel checks confirmed all three equipped cosmetic palettes. The image was visually inspected and showed the current sleeping pose, name, stage, totals, tagline and address. Both Preview and Download use a blob URL. A capability stub exercised the native file-share path with the actual PNG file; closing with Escape restored focus. The game performs no image upload.
- **Polling:** a controlled clock verified the 15-second status minimum, two-minute events minimum, five-minute stats minimum, and no polling while hidden. Poll constants and endpoint paths are unchanged.
- **Reduced motion:** a running/festival fixture under reduced motion kept the wheel and background pixel regions stable across frames, with no confetti. Legs alternate slowly; wheel rotation and bobbing are suppressed. Button press transforms are disabled by CSS.

## Better Interface review

One visual idea: a warm, quiet interface around an original pixel hamster cage, with care actions first and Squeektoshi’s activity beside or below it. Existing colors, system typography, layout and stack were preserved; the new features reuse them.

| Domain | Coverage and evidence | Limits |
| --- | --- | --- |
| Accessibility | Checked native actions, labelled fields, validation/focus return, language group, meters/progress, reduced motion and 20 axe scans. Keyboard adoption, pantry Escape, unavailable-food activation, share Escape and import recovery exercised. | No screen-reader or physical-device session; not a full WCAG conformance audit. |
| Layout | Checked all five screens in EN/VI at 320, 390, 768, 1440; no horizontal scroll. All screens passed 200% root-font enlargement at 390. Product and primary action visible on the first 390×844 screen. | Text enlargement is not browser-native zoom. RTL is not applicable to EN/VI. |
| Writing | Checked dictionary completeness, natural Vietnamese, consistent Seeds/Hạt terms, explicit missing-data and pantry states, localized errors and kind pet copy. No marketing redesign. | Human native-speaker editorial review was not independently commissioned. |
| Typography | Five website size tokens; three weights; one system family plus monospace save codes. Locale-aware tabular data, wrapping labels and 16px textareas. Probe type/copy checks passed. | OS system-font appearance can vary. Raster share image uses its own export-sized hierarchy. |
| Colors | Existing light/dark tokens reviewed; dark live-pill colors corrected for white text. Probe contrast and 20 theme/locale/screen axe checks passed. Status meaning also appears in words. | Canvas pixel art is decorative/informative artwork, not text-contrast coverage. Forced-colors was not tested. |
| UI | Checked picker, empty/offline states, disabled foods, claims, language persistence, share loading/preview/download/close, focus and motion. Existing border-based surfaces retained. | Native OS share sheet and Safari interactions unavailable here. No 10%-speed animation-panel session. |

### Findings fixed and rechecked

| Impact | Source | Observed issue → correction and recheck |
| --- | --- | --- |
| High | `src/logic.ts:396` | Initial-event loop mutated eligibility while reading the batch, so the second old event passed. Freeze the initial cutoff and apply `bornAt` in the production caller. Exact regression and replay tests pass. |
| High | `src/api.ts:86` | Existing numeric parser received record objects and returned unknown. Parse `.value` and `.occurredAt` for all four requested records. Real API values/dates now render; unknown cases still show `n/a`. |
| Medium | `src/main.ts:271`, `src/logic.ts:533` | Away settlement needed to be independent of status/log response order and durable against repeat processing. Both callbacks settle known logs; a saved watermark excludes already settled time. Both request orders and collection/reload pass. |
| Medium | `src/main.ts:477`, `src/main.ts:526` | Food costs/counts and cap recovery were incomplete. Expose every pantry count, spoken price, unavailable state and persistent reset time. EN/VI browser interactions pass. |
| High | `src/main.ts:655` | First accessibility run found `aria-pressed` on `<main>` because the language selector also matched its language data attribute. Scope pressed-state updates to language buttons. All 20 final axe scans pass. |
| Medium | `src/styles.css:128`, `src/styles.css:189`, `src/styles.css:724` | 200% text exposed nav overflow and an unshrinkable quest detail row. Wrap the header/nav, use zero-minimum tab tracks and allow quest details to shrink. A slightly wider Wardrobe track also prevents awkward word splitting at 320/390. All five screens pass enlarged-text reflow. |
| Medium | `src/art.ts:183`, `src/art.ts:235` | Reduced-motion rendering needed a slow walk without spinning or confetti. Freeze wheel/background, remove bob/confetti, alternate legs slowly. Pixel stability test passes. |
| Low | `src/main.ts:458` | Replacing activity markup could remove keyboard focus from the stream link. Preserve and restore it through data refreshes; source and browser focus paths reviewed. |

Final visual evidence was inspected in the browser and from generated files. Temporary evidence includes `test/scratch/ui/entry-390.png`, `home-en-390.png`, `home-vi-390.png`, `home-en-1440.png`, `home-vi-1440.png`, `share-en.png`, `reduced-motion.png`, `text-200.png`, and the probe’s `test/scratch/taste/shots/`. Real-network mobile/desktop browser screenshots were inspected separately and moved under `test/scratch/browser-evidence/`. On the final real-data VI Home at 390, Feed ended at approximately 607 px in an 844 px viewport, the document had no horizontal overflow, and no old-event festival appeared.

## Limits and delivery

WebKit was installed temporarily but could not launch: the host lacks GTK/GStreamer and other required shared libraries. Safari, physical phones, actual OS file sharing, screen-reader output, forced-colors and native browser zoom remain unverified. Native sharing was tested with a capability stub, not with a recipient or an upload. The app always provides the local PNG download fallback.

Source, original lockfile and the rebuilt relative-URL `dist/` form the deliverable. No dependencies, build configuration, wallet code, service backend, tracking, remote fonts/images, registry mirrors or dependency archives were added. The sole ignore-file change is an explicit allowlist for `artifacts/validation.md` (24 KiB maximum) and `artifacts/design-guidance-LICENSE.txt` (16 KiB maximum), 40 KiB combined. All other artifact paths remain excluded; generated browser/dependency/cache files stay outside the submission. See README for setup, new save fields and rebuilding, and DESIGN.md for the implemented tokens/components.

Complete for the implementation and Chromium checks stated above, with the explicit platform/manual coverage limits above. Final path and byte inspection is recorded in the README validation summary.
