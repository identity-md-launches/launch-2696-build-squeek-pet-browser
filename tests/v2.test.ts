import { describe, expect, it } from 'vitest';
import {
  DAY, HOUR, MINUTE, QUESTS, earnSeeds, emptyFestival, festivalActive, lastRanAt, newSave, parseSave,
  processEvents, queueAway, settleAwayEarnings, syncEarnings, type ActivityDay, type MilestoneEvent,
} from '../src/logic';
import { parseEvents, parseStats } from '../src/api';
import { formatNumber, languageFor, messages, relativeTime, translate } from '../src/i18n';

const T = Date.parse('2026-10-30T08:05:00Z');
const event = (id: string, at: string, type = 'measurement.distance_milestone'): MilestoneEvent => ({ id, occurredAt: at, type });
const days: ActivityDay[] = [{ date: '2026-10-29', observedWorkUnits: 400, distanceMm: null, buckets: [
  { startMinuteUtc: 360, workUnits: 100 }, { startMinuteUtc: 390, workUnits: 100 },
  { startMinuteUtc: 420, workUnits: 100 }, { startMinuteUtc: 450, workUnits: 100 },
] }];

describe('v2 festival regression', () => {
  const old = [
    event('40km', '2026-10-30T04:04:30.819Z'),
    event('daily10km', '2026-10-30T03:35:00.643Z', 'measurement.daily_distance_milestone'),
    event('record', '2026-10-28T21:28:20.307Z', 'measurement.speed_record'),
  ];
  it('08:05 first visit: the whole first batch is old, latest at 04:04:30Z; no festival', () => {
    const freshSave = newSave('Pip', 'golden', T);
    // Exercise the first-fetch cutoff independently from the birth boundary.
    expect(processEvents(freshSave.festival, old, T).started).toBeNull();
    const result = processEvents(freshSave.festival, old, T, freshSave.pet.bornAt);
    expect(result.started).toBeNull();
    expect(festivalActive(result.state, T)).toBe(false);
    expect(result.state.watermark).toBe(Date.parse(old[0].occurredAt));
    expect(processEvents(emptyFestival(), [...old].reverse(), T).started).toBeNull();
  });
  it('cached pre-adoption events in the last hour never give the newly adopted pet a festival', () => {
    const cached = [event('recent', '2026-10-30T08:04:59.999Z')];
    const save = newSave('Pip', 'golden', T);
    const r = processEvents(save.festival, cached, T + 100, save.pet.bornAt);
    expect(r.started).toBeNull();
    expect(r.state.until).toBe(0);
    const next = processEvents(r.state, [event('olderBirth', '2026-10-30T08:04:59.999Z', 'measurement.speed_record')], T + MINUTE, save.pet.bornAt);
    expect(next.started).toBeNull();
    expect(processEvents(next.state, [event('new', '2026-10-30T08:05:30Z')], T + MINUTE, save.pet.bornAt).started?.id).toBe('new');
  });
  it('filters pre-birth events even when their timestamp is newer than an existing watermark', () => {
    const save = newSave('Pip', 'golden', T);
    const state = { ...save.festival, watermark: T - 2 * HOUR };
    expect(processEvents(state, [event('before', '2026-10-30T08:04:00Z')], T, save.pet.bornAt).started).toBeNull();
  });
  it('does not let a future event poison the watermark, and does not replay a known batch', () => {
    const r = processEvents(emptyFestival(), [event('future', '2026-10-31T00:00:00Z')], T);
    expect(r.started).toBeNull();
    const n = processEvents(r.state, [event('now', '2026-10-30T08:05:00Z')], T + MINUTE, T);
    expect(n.started?.id).toBe('now');
    expect(processEvents(n.state, [event('now', '2026-10-30T08:05:00Z')], T + 2 * MINUTE, T).started).toBeNull();
  });
});

