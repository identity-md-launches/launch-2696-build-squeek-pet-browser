// Pure game rules. Nothing here touches the DOM, the clock or the network:
// every function takes "now" and data in, and returns new values out.
import { languageFor, translate, type Language } from './i18n';

export const HOUR = 3_600_000;
export const MINUTE = 60_000;
export const DAY = 24 * HOUR;
export const MAX_AWAY_MS = 12 * HOUR;
export const HOURLY_SEED_CAP = 600;
export const FESTIVAL_MS = HOUR;
export const PET_DAILY_CAP = 10;
export const MIN_RUN_ENERGY = 20;
export const SAVE_VERSION = 1;

export type StatKey = 'hunger' | 'happiness' | 'energy' | 'cleanliness';
export type Stats = Record<StatKey, number>;

/** What the pet is doing, which decides how stats drift. */
export type Mode = 'idle' | 'run' | 'nap' | 'napTogether' | 'away';

/** Change per hour. Hunger rises; the others fall, except energy while napping. */
export const RATES: Record<Mode, Stats> = {
  idle: { hunger: 5, happiness: -3, energy: -3, cleanliness: -2.5 },
  run: { hunger: 10, happiness: -1, energy: -12, cleanliness: -4 },
  nap: { hunger: 3, happiness: -1, energy: 8, cleanliness: -1 },
  // Nap together: the real wheel is IDLE, so energy recovers 2x faster.
  napTogether: { hunger: 3, happiness: -1, energy: 16, cleanliness: -1 },
  away: { hunger: 5, happiness: -3, energy: -2, cleanliness: -2.5 },
};

export const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));

export function clampStats(s: Stats): Stats {
  return {
    hunger: clamp(s.hunger),
    happiness: clamp(s.happiness),
    energy: clamp(s.energy),
    cleanliness: clamp(s.cleanliness),
  };
}

/** Apply `ms` of drift in the given mode. Negative or NaN time does nothing. */
export function decay(stats: Stats, ms: number, mode: Mode): Stats {
  if (!(ms > 0)) return { ...stats };
  const h = ms / HOUR;
  const r = RATES[mode];
  return clampStats({
    hunger: stats.hunger + r.hunger * h,
    happiness: stats.happiness + r.happiness * h,
    energy: stats.energy + r.energy * h,
    cleanliness: stats.cleanliness + r.cleanliness * h,
  });
}

/** Decay for the time the page was closed, capped at 12 hours. */
export function offlineDecay(stats: Stats, lastTick: number, now: number): { stats: Stats; appliedMs: number } {
  const appliedMs = Math.min(MAX_AWAY_MS, Math.max(0, now - lastTick));
  return { stats: decay(stats, appliedMs, 'away'), appliedMs };
}

export function isGrumpy(s: Stats): boolean {
  return s.hunger >= 80 || s.happiness <= 20 || s.cleanliness <= 20;
}

export type CoreStatus = 'ACTIVE' | 'IDLE' | 'COUNTER_FAULT' | 'UNKNOWN';

export interface Wheel {
  coreStatus: CoreStatus;
  online: boolean;
}

/** Decide what the pet does from the real wheel and its own energy. */
export function petMode(wheel: Wheel | null, stats: Stats): Mode {
  const live = wheel && wheel.online;
  if (live && wheel.coreStatus === 'ACTIVE' && stats.energy >= MIN_RUN_ENERGY) return 'run';
  if (live && wheel.coreStatus === 'IDLE') return 'napTogether';
  if (stats.energy < MIN_RUN_ENERGY) return 'nap';
  return 'idle';
}

// ---------- Sync run earnings ----------

export interface HourWindow {
  start: number;
  seeds: number;
}

export interface SyncResult {
  passes: number;
  seeds: number;
  window: HourWindow;
  capped: boolean;
}

/** Roll the hourly window forward if the hour is over. */
export function currentWindow(w: HourWindow, now: number): HourWindow {
  return now - w.start >= HOUR || now < w.start ? { start: now, seeds: 0 } : w;
}

/** Seeds still available in this real hour. */
export function seedsLeftThisHour(w: HourWindow, now: number): number {
  return Math.max(0, HOURLY_SEED_CAP - currentWindow(w, now).seeds);
}

