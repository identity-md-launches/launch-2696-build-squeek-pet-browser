import { describe, expect, it } from 'vitest';
import {
  awaySeeds, bucketStart, decay, decodeSave, encodeSave, HOUR, MINUTE, newSave, nextResetAt, offlineDecay, petMode,
  processEvents, emptyFestival, questsForDay, rollQuests, bumpQuest, questDone, squeekDay, stageFor, syncEarnings, workBetween,
  type ActivityDay,
} from '../src/logic';
import { parseStatus, parseStats, parseEvents, retryAfterMs, big } from '../src/api';

const base = { hunger: 20, happiness: 80, energy: 80, cleanliness: 90 };
const T = Date.parse('2026-10-30T15:00:00Z');
const active = { coreStatus: 'ACTIVE' as const, online: true };

describe('decay', () => {
  it('hunger rises, others fall while idle', () => {
    const s = decay(base, 2 * HOUR, 'idle');
    expect(s.hunger).toBe(30);
    expect(s.happiness).toBe(74);
    expect(s.energy).toBe(74);
    expect(s.cleanliness).toBe(85);
  });
  it('napping together recovers energy 2x faster than a plain nap', () => {
    const nap = decay({ ...base, energy: 10 }, HOUR, 'nap').energy - 10;
    const together = decay({ ...base, energy: 10 }, HOUR, 'napTogether').energy - 10;
    expect(together).toBe(nap * 2);
  });
  it('offline decay is capped at 12 hours', () => {
    const a = offlineDecay(base, T - 12 * HOUR, T);
    const b = offlineDecay(base, T - 40 * HOUR, T);
    expect(b.appliedMs).toBe(12 * HOUR);
    expect(b.stats).toEqual(a.stats);
  });
  it('closing for 2 hours applies exactly 2 hours of decay', () => {
    const r = offlineDecay(base, T - 2 * HOUR, T);
    expect(r.appliedMs).toBe(2 * HOUR);
    expect(r.stats.hunger).toBe(30);
  });
  it('stats stay in 0..100', () => {
    const s = decay(base, 1000 * HOUR, 'run');
    expect(s.hunger).toBe(100);
    expect(s.energy).toBe(0);
  });
});

describe('pet mode', () => {
  it('runs only when ACTIVE, online and energy >= 20', () => {
    expect(petMode(active, base)).toBe('run');
    expect(petMode(active, { ...base, energy: 19 })).toBe('nap');
    expect(petMode({ coreStatus: 'ACTIVE', online: false }, base)).toBe('idle');
    expect(petMode({ coreStatus: 'IDLE', online: true }, base)).toBe('napTogether');
    expect(petMode(null, base)).toBe('idle');
  });
});

describe('sync earnings', () => {
  const w = { start: T, seeds: 0 };
  it('1 pass = 1 Seed while ACTIVE', () => {
    const r = syncEarnings(100n, 130n, active, 80, w, T + 15_000, false);
    expect(r.passes).toBe(30);
    expect(r.seeds).toBe(30);
  });
  it('earns nothing while IDLE, faulted, stale or tired', () => {
    expect(syncEarnings(100n, 130n, { coreStatus: 'IDLE', online: true }, 80, w, T, false).seeds).toBe(0);
    expect(syncEarnings(100n, 130n, { coreStatus: 'COUNTER_FAULT', online: true }, 80, w, T, false).seeds).toBe(0);
    expect(syncEarnings(100n, 130n, { coreStatus: 'ACTIVE', online: false }, 80, w, T, false).seeds).toBe(0);
    expect(syncEarnings(100n, 130n, active, 19, w, T, false).seeds).toBe(0);
  });
  it('needs a baseline and ignores counter going backwards', () => {
    expect(syncEarnings(null, 130n, active, 80, w, T, false).seeds).toBe(0);
    expect(syncEarnings(200n, 130n, active, 80, w, T, false).seeds).toBe(0);
  });
  it('caps at 600 Seeds per real hour, then resets', () => {
    let win = w;
    let total = 0;
    for (let i = 0; i < 480; i++) {
      const r = syncEarnings(0n, 50n, active, 80, win, T + i * 15_000, false);
      total += r.seeds;
      win = r.window;
    }
    expect(total).toBe(600 + 600); // two hours at 15 s polls
    const r = syncEarnings(0n, 50n, active, 80, { start: T, seeds: 590 }, T + 1000, false);
    expect(r.seeds).toBe(10);
    expect(r.capped).toBe(true);
  });
  it('festival doubles Seeds but not the cap', () => {
    expect(syncEarnings(0n, 10n, active, 80, w, T, true).seeds).toBe(20);
    expect(syncEarnings(0n, 1000n, active, 80, w, T, true).seeds).toBe(600);
  });
  it('handles counters beyond Number precision', () => {
    const a = big('9007199254740993000')!;
    expect(syncEarnings(a, a + 7n, active, 80, w, T, false).seeds).toBe(7);
  });
});