describe('last ran calculation', () => {
  it('finds the newest positive bucket, with Squeek-day noon mapping', () => {
    expect(lastRanAt(days, T)).toBe(Date.parse('2026-10-30T07:30:00Z'));
    const input: ActivityDay[] = [{ date: '2026-10-30', distanceMm: null, observedWorkUnits: null, buckets: [
      { startMinuteUtc: 720, workUnits: 12 }, // future at noon, ignored
      { startMinuteUtc: 300, workUnits: 0 },
    ] }, ...days];
    expect(lastRanAt(input, T)).toBe(Date.parse('2026-10-30T07:30:00Z'));
  });
  it('ignores zero, null and invalid work; returns unknown when no run is known', () => {
    expect(lastRanAt([], T)).toBeNull();
    expect(lastRanAt([{ ...days[0], buckets: [{ startMinuteUtc: 300, workUnits: 0 }, { startMinuteUtc: 330, workUnits: null }, { startMinuteUtc: 360, workUnits: NaN }] }], T)).toBeNull();
  });
  it('uses the latest bucket across unsorted days and unsorted buckets', () => {
    const noon = Date.parse('2026-10-30T12:30:00Z');
    expect(lastRanAt([{ ...days[0], date: '2026-10-30', buckets: [{ startMinuteUtc: 720, workUnits: 2 }] }, ...days], noon)).toBe(noon - 30 * MINUTE);
  });
});

describe('lifetime earnings and migration', () => {
  it('accumulates actual run, away and quest credits; purchases never subtract lifetime earnings', () => {
    const save = newSave('Pip', 'golden', T - DAY);
    expect(save.seedsEarned).toBe(0); // adoption gift is not earnings
    const run = syncEarnings(100n, 130n, { coreStatus: 'ACTIVE', online: true }, 80, { start: T, seeds: 0 }, T, false);
    earnSeeds(save, run.seeds);
    expect(save.seedsEarned).toBe(30);
    queueAway(save, Date.parse('2026-10-30T06:00:00Z'), Date.parse('2026-10-30T08:00:00Z'));
    expect(settleAwayEarnings(save, days)).toBe(true);
    expect(save.away?.seeds).toBe(200);
    earnSeeds(save, save.away!.seeds);
    save.away = null;
    earnSeeds(save, QUESTS.pet5.reward);
    expect(save.seedsEarned).toBe(250);
    expect(save.seeds).toBe(300);
    save.seeds -= 22;
    expect(save.seedsEarned).toBe(250);
    expect(parseSave(JSON.parse(JSON.stringify(save)), T)?.seedsEarned).toBe(250);
  });
  it('migrates an existing v1 save with no new fields, preserving the entire old pet', () => {
    const original = newSave('Bông', 'cream', T - DAY);
    original.pet.xp = 650;
    original.seeds = 123;
    const { seedsEarned: _, language: __, awaySettledThrough: ___, ...v1 } = original;
    const migrated = parseSave(v1, T, 'vi-VN')!;
    expect(migrated).toMatchObject({ ...v1, seedsEarned: 0, language: 'vi', awaySettledThrough: 0 });
    expect(parseSave(v1, T, 'en-GB')?.language).toBe('en');
    expect(parseSave({ ...v1, seedsEarned: -20, language: 'xx' }, T, 'vi')?.seedsEarned).toBe(0);
  });
  it('preserves the saved language over browser language', () => {
    const save = newSave('Pip', 'golden', T, 'vi');
    expect(parseSave(save, T, 'en-US')?.language).toBe('vi');
  });
});