/**
 * Seeds for new magnet passes between two polls. Earns only when the wheel is
 * ACTIVE and online and the pet is running (energy >= 20). 1 pass = 1 Seed,
 * 2 during a festival, never more than 600 Seeds per real hour.
 */
export function syncEarnings(
  prevWork: bigint | null,
  curWork: bigint | null,
  wheel: Wheel,
  energy: number,
  window: HourWindow,
  now: number,
  festival: boolean,
): SyncResult {
  const w = currentWindow(window, now);
  const none = { passes: 0, seeds: 0, window: w, capped: false };
  if (prevWork === null || curWork === null) return none;
  if (!(wheel.online && wheel.coreStatus === 'ACTIVE' && energy >= MIN_RUN_ENERGY)) return none;
  const diff = curWork - prevWork;
  if (diff <= 0n) return none;
  // A pass count far above what a wheel could do in a minute means the
  // baseline is old; cap the BigInt before turning it into a Number.
  const passes = Number(diff > 100_000n ? 100_000n : diff);
  const wanted = passes * (festival ? 2 : 1);
  const left = Math.max(0, HOURLY_SEED_CAP - w.seeds);
  const seeds = Math.min(wanted, left);
  return { passes, seeds, window: { start: w.start, seeds: w.seeds + seeds }, capped: wanted > left };
}

// ---------- Squeek days and 7-day buckets ----------

/** A Squeek day runs 12:00 to 12:00 UTC and is named by its starting noon (YYYY-MM-DD). */
export function squeekDay(ms: number): string {
  const d = new Date(ms - 12 * HOUR);
  return d.toISOString().slice(0, 10);
}

/** Epoch ms when the Squeek day named `day` starts (its noon UTC). */
export function squeekDayStart(day: string): number {
  return Date.parse(`${day}T12:00:00Z`);
}

export function nextResetAt(ms: number): number {
  return squeekDayStart(squeekDay(ms)) + DAY;
}

export interface Bucket {
  startMinuteUtc: number;
  workUnits: number | null;
}
export interface ActivityDay {
  date: string;
  observedWorkUnits: number | null;
  distanceMm: number | null;
  buckets: Bucket[];
}

/** Absolute start of a 30-minute bucket. Minutes >= 720 are on `date`, the rest on the next calendar day. */
export function bucketStart(date: string, startMinuteUtc: number): number {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  return midnight + (startMinuteUtc >= 720 ? 0 : DAY) + startMinuteUtc * MINUTE;
}

/** Start of the newest known bucket with work, not the last zero/unknown bucket.
 * Half-hour granularity: this is an estimate, never an invented exact run time. */
