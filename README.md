# Squeek Pet

A browser virtual pet. Your pixel hamster runs and naps in sync with Squeektoshi, the real hamster whose wheel powers Squeekchain (a proof-of-work toychain on Ethereum Sepolia).

This is an unofficial fan game. Testnet values have no monetary value. It is a static site with no backend, no wallet, no trackers and no analytics. The game saves in `localStorage`.

## What is new in v2

- Home shows Squeektoshi’s four records and their dates, the three newest measurement milestones, and an estimated last-run time while the wheel rests. Values come from the existing API requests; blocked or unavailable values show `n/a`.
- **Share my hamster** creates a local 1200×630 PNG with the current pose, equipped hat, wheel and background, name, growth stage, lifetime earned Seeds, days together and the site address. Download it or use the device’s file-sharing sheet where supported. Nothing is uploaded by the game.
- The header switches **EN / VI** across all five screens, adoption, errors, toasts and share images. `src/i18n.ts` is the single copy dictionary, with locale-aware `Intl` numbers, dates and relative times. Add both translations and preserve interpolation names when editing it.
- Festivals no longer start from an old first-fetch batch or cached events before adoption. The whole batch uses the same initial eligibility boundary; the pet’s `bornAt` also limits eligibility.
- Feed options show every pantry count and price, use a grey unavailable state, and announce prices in words. The hourly cap leaves its UTC reset time beside care actions.
- Away rewards settle when either request arrives first, with a persisted settlement marker preventing duplicates. Reduced motion removes confetti and wheel rotation and uses a slow walk.
- About includes the creator, Genesis campaign and source links.

## Install, preview, rebuild

You need Node 18 or newer (developed on Node 24).

```sh
npm ci            # install the exact versions from package-lock.json
npm run dev       # dev server with hot reload
npm test          # unit tests for the pure game logic (Vitest)
npm run typecheck # tsc --noEmit
npm run build     # typecheck, then build the static export into dist/
npm run preview   # serve dist/ locally to check the production build
npm run og        # regenerate public/og.png and public/favicon.svg (pixel art from code)
```

`dist/` is committed and is the deliverable. Vite's `base` is `./`, every asset URL is relative and routing uses the hash (`#/shop`), so the export works from an IPFS gateway subpath, an ENS name or any static host without rewrites. After changing source, run `npm run build` and commit `dist/` again.

## Project layout

| Path | What it holds |
| --- | --- |
| `src/logic.ts` | Pure game rules: decay, sync earnings, the hourly cap, away earnings, Squeek days, quests, festivals, growth, items, save validation and the save code. No DOM, clock or network. |
| `src/api.ts` | API paths, poll intervals, response parsing (decimal strings, `"status":"unavailable"`), fetch with timeout and `Retry-After`. |
| `src/i18n.ts` | English/Vietnamese dictionary, language defaults and all `Intl` formatting. |
| `src/share.ts` | Local canvas composition and PNG encoding; reuses the scene renderer. |
| `src/art.ts` | Original pixel art drawn on a 240x144 canvas: hamster poses, hats, wheel skins, backgrounds. |
| `src/main.ts` | The app: state, polling, the clock, hash routing and the five screens plus the adopt flow. |
| `src/audio.ts` | Optional Web Audio blips, off until the player turns sound on. |
| `src/styles.css` | Design tokens and all styles. See `DESIGN.md`. |
| `tests/logic.test.ts`, `tests/v2.test.ts` | Existing rules plus festival regressions, migration, earnings, away settlement, records and localization. |
| `scripts/make-og.mjs` | Builds the share image and favicon from the hamster pixel rows. |
| `dist/` | The committed static export. |

## Data: the Squeekchain API

Base URL `https://api.squeekchain.com/v1` (public, read-only, no key). Big numbers arrive as decimal strings: counters are parsed with `BigInt` (`big()` in `src/api.ts`) and display values with a strict decimal parser (`num()`). A response, or a nested object, with `"status":"unavailable"` makes its values unknown (`null`, shown as "n/a"), never zero.