describe('squeek day', () => {
  it('runs 12:00 to 12:00 UTC named by its starting noon', () => {
    expect(squeekDay(Date.parse('2026-10-30T11:59:59Z'))).toBe('2026-10-29');
    expect(squeekDay(Date.parse('2026-10-30T12:00:00Z'))).toBe('2026-10-30');
    expect(nextResetAt(Date.parse('2026-10-30T08:00:00Z'))).toBe(Date.parse('2026-10-30T12:00:00Z'));
  });
  it('places buckets on date or the next calendar day', () => {
    expect(bucketStart('2026-10-29', 720)).toBe(Date.parse('2026-10-29T12:00:00Z'));
    expect(bucketStart('2026-10-29', 0)).toBe(Date.parse('2026-10-30T00:00:00Z'));
    expect(bucketStart('2026-10-29', 690)).toBe(Date.parse('2026-10-30T11:30:00Z'));
  });
});

describe('away earnings', () => {
  const day: ActivityDay = {
    date: '2026-10-29',
    observedWorkUnits: null,
    distanceMm: null,
    buckets: Array.from({ length: 48 }, (_, i) => ({ startMinuteUtc: (720 + i * 30) % 1440, workUnits: 100 })),
  };
  it('sums buckets inside the time away, prorating edges', () => {
    const from = Date.parse('2026-10-30T01:00:00Z');
    expect(workBetween([day], from, from + 2 * HOUR)).toBe(400);
    expect(workBetween([day], from + 15 * MINUTE, from + 45 * MINUTE)).toBe(100);
  });
  it('caps the window at 12 hours', () => {
    const to = Date.parse('2026-10-30T11:00:00Z');
    expect(workBetween([day], to - 30 * HOUR, to)).toBe(2400);
  });
  it('returns null when nothing covers the window', () => {
    expect(workBetween([day], T + 10 * HOUR, T + 12 * HOUR)).toBeNull();
  });
  it('credits 50% as Seeds within the hourly cap', () => {
    expect(awaySeeds(400, 2 * HOUR)).toBe(200);
    expect(awaySeeds(10_000, 1 * HOUR)).toBe(600);
  });
});

describe('quests', () => {
  it('picks 3 distinct quests per day, deterministic', () => {
    const q = questsForDay('2026-10-30');
    expect(new Set(q).size).toBe(3);
    expect(questsForDay('2026-10-30')).toEqual(q);
  });
  it('resets at 12:00 UTC', () => {
    const before = rollQuests(null, Date.parse('2026-10-30T11:59:00Z'));
    const same = rollQuests(before, Date.parse('2026-10-30T11:59:59Z'));
    const after = rollQuests(same, Date.parse('2026-10-30T12:00:01Z'));
    expect(same).toBe(before);
    expect(after.day).toBe('2026-10-30');
    expect(after).not.toBe(before);
  });
  it('tracks progress and completion', () => {
    let q = { day: 'x', ids: ['pet5', 'distance2km', 'newBlock'] as const, progress: {}, claimed: [] } as any;
    for (let i = 0; i < 5; i++) q = bumpQuest(q, 'pet5', 1);
    expect(questDone(q, 'pet5')).toBe(true);
    q = bumpQuest(q, 'distance2km', 1_500_000, true);
    q = bumpQuest(q, 'distance2km', 1_000_000, true); // never goes backwards
    expect(q.progress.distance2km).toBe(1_500_000);
    expect(bumpQuest(q, 'feed3', 1)).toBe(q); // not today's quest
  });
});