describe('away request ordering and idempotency', () => {
  it.each(['status-first', 'stats-first'])('settles once in %s order and survives reload/collect', (order) => {
    let save = newSave('Pip', 'golden', T - DAY);
    const from = Date.parse('2026-10-30T06:00:00Z');
    const to = Date.parse('2026-10-30T08:00:00Z');
    queueAway(save, from, to);
    if (order === 'status-first') expect(settleAwayEarnings(save, [])).toBe(false);
    expect(settleAwayEarnings(save, days)).toBe(true);
    expect(settleAwayEarnings(save, days)).toBe(false);
    earnSeeds(save, save.away!.seeds);
    save.away = null;
    save = parseSave(JSON.parse(JSON.stringify(save)), T)!;
    queueAway(save, from, to);
    expect(settleAwayEarnings(save, days)).toBe(false);
    expect(save.away).toBeNull();
    expect(save.seedsEarned).toBe(200);
  });
  it('preserves unresolved pending time across a reload and extends it without overlap', () => {
    const save = newSave('Pip', 'golden', T - DAY);
    const from = Date.parse('2026-10-30T06:00:00Z');
    queueAway(save, from, from + HOUR);
    expect(settleAwayEarnings(save, [])).toBe(false);
    queueAway(save, from + HOUR, from + 2 * HOUR);
    expect(save.awayPending).toEqual({ from, to: from + 2 * HOUR });
    expect(settleAwayEarnings(save, days)).toBe(true);
    expect(save.away).toEqual({ passes: 400, seeds: 200 });
  });
});

describe('live records and milestone payloads', () => {
  it('parses actual record objects, units and dates; keeps unavailable records unknown', () => {
    const at = '2026-10-28T21:28:20.307Z';
    const stats = parseStats({ records: {
      peakObservedSpeedMmPerSecond: { value: '1628', occurredAt: at },
      maximumDailyDistanceMm: { value: '11674766', occurredAt: at },
      peakObservedRpmMilli: { value: '111256', occurredAt: at },
      mostWorkHalfHour: { value: '1827', occurredAt: at },
    } })!;
    expect(stats.records.peakSpeed).toEqual({ value: 1628, occurredAt: at });
    expect(stats.records.maxDailyDistance.value! / 1e6).toBe(11.674766);
    expect(stats.records.peakRpm.value! / 1000).toBe(111.256);
    expect(stats.records.mostWorkHalfHour.value).toBe(1827);
    expect(parseStats({ records: { status: 'unavailable' } })?.records.peakSpeed.value).toBeNull();
    expect(parseStats({ records: { peakObservedRpmMilli: { status: 'unavailable', value: '1' } } })?.records.peakRpm.value).toBeNull();
  });
  it('retains all four numeric milestone fields and leaves missing values unknown', () => {
    const events = parseEvents({ events: [{ id: '1', type: 'measurement.distance_streak', occurredAt: new Date(T).toISOString(), payload: { thresholdDistanceMm: '40000000', recordMmPerSecond: '1628', days: 4, minimumDailyDistanceMm: '5000000' } }] })!;
    expect(events[0].payload).toEqual({ thresholdDistanceMm: 40000000, recordMmPerSecond: 1628, days: 4, minimumDailyDistanceMm: 5000000 });
  });
});

describe('EN / VI dictionary', () => {
  it('has a nonempty translation and matching interpolation tokens for every key', () => {
    for (const [key, [en, vi]] of Object.entries(messages)) {
      expect(en.trim().length, key).toBeGreaterThan(0);
      expect(vi.trim().length, key).toBeGreaterThan(0);
      expect([...en.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(), key).toEqual([...vi.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort());
    }
  });
  it('uses browser language defaults, Vietnamese punctuation and relative dates', () => {
    expect(languageFor('vi-VN')).toBe('vi');
    expect(languageFor('VI')).toBe('vi');
    expect(languageFor('fr-FR')).toBe('en');
    expect(formatNumber('vi', 1234.5, 1)).toBe('1.234,5');
    expect(formatNumber('en', 1234.5, 1)).toBe('1,234.5');
    expect(relativeTime('vi', T - 4 * HOUR, T)).toContain('4 giờ');
    expect(translate('vi', 'ate', { name: 'Bông', item: 'cà rốt' })).toBe('Bông vừa ăn cà rốt.');
  });
});