Polling runs only while the tab is visible, and never faster than:

| Endpoint | Every | Fields used | Used for |
| --- | --- | --- | --- |
| `GET /status` | 15 s | `measurement.coreStatus` (`ACTIVE`, `IDLE`, `COUNTER_FAULT`) | Running, Resting or Sensor fault pill; whether the pet runs or naps together |
| | | `measurement.freshness` (`online` / `stale`) | Stale readings show "Reading is stale" and never earn Seeds |
| | | `measurement.rpmMilli` | RPM = value / 1000 |
| | | `measurement.speedMmPerSecond` | km/h = value x 0.0036 |
| | | `measurement.distanceMm` | km today = value / 1,000,000; the "runs 2 km this Squeek day" quest |
| | | `measurement.cumulativeWorkUnits` | Difference between polls = new magnet passes = Seeds while running |
| | | `builder.anchor.blockHeight` | Block number; "be here when a new Squeek block lands" quest |
| | | `builder.anchor.blockProgress` | Progress bar = value / 1e9 |
| `GET /measurement/stats?range=7d` | 5 min | `activity.days[].date`, `.buckets[48].startMinuteUtc`, `.workUnits` | Away earnings. A Squeek day runs 12:00 to 12:00 UTC, named by its starting noon: buckets with `startMinuteUtc >= 720` are on `date`, the rest on the next calendar day |
| | | `records.peakObservedSpeedMmPerSecond`, `records.maximumDailyDistanceMm`, `records.peakObservedRpmMilli`, `records.mostWorkHalfHour`, each `{ value, occurredAt }` | Home records, with km/h = mm/s × 0.0036; km = mm / 1e6; rpm = milli / 1000. Dates in UTC. |
| `GET /events?category=measurement&limit=20` | 2 min | `events[].id`, `.type`, `.occurredAt`, `.payload` | Festivals plus three newest known milestones, including `measurement.distance_streak`. Uses `thresholdDistanceMm`, `recordMmPerSecond`, `days`, `minimumDailyDistanceMm`; unknown types are ignored. |

“Last ran” uses `lastRanAt()` and the latest positive `workUnits` bucket start, with the same Squeek-day noon mapping as away earnings. It is an estimate with 30-minute granularity, explained by the label’s tooltip. Empty or unknown logs show `n/a`.

On 429 the endpoint waits for `Retry-After` (seconds or an HTTP date) before its next call. A request times out after 10 s. When `/status` fails or is unavailable, the live strip says "Can't reach the wheel right now. Your pet is fine and the game keeps going." and the game stays playable from the saved state. The stream link goes to https://sepolia.squeekchain.com.

## Game rules

All numbers live in `src/logic.ts`.