describe('festivals', () => {
  const ev = (id: string, type: string, at: number) => ({ id, type, occurredAt: new Date(at).toISOString() });
  it('first fetch ignores old milestones but not one from the last hour', () => {
    const old = processEvents(emptyFestival(), [ev('a', 'measurement.speed_record', T - 3 * HOUR)], T);
    expect(old.started).toBeNull();
    const fresh = processEvents(emptyFestival(), [ev('b', 'measurement.distance_milestone', T - 10 * MINUTE)], T);
    expect(fresh.started?.id).toBe('b');
    expect(fresh.state.until).toBe(T + HOUR);
  });
  it('starts once per new event id, ignores other types', () => {
    const a = processEvents(emptyFestival(), [ev('a', 'measurement.speed_record', T - 3 * HOUR)], T);
    const b = processEvents(a.state, [ev('x', 'measurement.speed_milestone', T + 1000), ev('a', 'measurement.speed_record', T - 3 * HOUR)], T + 2000);
    expect(b.started).toBeNull();
    const c = processEvents(b.state, [ev('n', 'measurement.daily_distance_milestone', T + 5000)], T + 6000);
    expect(c.started?.id).toBe('n');
    const d = processEvents(c.state, [ev('n', 'measurement.daily_distance_milestone', T + 5000)], T + 7000);
    expect(d.started).toBeNull();
    expect(d.state.until).toBe(c.state.until);
  });
});

describe('growth and save', () => {
  it('stages by XP', () => {
    expect(stageFor(0).stage.id).toBe('pup');
    expect(stageFor(150).stage.id).toBe('junior');
    expect(stageFor(600).stage.id).toBe('adult');
    expect(stageFor(5000).stage.id).toBe('legend');
  });
  it('round-trips a save code and rejects junk', () => {
    const s = newSave('Pip Ümlaut', 'cocoa', T);
    s.seeds = 123;
    const back = decodeSave(encodeSave(s), T);
    expect(back?.pet.name).toBe('Pip Ümlaut');
    expect(back?.seeds).toBe(123);
    expect(decodeSave('hello', T)).toBeNull();
    expect(decodeSave('SQPET1:%%%', T)).toBeNull();
  });
});

describe('api parsing', () => {
  it('treats unavailable as unknown, never zero', () => {
    expect(parseStatus({ status: 'unavailable' })).toBeNull();
    const s = parseStatus({ measurement: { status: 'unavailable' }, builder: { anchor: { blockHeight: '12', blockProgress: '500000000' } } })!;
    expect(s.coreStatus).toBe('UNKNOWN');
    expect(s.rpm).toBeNull();
    expect(s.blockHeight).toBe(12);
    expect(s.blockProgress).toBe(0.5);
    expect(parseStats({ status: 'unavailable' })).toBeNull();
    expect(parseEvents({ status: 'unavailable' })).toBeNull();
  });
  it('parses decimal strings', () => {
    const s = parseStatus({
      measurement: { coreStatus: 'ACTIVE', freshness: 'online', rpmMilli: '42500', speedMmPerSecond: '310', distanceMm: '1234567', cumulativeWorkUnits: '123456789012345678901' },
      builder: { anchor: { blockHeight: '4321', blockProgress: '250000000' } },
    })!;
    expect(s.rpm).toBe(42.5);
    expect(s.work).toBe(123456789012345678901n);
    expect(s.online).toBe(true);
  });
  it('reads Retry-After', () => {
    expect(retryAfterMs('30', 0)).toBe(30_000);
    expect(retryAfterMs(null, 0)).toBeNull();
  });
});