export function lastRanAt(days: ActivityDay[], now: number): number | null {
  let latest: number | null = null;
  for (const day of days) for (const b of day.buckets) {
    if (b.workUnits === null || !Number.isFinite(b.workUnits) || b.workUnits <= 0) continue;
    const at = bucketStart(day.date, b.startMinuteUtc);
    if (Number.isFinite(at) && at <= now && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

/**
 * Work units the real wheel logged between `from` and `to` (capped at 12 h),
 * prorating buckets that only partly overlap. Returns null when no bucket
 * covering the window has a known value.
 */
export function workBetween(days: ActivityDay[], from: number, to: number, bucketMs = 30 * MINUTE): number | null {
  const start = Math.max(from, to - MAX_AWAY_MS);
  if (!(to > start)) return 0;
  let total = 0;
  let known = false;
  for (const day of days) {
    for (const b of day.buckets) {
      if (b.workUnits === null || !Number.isFinite(b.workUnits)) continue;
      const bs = bucketStart(day.date, b.startMinuteUtc);
      const be = bs + bucketMs;
      const overlap = Math.min(be, to) - Math.max(bs, start);
      if (overlap <= 0) continue;
      known = true;
      total += b.workUnits * (overlap / bucketMs);
    }
  }
  return known ? Math.round(total) : null;
}

/** 50% of the passes become Seeds, never above the hourly cap for that time. */
export function awaySeeds(passes: number, awayMs: number): number {
  const ms = Math.min(MAX_AWAY_MS, Math.max(0, awayMs));
  const cap = Math.ceil((ms / HOUR) * HOURLY_SEED_CAP);
  return Math.max(0, Math.min(cap, Math.floor(passes * 0.5)));
}

// ---------- Growth ----------

export const STAGES = [
  { id: 'pup', xp: 0 },
  { id: 'junior', xp: 150 },
  { id: 'adult', xp: 600 },
  { id: 'legend', xp: 2000 },
] as const;
export type StageId = (typeof STAGES)[number]['id'];

export function stageFor(xp: number) {
  let s: (typeof STAGES)[number] = STAGES[0];
  for (const st of STAGES) if (xp >= st.xp) s = st;
  const idx = STAGES.indexOf(s);
  const next = STAGES[idx + 1] ?? null;
  const progress = next ? (xp - s.xp) / (next.xp - s.xp) : 1;
  return { stage: s, next, progress: clamp(progress, 0, 1) };
}

/** XP for sync running: 1 XP per 10 passes. */
export const runXp = (passes: number) => Math.floor(passes / 10);

// ---------- Items ----------

export type ItemKind = 'food' | 'toy' | 'hat' | 'skin' | 'bg';
export interface Item {
  id: string;
  kind: ItemKind;
  price: number;
  effect?: Partial<Stats>;
}

export const ITEMS: Item[] = [
  { id: 'sunflower', kind: 'food', price: 4, effect: { hunger: -15, happiness: 2 } },
  { id: 'carrot', kind: 'food', price: 10, effect: { hunger: -25, happiness: 5, energy: 5 } },
  { id: 'mealworm', kind: 'food', price: 22, effect: { hunger: -30, happiness: 12, energy: 10 } },
  { id: 'ball', kind: 'toy', price: 30, effect: { happiness: 15, energy: -8, hunger: 3 } },
  { id: 'chew', kind: 'toy', price: 45, effect: { happiness: 12, energy: -4, cleanliness: 4 } },
  { id: 'tunnel', kind: 'toy', price: 70, effect: { happiness: 22, energy: -10, hunger: 4 } },
  { id: 'hat-party', kind: 'hat', price: 80 },
  { id: 'hat-flower', kind: 'hat', price: 120 },
  { id: 'hat-top', kind: 'hat', price: 200 },
  { id: 'skin-classic', kind: 'skin', price: 0 },
  { id: 'skin-sunset', kind: 'skin', price: 100 },
  { id: 'skin-mint', kind: 'skin', price: 100 },
  { id: 'skin-galaxy', kind: 'skin', price: 250 },
  { id: 'bg-cozy', kind: 'bg', price: 0 },
  { id: 'bg-meadow', kind: 'bg', price: 120 },
  { id: 'bg-night', kind: 'bg', price: 150 },
  { id: 'bg-library', kind: 'bg', price: 150 },
];
export const itemById = (id: string) => ITEMS.find((i) => i.id === id);

/** Free play when the pet has no toys yet. */
export const FREE_PLAY: Partial<Stats> = { happiness: 8, energy: -5, hunger: 2 };
export const CLEAN_EFFECT: Partial<Stats> = { cleanliness: 45, happiness: 2 };
export const PET_EFFECT: Partial<Stats> = { happiness: 3 };

export function applyEffect(s: Stats, e: Partial<Stats>): Stats {
  return clampStats({
    hunger: s.hunger + (e.hunger ?? 0),
    happiness: s.happiness + (e.happiness ?? 0),
    energy: s.energy + (e.energy ?? 0),
    cleanliness: s.cleanliness + (e.cleanliness ?? 0),
  });
}

// ---------- Quests ----------

export type QuestId = 'distance2km' | 'newBlock' | 'runBeside' | 'napTogether' | 'pet5' | 'feed3' | 'clean1' | 'play2';

export interface QuestDef {
  id: QuestId;
  target: number;
  unit: string;
  reward: number;
  live: boolean;
}

export const QUESTS: Record<QuestId, QuestDef> = {
  distance2km: { id: 'distance2km', target: 2_000_000, unit: 'mm', reward: 60, live: true },
  newBlock: { id: 'newBlock', target: 1, unit: 'block', reward: 40, live: true },
  runBeside: { id: 'runBeside', target: 200, unit: 'passes', reward: 50, live: true },
  napTogether: { id: 'napTogether', target: 10, unit: 'min', reward: 30, live: true },
  pet5: { id: 'pet5', target: 5, unit: 'pets', reward: 20, live: false },
  feed3: { id: 'feed3', target: 3, unit: 'meals', reward: 25, live: false },
  clean1: { id: 'clean1', target: 1, unit: 'clean', reward: 15, live: false },
  play2: { id: 'play2', target: 2, unit: 'games', reward: 25, live: false },
};

const LIVE_QUESTS: QuestId[] = ['distance2km', 'newBlock', 'runBeside', 'napTogether'];
const CARE_QUESTS: QuestId[] = ['pet5', 'feed3', 'clean1', 'play2'];

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Three quests per Squeek day: two tied to real data, one care quest. Deterministic per day. */
export function questsForDay(day: string): QuestId[] {
  const h = hash(day);
  const a = LIVE_QUESTS[h % 4];
  const rest = LIVE_QUESTS.filter((q) => q !== a);
  const b = rest[(h >>> 8) % 3];
  const c = CARE_QUESTS[(h >>> 16) % 4];
  return [a, b, c];
}

export interface QuestState {
  day: string;
  ids: QuestId[];
  progress: Partial<Record<QuestId, number>>;
  claimed: QuestId[];
}

export function freshQuests(day: string): QuestState {
  return { day, ids: questsForDay(day), progress: {}, claimed: [] };
}

/** Reset quests when the Squeek day (12:00 UTC boundary) changes. */
export function rollQuests(q: QuestState | null, now: number): QuestState {
  const day = squeekDay(now);
  return q && q.day === day ? q : freshQuests(day);
}

/** Add progress to a quest. `set` replaces the value (used for real distance). */
export function bumpQuest(q: QuestState, id: QuestId, amount: number, set = false): QuestState {
  if (!q.ids.includes(id)) return q;
  const cur = q.progress[id] ?? 0;
  const next = set ? Math.max(cur, amount) : cur + amount;
  if (next === cur) return q;
  return { ...q, progress: { ...q.progress, [id]: next } };
}

export function questDone(q: QuestState, id: QuestId): boolean {
  return (q.progress[id] ?? 0) >= QUESTS[id].target;
}

// ---------- Festivals ----------

export interface MilestoneEvent {
  id: string;
  type: string;
  occurredAt: string;
  payload?: {
    thresholdDistanceMm: number | null;
    recordMmPerSecond: number | null;
    days: number | null;
    minimumDailyDistanceMm: number | null;
  };
}

export const FESTIVAL_TYPES = new Set([
  'measurement.speed_record',
  'measurement.distance_milestone',
  'measurement.daily_distance_milestone',
]);

export interface FestivalState {
  until: number;
  watermark: number | null; // newest occurredAt seen (ms), null before the first fetch
  seenIds: string[];
  lastType: string | null;
}

export const emptyFestival = (): FestivalState => ({ until: 0, watermark: null, seenIds: [], lastType: null });

export const festivalActive = (f: FestivalState, now: number) => now < f.until;

/**
 * Start a 1-hour 2x festival for a qualifying event that is newer than the
 * last one seen and has an id we have not seen. On the very first fetch only
 * an event from the last hour counts, so old records don't start festivals.
 */
export function processEvents(f: FestivalState, events: MilestoneEvent[], now: number, bornAt = -Infinity): { state: FestivalState; started: MilestoneEvent | null } {
  const qualifying = events
    .filter((e) => FESTIVAL_TYPES.has(e.type) && Number.isFinite(Date.parse(e.occurredAt)) && Date.parse(e.occurredAt) <= now)
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  let watermark = f.watermark;
  // Freeze the eligibility boundary for the entire batch. Updating it inside
  // the loop lets the second old event through on a first fetch/adoption.
  const cutoff = f.watermark ?? now - FESTIVAL_MS;
  const seen = new Set(f.seenIds);
  let started: MilestoneEvent | null = null;
  for (const e of qualifying) {
    const t = Date.parse(e.occurredAt);
    const fresh = t > cutoff && t >= bornAt;
    if (fresh && !seen.has(e.id)) started = e;
    seen.add(e.id);
    if (watermark === null || t > watermark) watermark = t;
  }
  if (watermark === null) watermark = now - FESTIVAL_MS;
  const seenIds = [...seen].slice(-60);
  if (!started) return { state: { ...f, watermark, seenIds }, started: null };
  return { state: { until: now + FESTIVAL_MS, watermark, seenIds, lastType: started.type }, started };
}

// ---------- Save ----------

export const FURS = [
  { id: 'golden', fur: '#d99a4e', light: '#f6dfb8', dark: '#5a3418' },
  { id: 'cream', fur: '#eed5ad', light: '#fff6e6', dark: '#6b4b2e' },
  { id: 'cocoa', fur: '#8a5a3c', light: '#d9b48f', dark: '#341c0f' },
  { id: 'silver', fur: '#a7a3ad', light: '#ecebef', dark: '#3a3740' },
] as const;
export type FurId = (typeof FURS)[number]['id'];

export interface Save {
  v: number;
  pet: { name: string; fur: FurId; xp: number; bornAt: number };
  stats: Stats;
  seeds: number;
  seedsEarned: number;
  language: Language;
  lastTick: number;
  lastSeen: number;
  hour: HourWindow;
  pantry: Record<string, number>;
  owned: string[];
  equipped: { hat: string | null; skin: string; bg: string };
  pets: { day: string; count: number };
  quests: QuestState;
  festival: FestivalState;
  away: { passes: number; seeds: number } | null;
  awayPending: { from: number; to: number } | null;
  awaySettledThrough: number;
  muted: boolean;
}

export function newSave(name: string, fur: FurId, now: number, language: Language = 'en'): Save {
  return {
    v: SAVE_VERSION,
    pet: { name, fur, xp: 0, bornAt: now },
    stats: { hunger: 20, happiness: 80, energy: 80, cleanliness: 90 },
    seeds: 50,
    seedsEarned: 0,
    language,
    lastTick: now,
    lastSeen: now,
    hour: { start: now, seeds: 0 },
    pantry: { sunflower: 5 },
    owned: ['skin-classic', 'bg-cozy'],
    equipped: { hat: null, skin: 'skin-classic', bg: 'bg-cozy' },
    pets: { day: squeekDay(now), count: 0 },
    quests: freshQuests(squeekDay(now)),
    festival: emptyFestival(),
    away: null,
    awayPending: null,
    awaySettledThrough: 0,
    muted: true,
  };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validate and normalise untrusted save data (localStorage or an import code). */
export function parseSave(raw: unknown, now: number, browserLanguage = 'en'): Save | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>;
  if (r.v !== SAVE_VERSION || !r.pet || typeof r.pet.name !== 'string' || !r.stats) return null;
  const fur = FURS.some((f) => f.id === r.pet.fur) ? (r.pet.fur as FurId) : 'golden';
  const base = newSave(r.pet.name.slice(0, 20) || translate(languageFor(browserLanguage), 'defaultName'), fur, now);
  const stats = r.stats;
  if (![stats.hunger, stats.happiness, stats.energy, stats.cleanliness].every(isNum)) return null;
  const owned = Array.isArray(r.owned) ? r.owned.filter((id: unknown) => typeof id === 'string' && itemById(id)) : base.owned;
  for (const id of base.owned) if (!owned.includes(id)) owned.push(id);
  const eq = r.equipped ?? {};
  const pantry: Record<string, number> = {};
  if (r.pantry && typeof r.pantry === 'object') {
    for (const [k, v] of Object.entries(r.pantry)) if (itemById(k)?.kind === 'food' && isNum(v) && v > 0) pantry[k] = Math.floor(v);
  }
  const q = r.quests;
  const quests: QuestState =
    q && typeof q.day === 'string' && Array.isArray(q.ids) ? { day: q.day, ids: q.ids, progress: q.progress ?? {}, claimed: q.claimed ?? [] } : base.quests;
  const f = r.festival;
  return {
    ...base,
    pet: { name: base.pet.name, fur, xp: isNum(r.pet.xp) ? Math.max(0, r.pet.xp) : 0, bornAt: isNum(r.pet.bornAt) ? r.pet.bornAt : now },
    stats: clampStats(stats),
    seeds: isNum(r.seeds) ? Math.max(0, Math.floor(r.seeds)) : 0,
    seedsEarned: isNum(r.seedsEarned) ? Math.max(0, Math.floor(r.seedsEarned)) : 0,
    language: r.language === 'en' || r.language === 'vi' ? r.language : languageFor(browserLanguage),
    lastTick: isNum(r.lastTick) ? Math.min(r.lastTick, now) : now,
    lastSeen: isNum(r.lastSeen) ? Math.min(r.lastSeen, now) : now,
    hour: r.hour && isNum(r.hour.start) && isNum(r.hour.seeds) ? r.hour : base.hour,
    pantry,
    owned,
    equipped: {
      hat: typeof eq.hat === 'string' && owned.includes(eq.hat) ? eq.hat : null,
      skin: typeof eq.skin === 'string' && owned.includes(eq.skin) ? eq.skin : 'skin-classic',
      bg: typeof eq.bg === 'string' && owned.includes(eq.bg) ? eq.bg : 'bg-cozy',
    },
    pets: r.pets && typeof r.pets.day === 'string' && isNum(r.pets.count) ? r.pets : base.pets,
    quests,
    festival: f && isNum(f.until) && Array.isArray(f.seenIds) ? { until: f.until, watermark: isNum(f.watermark) ? f.watermark : null, seenIds: f.seenIds, lastType: f.lastType ?? null } : base.festival,
    away: r.away && isNum(r.away.passes) && isNum(r.away.seeds) ? r.away : null,
    awayPending: r.awayPending && isNum(r.awayPending.from) && isNum(r.awayPending.to) ? r.awayPending : null,
    awaySettledThrough: isNum(r.awaySettledThrough) ? Math.min(now, Math.max(0, r.awaySettledThrough)) : 0,
    muted: r.muted !== false,
  };
}

/** One credit path for runs, collected away earnings and claimed quests.
 * The adoption gift and food purchases never count as lifetime earnings. */
export function earnSeeds(s: Save, amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) return;
  const credit = Math.floor(amount);
  s.seeds += credit;
  s.seedsEarned += credit;
}

/** Preserve unresolved away time across reloads and exclude settled windows. */
export function queueAway(s: Save, from: number, to: number) {
  const start = Math.max(s.pet.bornAt, s.awaySettledThrough, to - MAX_AWAY_MS, Math.min(from, s.awayPending?.from ?? from));
  if (to > start) s.awayPending = { from: start, to };
}

/** Settle only known buckets, exactly once, independently of request order. */
export function settleAwayEarnings(s: Save, days: ActivityDay[]): boolean {
  if (!s.awayPending) return false;
  const { to } = s.awayPending;
  const from = Math.max(s.awayPending.from, s.awaySettledThrough, s.pet.bornAt);
  if (to <= from) { s.awayPending = null; return false; }
  const passes = workBetween(days, from, to);
  if (passes === null) return false;
  s.away = { passes: passes + (s.away?.passes ?? 0), seeds: awaySeeds(passes, to - from) + (s.away?.seeds ?? 0) };
  s.awaySettledThrough = to;
  s.awayPending = null;
  return true;
}

const CODE_PREFIX = 'SQPET1:';

export function encodeSave(s: Save): string {
  const json = JSON.stringify(s);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return CODE_PREFIX + btoa(bin);
}

export function decodeSave(code: string, now: number, browserLanguage = 'en'): Save | null {
  const t = code.trim();
  if (!t.startsWith(CODE_PREFIX)) return null;
  try {
    const bin = atob(t.slice(CODE_PREFIX.length));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return parseSave(JSON.parse(new TextDecoder().decode(bytes)), now, browserLanguage);
  } catch {
    return null;
  }
}