- **Stats** are 0 to 100. Hunger rises; Happiness, Energy and Cleanliness fall. Per hour: idle hunger +5, happiness -3, energy -3, cleanliness -2.5; running hunger +10, energy -12, cleanliness -4; napping energy +8, or **+16 when napping together** while the real wheel is IDLE (2x faster).
- **Closed page**: decay continues from the saved `lastTick` timestamp, capped at 12 hours.
- **Grumpy, never dead**: hunger >= 80, or happiness or cleanliness <= 20, makes the pet grumpy (storm cloud, slower animation). Stats only clamp at 0 and 100.
- **Sync run**: when `coreStatus` is `ACTIVE`, the reading is `online` and the pet has Energy >= 20, the pet runs in its wheel. Each new magnet pass between two polls gives 1 Seed (2 during a festival), at most **600 Seeds per real hour** (a fixed one-hour window stored in the save). The pass baseline lives only in memory, so a reload or a long absence never pays twice.
- **Away earnings**: on return after 5 minutes or more, the 7-day buckets inside the time away (at most 12 h, partial buckets prorated) are summed and 50% is credited as Seeds, shown as "While you were away, Squeektoshi ran X passes; your pet earned Y Seeds" with a Collect button.
- **Care**: Feed (sunflower seed, carrot, mealworm, each with its own price and effect; bought in the Shop or bought on the spot from the Feed menu), Play (free finger chase, or a ball, chew stick or tunnel once bought), Clean, Pet (free, +3 happiness, 10 per Squeek day).
- **Growth**: XP from care (1 to 6), sync runs (1 XP per 10 passes) and quests (25). Pup 0, Junior 150, Adult 600, Wheel Legend 2000 XP. The sprite grows with each stage; Wheel Legend wears a medal.
- **Shop**: foods, toys and cosmetics (3 hats, 3 wheel skins, 3 cage backgrounds). Cosmetics are worn in the Wardrobe and drawn on the pet and scene.
- **Daily quests**: 3 per Squeek day, reset at 12:00 UTC, picked deterministically from the day: two use live data (2 km run, a new block while open, 200 passes running together, 10 minutes napping together) and one care quest. Each has a progress bar and a Claim button.
- **Festivals**: a qualifying event with an id not seen before and newer than the last one seen starts a one-hour 2x Seeds festival with a banner. On the first fetch only events from the last hour count, and an event before the pet’s `bornAt` never starts a festival. The initial watermark is fixed for the whole fetched batch, including cached events applied on adoption.
- **Kind copy**: the game never asks Squeektoshi to run. Naps are good too.

## Save

One versioned key, `squeek-pet:v1`, holding `{ v: 1, ... }`. About > Save code exports the save as `SQPET1:` + base64 JSON, and loads a pasted code after validating every field (`parseSave`). Start over clears the key after a confirmation.

The v1 schema and `SQPET1:` export prefix stay unchanged. New fields are optional in stored/imported JSON; `parseSave` normalizes them into the runtime `Save`:

| Field | Default for old saves | Meaning |
| --- | --- | --- |
| `seedsEarned` | `0` | Lifetime credited Seeds from runs, collected away rewards and claimed quests. Never reduced by spending. Excludes the initial 50-Seed gift; old earned totals cannot be reconstructed from a balance. |
| `language` | Browser language (`vi*` → `vi`, otherwise `en`) | Saved language overrides the browser after migration. `html.lang` and metadata update with the UI. |
| `awaySettledThrough` | `0` | End of the last settled away window; already settled time cannot generate another card or payment. |

A small `squeek-pet:language` preference also remembers the language before adoption. Once adopted, the language in `squeek-pet:v1` is authoritative, and travels with save codes. A new pet starts with the currently selected language. Unknown away logs remain pending until a later normal stats poll supplies known buckets; no extra requests are made.

## Validation

**Final local results:** production build, typecheck and all 45 unit tests passed. Chromium interaction validation passed 92/92 checks; 20 axe scans had no violations, and taste@1 passed 16/16 checks. All five screens reflowed at 320/390/768/1440 in EN and VI. The real API loaded successfully in Chromium. WebKit could not launch because host libraries are missing; Safari, screen readers and the physical OS share sheet remain unverified.

Actual checks and the consolidated six-domain Better Interface review are in [artifacts/validation.md](artifacts/validation.md). The final export is served under a subpath for browser validation. The verification record distinguishes real API observations, deterministic mocked interactions, and unavailable native-device/WebKit checks.

Project dependencies, manifest, lockfile and build configuration are unchanged. Test-only browser tooling was installed outside the repository; no registry, archives, cache or browser dependencies are bundled with the static site. The production export contains only the HTML, two current Vite assets, favicon and Open Graph image. Final path/byte inspection found no forbidden changes, generated dependency/cache files or submodules in the submission; changed/new deliverable content is under 300 KiB against the 8 MiB limit. `.gitignore` only adds a budgeted allowlist for the two validation/license documents (24 KiB and 16 KiB respectively).
