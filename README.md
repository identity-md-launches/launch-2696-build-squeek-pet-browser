# Squeek Pet

A browser virtual pet. Your pixel hamster runs and naps in sync with Squeektoshi, the real hamster whose wheel powers Squeekchain (a proof-of-work toychain on Ethereum Sepolia).

This is an unofficial fan game. Testnet values have no monetary value. It is a static site with no backend, no wallet, no trackers and no analytics. The game saves in `localStorage`.

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
| `src/art.ts` | Original pixel art drawn on a 240x144 canvas: hamster poses, hats, wheel skins, backgrounds. |
| `src/main.ts` | The app: state, polling, the clock, hash routing and the five screens plus the adopt flow. |
| `src/audio.ts` | Optional Web Audio blips, off until the player turns sound on. |
| `src/styles.css` | Design tokens and all styles. See `DESIGN.md`. |
| `tests/logic.test.ts` | Unit tests for the rules and the parsers. |
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
| | | `records.peakObservedSpeedMmPerSecond`, `records.maximumDailyDistanceMm` | Parsed; not shown yet |
| `GET /events?category=measurement&limit=20` | 2 min | `events[].id`, `.type`, `.occurredAt` | Festivals from `measurement.speed_record`, `measurement.distance_milestone`, `measurement.daily_distance_milestone` |

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
- **Festivals**: a qualifying event with an id not seen before and newer than the last one seen starts a one-hour 2x Seeds festival with a banner. On the first fetch only events from the last hour count, so old records do not start festivals.
- **Kind copy**: the game never asks Squeektoshi to run. Naps are good too.

## Save

One versioned key, `squeek-pet:v1`, holding `{ v: 1, ... }`. About > Save code exports the save as `SQPET1:` + base64 JSON, and loads a pasted code after validating every field (`parseSave`). Start over clears the key after a confirmation.

## Validation

Recorded results from the final build are in `artifacts/validation.md`: commands, unit and browser interaction tests, the design probe and the Better Interface review. Summary:

- `npm run build` (tsc + Vite): passes. `npm test`: 28 unit tests pass.
- Browser interaction script in Chromium (served from a local subpath): 35 of 36 checks pass. The failing one is the real-network run: from this build machine `api.squeekchain.com` answers with a Cloudflare challenge page (HTTP 403, no CORS header), so live numbers from the real API could not be observed here. The same flows were verified against mocked responses in the documented shape, and the blocked case shows the offline state with the game playable.
- WebKit could not launch on this machine (missing system libraries), so Safari behavior is unverified.
- The design probe (taste@1) passed 16 of 16 checks on the entry page at 320, 390 and 1440 wide.
