// Read-only client for the public Squeekchain API. Parsing is pure and
// exported for tests; fetching adds a timeout and honours 429 Retry-After.
import type { ActivityDay, CoreStatus, MilestoneEvent } from './logic';

export const API_BASE = 'https://api.squeekchain.com/v1';
export const STREAM_URL = 'https://sepolia.squeekchain.com';

export const POLL = {
  status: 15_000,
  stats: 5 * 60_000,
  events: 2 * 60_000,
} as const;
export type Endpoint = keyof typeof POLL;

export const PATHS: Record<Endpoint, string> = {
  status: '/status',
  stats: '/measurement/stats?range=7d',
  events: '/events?category=measurement&limit=20',
};

/** A decimal string or number to Number, or null if unknown. */
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A decimal integer string to BigInt (exact for large counters), or null. */
export function big(v: unknown): bigint | null {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return BigInt(v.trim());
  return null;
}

const unavailable = (o: unknown) => !!o && typeof o === 'object' && (o as { status?: unknown }).status === 'unavailable';

export interface LiveStatus {
  coreStatus: CoreStatus;
  online: boolean;
  rpm: number | null;
  speedMmPerSecond: number | null;
  distanceMm: number | null;
  work: bigint | null;
  blockHeight: number | null;
  blockProgress: number | null; // 0..1
}

export function parseStatus(raw: any): LiveStatus | null {
  if (!raw || typeof raw !== 'object' || unavailable(raw)) return null;
  const m = unavailable(raw.measurement) ? null : raw.measurement;
  const a = unavailable(raw.builder) || unavailable(raw.builder?.anchor) ? null : raw.builder?.anchor;
  if (!m && !a) return null;
  const cs = m?.coreStatus;
  const coreStatus: CoreStatus = cs === 'ACTIVE' || cs === 'IDLE' || cs === 'COUNTER_FAULT' ? cs : 'UNKNOWN';
  const rpmMilli = num(m?.rpmMilli);
  const progress = num(a?.blockProgress);
  return {
    coreStatus,
    online: m?.freshness === 'online',
    rpm: rpmMilli === null ? null : rpmMilli / 1000,
    speedMmPerSecond: num(m?.speedMmPerSecond),
    distanceMm: num(m?.distanceMm),
    work: big(m?.cumulativeWorkUnits),
    blockHeight: num(a?.blockHeight),
    blockProgress: progress === null ? null : Math.min(1, Math.max(0, progress / 1e9)),
  };
}

export interface LiveStats {
  days: ActivityDay[];
  peakSpeedMmPerSecond: number | null;
  maxDailyDistanceMm: number | null;
}

export function parseStats(raw: any): LiveStats | null {
  if (!raw || typeof raw !== 'object' || unavailable(raw)) return null;
  const act = unavailable(raw.activity) ? null : raw.activity;
  const days: ActivityDay[] = Array.isArray(act?.days)
    ? act.days
        .filter((d: any) => d && typeof d.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date))
        .map((d: any) => ({
          date: d.date,
          observedWorkUnits: num(d.observedWorkUnits),
          distanceMm: num(d.distanceMm),
          buckets: Array.isArray(d.buckets)
            ? d.buckets
                .map((b: any) => ({ startMinuteUtc: num(b?.startMinuteUtc), workUnits: num(b?.workUnits) }))
                .filter((b: any) => b.startMinuteUtc !== null)
            : [],
        }))
    : [];
  const rec = unavailable(raw.records) ? null : raw.records;
  return {
    days,
    peakSpeedMmPerSecond: num(rec?.peakObservedSpeedMmPerSecond),
    maxDailyDistanceMm: num(rec?.maximumDailyDistanceMm),
  };
}

export function parseEvents(raw: any): MilestoneEvent[] | null {
  if (!raw || typeof raw !== 'object' || unavailable(raw) || !Array.isArray(raw.events)) return null;
  return raw.events
    .filter((e: any) => e && (typeof e.id === 'string' || typeof e.id === 'number') && typeof e.type === 'string')
    .map((e: any) => ({ id: String(e.id), type: e.type, occurredAt: String(e.occurredAt ?? '') }));
}

export type FetchResult = { ok: true; data: unknown } | { ok: false; retryAfterMs: number | null; reason: 'rate' | 'http' | 'network' | 'timeout' };

/** Retry-After as seconds or an HTTP date, to milliseconds. */
export function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const s = Number(header);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(header);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

export async function getJson(endpoint: Endpoint, timeoutMs = 10_000): Promise<FetchResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(API_BASE + PATHS[endpoint], { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (res.status === 429) return { ok: false, reason: 'rate', retryAfterMs: retryAfterMs(res.headers.get('retry-after'), Date.now()) };
    if (!res.ok) return { ok: false, reason: 'http', retryAfterMs: null };
    return { ok: true, data: await res.json() };
  } catch (err) {
    const timeout = err instanceof DOMException && err.name === 'AbortError';
    return { ok: false, reason: timeout ? 'timeout' : 'network', retryAfterMs: null };
  } finally {
    clearTimeout(timer);
  }
}
