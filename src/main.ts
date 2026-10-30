import './styles.css';
import { drawScene, drawPortrait, H, W, type Pose } from './art';
import { getJson, parseEvents, parseStats, parseStatus, POLL, STREAM_URL, type Endpoint, type LiveStats, type LiveStatus } from './api';
import { blip } from './audio';
import { formatDate, formatNumber, formatPercent, formatTime, languageFor, relativeTime, translate, type Language, type MessageKey, type Variables } from './i18n';
import { makeShareImage } from './share';
import {
  applyEffect, earnSeeds, queueAway, settleAwayEarnings, lastRanAt, bumpQuest, CLEAN_EFFECT, decodeSave, encodeSave, festivalActive, FREE_PLAY, FURS, HOUR, isGrumpy,
  ITEMS, itemById, MINUTE, newSave, nextResetAt, offlineDecay, parseSave, PET_DAILY_CAP, PET_EFFECT, petMode, processEvents,
  questDone, QUESTS, rollQuests, runXp, seedsLeftThisHour, squeekDay, stageFor, syncEarnings, decay, workBetween,
  type FurId, type ItemKind, type MilestoneEvent, type Mode, type QuestId, type Save, type StatKey, type Wheel,
} from './logic';

const KEY = 'squeek-pet:v1';
const AWAY_MIN_MS = 5 * MINUTE;

// ---------- state ----------
let save: Save | null = load();
let language: Language = save?.language ?? preferredLanguage();
let shareImage: { url: string; file: File } | null = null;
let shareBusy = false;
let shareGeneration = 0;
let eventsDown = false;
let live: LiveStatus | null = null;
let liveAt = 0;
let stats: LiveStats | null = null;
let conn: 'loading' | 'ok' | 'down' = 'loading';
let lastWork: bigint | null = null; // in memory only: passes while closed are paid by away earnings
let lastBlock: number | null = null; // in memory only: a block counts only while the page is open
let lastEvents: MilestoneEvent[] | null = null; // kept so an adoption can use the latest fetch
let actionPose: { pose: Pose; until: number } | null = null;
let picker: 'feed' | 'play' | null = null;
let adoptFur: FurId = 'golden';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const t = (key: MessageKey, vars: Variables = {}) => translate(language, key, vars);
const fmt = (n: number, d = 0) => formatNumber(language, n, d);
const pct = (n: number) => formatPercent(language, n);
const itemName = (id: string) => t(`item.${id}` as MessageKey);
const itemNote = (id: string) => t(`note.${id}` as MessageKey);
const statLabel = (key: StatKey) => t(`stat.${key}`);
const stageName = (id: ReturnType<typeof stageFor>['stage']['id']) => t(`stage.${id}`);
const ago = (at: number) => relativeTime(language, at, Date.now());
function preferredLanguage(): Language {
  try {
    const pref = localStorage.getItem('squeek-pet:language');
    if (pref === 'en' || pref === 'vi') return pref;
  } catch { /* browser preference still works without storage */ }
  return languageFor(navigator.language);
}

function load(): Save | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? parseSave(JSON.parse(raw), Date.now(), navigator.language) : null;
  } catch {
    return null;
  }
}
function persist() {
  if (!save) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(save));
  } catch {
    /* storage full or blocked: the game keeps running in memory */
  }
}

// ---------- derived ----------
function wheel(): Wheel | null {
  if (!live || conn === 'down') return null;
  return { coreStatus: live.coreStatus, online: live.online };
}
function mode(): Mode {
  return save ? petMode(wheel(), save.stats) : 'idle';
}
function pose(now: number): Pose {
  if (!save) return 'happy';
  if (actionPose && now < actionPose.until) return actionPose.pose;
  const m = mode();
  if (m === 'run') return 'run';
  if (m === 'nap' || m === 'napTogether') return 'sleep';
  return isGrumpy(save.stats) ? 'grumpy' : 'idle';
}
function moodLine(): string {
  if (!save) return '';
  const name = save.pet.name;
  const m = mode();
  if (m === 'run') return t('mood.run', { name });
  if (m === 'napTogether') return t('mood.napTogether', { name });
  if (m === 'nap') return t('mood.nap', { name });
  if (isGrumpy(save.stats)) {
    if (save.stats.hunger >= 80) return t('mood.hungry', { name });
    if (save.stats.cleanliness <= 20) return t('mood.messy', { name });
    return t('mood.lonely', { name });
  }
  if (live?.coreStatus === 'ACTIVE' && conn === 'ok') return t('mood.tired', { name });
  return t('mood.idle', { name });
}

// ---------- game actions ----------
let toastTimer = 0;
function toast(msg: string) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = '';
  clearTimeout(toastTimer);
  requestAnimationFrame(() => (t.textContent = msg));
  toastTimer = window.setTimeout(() => (t.textContent = ''), 4000);
}
function animate(p: Pose, ms = 2400) {
  actionPose = { pose: p, until: Date.now() + ms };
}
function addXp(n: number) {
  if (!save || n <= 0) return;
  const before = stageFor(save.pet.xp).stage.id;
  save.pet.xp += n;
  const after = stageFor(save.pet.xp).stage;
  if (after.id !== before) {
    toast(t('grew', { name: save.pet.name, stage: stageName(after.id) }));
    blip('grow', save.muted);
  }
}
function quest(id: QuestId, amount: number, set = false) {
  if (!save) return;
  save.quests = bumpQuest(rollQuests(save.quests, Date.now()), id, amount, set);
}

function feed(id: string) {
  if (!save) return;
  const item = itemById(id);
  if (!item || item.kind !== 'food') return;
  if ((save.pantry[id] ?? 0) <= 0) {
    if (save.seeds < item.price) return toast(t('needFood', { price: fmt(item.price), item: itemName(item.id) }));
    save.seeds -= item.price;
  } else save.pantry[id] -= 1;
  save.stats = applyEffect(save.stats, item.effect ?? {});
  quest('feed3', 1);
  addXp(5);
  animate('eat');
  blip('eat', save.muted);
  toast(t('ate', { name: save.pet.name, item: itemName(item.id) }));
  picker = null;
  commit();
}
function play(id: string | null) {
  if (!save) return;
  if (save.stats.energy < 15) return toast(t('sleepy', { name: save.pet.name }));
  const item = id ? itemById(id) : null;
  if (id && (!item || !save.owned.includes(id))) return;
  save.stats = applyEffect(save.stats, item?.effect ?? FREE_PLAY);
  quest('play2', 1);
  addXp(item ? 6 : 3);
  animate('happy');
  blip('happy', save.muted);
  toast(item ? t('played', { name: save.pet.name, item: itemName(item.id) }) : t('fingerChased', { name: save.pet.name }));
  picker = null;
  commit();
}
function clean() {
  if (!save) return;
  if (save.stats.cleanliness >= 95) return toast(t('spotless'));
  save.stats = applyEffect(save.stats, CLEAN_EFFECT);
  quest('clean1', 1);
  addXp(3);
  animate('happy', 1600);
  blip('clean', save.muted);
  toast(t('cleaned'));
  commit();
}
function pet() {
  if (!save) return;
  const day = squeekDay(Date.now());
  if (save.pets.day !== day) save.pets = { day, count: 0 };
  if (save.pets.count >= PET_DAILY_CAP) return toast(t('petLimit', { name: save.pet.name, time: formatTime(language, nextResetAt(Date.now())) }));
  save.pets.count += 1;
  save.stats = applyEffect(save.stats, PET_EFFECT);
  quest('pet5', 1);
  addXp(1);
  animate('happy', 1400);
  blip('pet', save.muted);
  toast(t('petted', { name: save.pet.name }));
  commit();
}
function buy(id: string) {
  if (!save) return;
  const item = itemById(id);
  if (!item) return;
  if (save.seeds < item.price) return toast(t('needMore', { count: fmt(item.price - save.seeds), item: itemName(item.id) }));
  if (item.kind !== 'food' && save.owned.includes(id)) return;
  save.seeds -= item.price;
  if (item.kind === 'food') save.pantry[id] = (save.pantry[id] ?? 0) + 1;
  else save.owned.push(id);
  blip('buy', save.muted);
  toast(t('bought', { item: itemName(item.id) }));
  commit();
}
function equip(kind: 'hat' | 'skin' | 'bg', id: string | null) {
  if (!save) return;
  if (id && !save.owned.includes(id)) return;
  if (kind === 'hat') save.equipped.hat = id;
  else if (id) save.equipped[kind] = id;
  blip('pet', save.muted);
  commit();
}
function claim(id: QuestId) {
  if (!save) return;
  save.quests = rollQuests(save.quests, Date.now());
  if (!save.quests.ids.includes(id) || save.quests.claimed.includes(id) || !questDone(save.quests, id)) return;
  save.quests = { ...save.quests, claimed: [...save.quests.claimed, id] };
  earnSeeds(save, QUESTS[id].reward);
  addXp(25);
  blip('buy', save.muted);
  toast(t('questDone', { count: fmt(QUESTS[id].reward) }));
  commit();
}
function collectAway() {
  if (!save?.away) return;
  earnSeeds(save, save.away.seeds);
  addXp(runXp(save.away.passes * 0.5));
  toast(t('collected', { count: fmt(save.away.seeds) }));
  save.away = null;
  commit();
}

function commit() {
  persist();
  render();
}

// ---------- clock ----------
let lastTickWall = Date.now();
function tick() {
  const now = Date.now();
  if (!save) return;
  if (document.visibilityState !== 'visible') return;
  const gap = now - save.lastTick;
  if (gap >= AWAY_MIN_MS || now - lastTickWall > AWAY_MIN_MS) {
    arrive(now);
  } else if (gap > 0) {
    const m = mode();
    save.stats = decay(save.stats, gap, m);
    if (m === 'napTogether') quest('napTogether', gap / MINUTE);
    save.lastTick = now;
  }
  save.lastSeen = now;
  lastTickWall = now;
  const q = rollQuests(save.quests, now);
  if (q !== save.quests) {
    save.quests = q;
    render();
  }
  if (Math.floor(now / 1000) % 5 === 0) persist();
  paint();
}

/** Returning after time away: capped decay now, away Seeds once the 7-day log arrives. */
function arrive(now: number) {
  if (!save) return;
  const from = save.lastTick;
  const r = offlineDecay(save.stats, from, now);
  save.stats = r.stats;
  save.lastTick = now;
  lastWork = null;
  if (now - from >= AWAY_MIN_MS) queueAway(save, from, now);
  if (stats && lastFetched.stats >= now - 1000) settleAway();
  persist();
}
function settleAway() {
  if (!save?.awayPending || !stats || lastFetched.stats < save.awayPending.to) return;
  if (settleAwayEarnings(save, stats.days)) {
    persist();
    if (route() === 'home') render();
  }
}

// ---------- polling ----------
const nextAt: Record<Endpoint, number> = { status: 0, stats: 0, events: 0 };
const lastFetched: Record<Endpoint, number> = { status: 0, stats: 0, events: 0 };
const inflight: Record<Endpoint, boolean> = { status: false, stats: false, events: false };

async function poll(ep: Endpoint) {
  inflight[ep] = true;
  const started = Date.now();
  nextAt[ep] = started + POLL[ep];
  const res = await getJson(ep);
  inflight[ep] = false;
  const now = Date.now();
  if (!res.ok) {
    if (res.reason === 'rate' && res.retryAfterMs !== null) nextAt[ep] = Math.max(nextAt[ep], now + res.retryAfterMs);
    if (ep === 'stats') { stats = null; paintHomeData(); }
    if (ep === 'events') { eventsDown = true; paintHomeData(); }
    if (ep === 'status') {
      conn = 'down';
      lastWork = null;
      render();
    }
    return;
  }
  lastFetched[ep] = now;
  if (ep === 'status') onStatus(parseStatus(res.data), now);
  else if (ep === 'stats') {
    const s = parseStats(res.data);
    stats = s;
    if (s) settleAway();
    paintHomeData();
  } else {
    const ev = parseEvents(res.data);
    eventsDown = ev === null;
    if (ev) {
      lastEvents = ev;
      applyEvents(ev, now);
    }
    paintHomeData();
  }
}

function applyEvents(ev: MilestoneEvent[], now: number) {
  if (!save) return;
  const r = processEvents(save.festival, ev, now, save.pet.bornAt);
  save.festival = r.state;
  if (r.started) {
    toast(t('festivalStarted'));
    blip('grow', save.muted);
  }
  persist();
  if (r.started && route() === 'home') render();
}

function onStatus(s: LiveStatus | null, now: number) {
  if (!s) {
    // "unavailable": values are unknown, never zero
    live = null;
    conn = 'down';
    lastWork = null;
    render();
    return;
  }
  settleAway();
  const was = conn;
  live = s;
  liveAt = now;
  conn = 'ok';
  if (save) {
    const fest = festivalActive(save.festival, now);
    const r = syncEarnings(lastWork, s.work, { coreStatus: s.coreStatus, online: s.online }, save.stats.energy, save.hour, now, fest);
    save.hour = r.window;
    if (r.seeds > 0) {
      earnSeeds(save, r.seeds);
      addXp(runXp(r.passes));
      quest('runBeside', r.passes);
    }
    if (r.capped && r.seeds === 0) toast(t('seedReset', { time: formatTime(language, save.hour.start + HOUR) }));
    if (s.distanceMm !== null) quest('distance2km', s.distanceMm, true);
    if (s.blockHeight !== null && lastBlock !== null && s.blockHeight > lastBlock) {
      quest('newBlock', 1);
      toast(t('blockLanded', { count: fmt(s.blockHeight) }));
    }
    persist();
  }
  if (s.work !== null) lastWork = s.work;
  if (s.blockHeight !== null) lastBlock = s.blockHeight;
  if (was !== 'ok') render();
  else {
    paint();
    paintLive();
  }
}

function pump() {
  if (document.visibilityState !== 'visible') return;
  const now = Date.now();
  for (const ep of ['status', 'stats', 'events'] as Endpoint[]) {
    if (!inflight[ep] && now >= nextAt[ep]) void poll(ep);
  }
}

// ---------- rendering ----------
const STAT_KEYS: StatKey[] = ['hunger', 'happiness', 'energy', 'cleanliness'];

function route(): string {
  const r = location.hash.replace(/^#\/?/, '') || 'home';
  return ['home', 'shop', 'quests', 'wardrobe', 'about'].includes(r) ? r : 'home';
}

function liveStrip(): string {
  const heading = `<h2 id="live-h" class="h-sm">${t('live.heading')}</h2>`;
  const watch = `<p class="small"><a href="${STREAM_URL}" target="_blank" rel="noopener">${t('live.watch')}</a></p>`;
  if (conn === 'down' || (conn === 'ok' && !live)) {
    return `<section class="live" aria-labelledby="live-h">${heading}
      <p class="live-row"><span class="pill pill-off">${t('live.offline')}</span><span>${t('live.down')}</span></p>
      ${liveAt ? `<p class="muted small">${t('live.lastReading', { time: ago(liveAt) })}</p>` : ''}${watch}</section>`;
  }
  if (!live) return `<section class="live" aria-labelledby="live-h">${heading}
    <p class="live-row"><span class="pill">${t('live.checking')}</span><span class="muted">${t('live.looking')}</span></p></section>`;
  const st = live.coreStatus;
  const pill = st === 'ACTIVE' ? ['pill-run', 'live.active'] : st === 'IDLE' ? ['pill-rest', 'live.idle'] : st === 'COUNTER_FAULT' ? ['pill-off', 'live.fault'] : ['pill-off', 'live.unknown'];
  const kmh = live.speedMmPerSecond === null ? null : live.speedMmPerSecond * 0.0036;
  const km = live.distanceMm === null ? null : live.distanceMm / 1e6;
  const prog = live.blockProgress;
  const dash = `<span class="muted">${t('na')}</span>`;
  const lastRan = stats ? lastRanAt(stats.days, Date.now()) : null;
  return `<section class="live" aria-labelledby="live-h">
    <div class="live-head">${heading}<span class="pill ${pill[0]}" id="live-pill">${t(pill[1] as MessageKey)}</span>
      ${live.online ? '' : `<span class="muted small">${t('live.stale')}</span>`}</div>
    <dl class="live-grid">
      <div><dt>${t('live.rpm')}</dt><dd id="live-rpm">${live.rpm === null ? dash : fmt(live.rpm, 1)}</dd></div>
      <div><dt>${t('live.speed')}</dt><dd id="live-kmh">${kmh === null ? dash : `${fmt(kmh, 2)} km/h`}</dd></div>
      <div><dt>${t('live.today')}</dt><dd id="live-km">${km === null ? dash : `${fmt(km, 2)} km`}</dd></div>
      <div><dt>${t('live.block')}</dt><dd id="live-block">${live.blockHeight === null ? dash : fmt(live.blockHeight)}</dd></div>
    </dl>
    ${st === 'IDLE' ? `<p class="small muted" id="last-ran" title="${t('live.bucketNote')}">${t('live.lastRan', { time: lastRan === null ? t('na') : ago(lastRan) })}</p>` : ''}
    <div class="block-prog"><span class="small" id="block-label">${t('live.nextBlock', { progress: prog === null ? t('live.unknown').toLocaleLowerCase() : pct(prog) })}</span>
      <div class="bar" role="progressbar" aria-label="${t('live.progress')}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${prog === null ? 0 : Math.floor(prog * 100)}"><span id="block-bar" style="inline-size:${prog === null ? 0 : prog * 100}%"></span></div>
    </div>${watch}</section>`;
}

function recordsCard(): string {
  const rows: [MessageKey, keyof LiveStats['records'], number, number, string][] = [
    ['recordSpeed', 'peakSpeed', 0.0036, 2, 'km/h'],
    ['recordDistance', 'maxDailyDistance', 1e-6, 2, 'km'],
    ['recordRpm', 'peakRpm', 0.001, 1, t('live.rpm')],
    ['recordPasses', 'mostWorkHalfHour', 1, 0, ''],
  ];
  return `<section class="card records" aria-labelledby="records-h"><h2 class="h-sm" id="records-h">${t('records')}</h2>
    <dl class="records-grid">${rows.map(([label, key, scale, digits, unit]) => {
      const record = stats?.records[key];
      const value = record?.value;
      return `<div><dt class="small muted">${t(label)}</dt><dd><strong>${value === undefined || value === null ? t('na') : `${fmt(value * scale, digits)}${unit ? ` ${unit}` : ''}`}</strong>
        <span class="record-date small muted">${formatDate(language, record?.occurredAt ?? null)}</span></dd></div>`;
    }).join('')}</dl></section>`;
}

function milestoneLine(e: MilestoneEvent): string | null {
  const p = e.payload;
  if (!p) return null;
  switch (e.type) {
    case 'measurement.distance_milestone':
    case 'measurement.daily_distance_milestone':
      return p.thresholdDistanceMm === null ? null : t(e.type === 'measurement.distance_milestone' ? 'milestone.distance' : 'milestone.daily', { km: fmt(p.thresholdDistanceMm / 1e6, p.thresholdDistanceMm % 1e6 === 0 ? 0 : 1) });
    case 'measurement.speed_record':
      return p.recordMmPerSecond === null ? null : t('milestone.speed', { speed: fmt(p.recordMmPerSecond * 0.0036, 1) });
    case 'measurement.distance_streak':
      return p.days === null || p.minimumDailyDistanceMm === null ? null : t('milestone.streak', { days: fmt(p.days), km: fmt(p.minimumDailyDistanceMm / 1e6, p.minimumDailyDistanceMm % 1e6 === 0 ? 0 : 1) });
    default: return null;
  }
}

function milestonesCard(): string {
  const recent = (lastEvents ?? []).filter((e) => Number.isFinite(Date.parse(e.occurredAt)) && Date.parse(e.occurredAt) <= Date.now() && milestoneLine(e) !== null)
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)).slice(0, 3);
  return `<section class="milestones group" aria-labelledby="milestones-h"><h2 class="h-sm" id="milestones-h">${t('recent')}</h2>
    ${eventsDown || lastEvents === null ? `<p class="small muted">${t('milestonesDown')}</p>` : recent.length === 0 ? `<p class="small muted">${t('noMilestones')}</p>` : `<ul>${recent.map((e) => `<li>${milestoneLine(e)}<time class="small muted" datetime="${esc(e.occurredAt)}">${ago(Date.parse(e.occurredAt))}</time></li>`).join('')}</ul>`}</section>`;
}

function paintHomeData() {
  const data = $('.home-data');
  if (!data) return;
  const streamFocused = data.contains(document.activeElement) && document.activeElement?.tagName === 'A';
  data.innerHTML = liveStrip() + recordsCard() + milestonesCard();
  if (streamFocused) $<HTMLAnchorElement>('.live a')?.focus({ preventScroll: true });
}

function statBars(): string {
  if (!save) return '';
  return STAT_KEYS.map((k) => {
    const v = Math.round(save!.stats[k]);
    const low = k === 'hunger' ? v >= 70 : v <= 30;
    return `<div class="stat ${low ? 'stat-low' : ''}" id="stat-${k}">
      <span class="stat-label">${statLabel(k)}${low ? ` <span class="err-cue">${t(k === 'hunger' ? 'high' : 'low')}</span>` : ''}</span><span class="stat-val">${fmt(v)}</span>
      <div class="bar bar-${k}" role="meter" aria-label="${statLabel(k)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${v}"><span style="inline-size:${v}%"></span></div></div>`;
  }).join('');
}

function pickerHtml(): string {
  if (!save || !picker) return '';
  if (picker === 'feed') return `<div class="picker" id="picker" role="group" aria-label="${t('chooseFood')}">
    ${ITEMS.filter((i) => i.kind === 'food').map((f) => {
      const have = save!.pantry[f.id] ?? 0;
      const disabled = have === 0 && save!.seeds < f.price;
      const price = t('foodPrice', { price: t(`price.${f.price}` as MessageKey) });
      return `<button class="opt" data-feed="${f.id}" ${disabled ? 'aria-disabled="true"' : ''} aria-label="${esc(`${itemName(f.id)}. ${t('pantry', { count: fmt(have) })}. ${price}${disabled ? `. ${t('unaffordable')}` : ''}`)}">
        <strong>${itemName(f.id)}</strong><span class="small muted">${t('pantry', { count: fmt(have) })}</span>
        <span class="small muted">${have > 0 ? t('foodPrice', { price: fmt(f.price) }) : t('buyFeed', { price: fmt(f.price) })}${disabled ? ` · ${t('unaffordable')}` : ''}</span></button>`;
    }).join('')}</div>`;
  const toys = ITEMS.filter((i) => i.kind === 'toy' && save!.owned.includes(i.id));
  return `<div class="picker" id="picker" role="group" aria-label="${t('chooseGame')}">
    <button class="opt" data-play=""><strong>${t('finger')}</strong><span class="small muted">${t('free')}</span></button>
    ${toys.map((i) => `<button class="opt" data-play="${i.id}"><strong>${itemName(i.id)}</strong><span class="small muted">${itemNote(i.id)}</span></button>`).join('')}
    ${toys.length === 0 ? `<a class="opt opt-link" href="#/shop"><strong>${t('getToy')}</strong><span class="small muted">${t('toyList')}</span></a>` : ''}</div>`;
}

function sharePanel(): string {
  return `<div class="share-tools"><button class="btn btn-sm" data-act="share-card" aria-expanded="${!!shareImage}" aria-controls="share-panel" ${shareBusy ? 'disabled' : ''}>${t(shareBusy ? 'preparing' : 'shareHamster')}</button>
    <div id="share-panel" class="group" ${shareImage ? '' : 'hidden'}>${shareImage ? `<img class="share-preview" src="${shareImage.url}" width="1200" height="630" alt="${esc(t('sharePreview', { name: save!.pet.name }))}">
    <p class="small muted">${t('shareNote')}</p><div class="chips"><a class="btn btn-sm" href="${shareImage.url}" download="squeek-pet.png">${t('download')}</a>
    ${canShareImage() ? `<button class="btn btn-sm" data-act="native-share">${t('share')}</button>` : ''}
    <button class="btn btn-sm" data-act="close-share">${t('closeShare')}</button></div>` : ''}</div></div>`;
}

function homeView(): string {
  const s = save!;
  const now = Date.now();
  const st = stageFor(s.pet.xp);
  const fest = festivalActive(s.festival, now);
  const petsLeft = s.pets.day === squeekDay(now) ? PET_DAILY_CAP - s.pets.count : PET_DAILY_CAP;
  return `${fest ? `<p class="banner" id="festival-banner" role="status">${t('festivalBanner', { minutes: fmt(Math.ceil((s.festival.until - now) / MINUTE)) })}</p>` : ''}
    ${s.away ? `<section class="card away" aria-labelledby="away-h"><h2 id="away-h" class="h-sm">${t('awayHeading')}</h2>
      <p>${t('awayBody', { passes: fmt(s.away.passes), seeds: fmt(s.away.seeds) })}${s.away.passes === 0 ? ` ${t('napsGood')}` : ''}</p>
      <button class="btn" data-act="collect">${t('collect', { count: fmt(s.away.seeds) })}</button></section>` : ''}
    <section class="stage" aria-labelledby="pet-h">
      <div class="pet-head"><h1 id="pet-h" class="h-md">${esc(s.pet.name)}</h1><span class="muted small">${st.next ? t('nextStage', { stage: stageName(st.stage.id), percent: pct(st.progress), next: stageName(st.next.id) }) : stageName(st.stage.id)}</span></div>
      <canvas id="scene" width="${W}" height="${H}" role="img" aria-label="${esc(t('cageLabel', { name: s.pet.name }))}"></canvas>
      <p class="mood" id="mood" aria-live="polite">${esc(moodLine())}</p>
      <div class="stats" id="stats">${statBars()}</div>
      <div class="actions"><button class="btn btn-primary" data-act="feed" aria-expanded="${picker === 'feed'}" aria-controls="picker">${t('feed')}</button>
        <button class="btn" data-act="play" aria-expanded="${picker === 'play'}" aria-controls="picker">${t('play')}</button>
        <button class="btn" data-act="clean">${t('clean')}</button>
        <button class="btn" data-act="pet">${t('pet')} <span class="small muted">${t('petsLeft', { count: fmt(petsLeft) })}</span></button></div>
      ${pickerHtml()}<p class="small muted" id="sync-note">${syncNote()}</p>${sharePanel()}</section>
    <div class="home-data">${liveStrip()}${recordsCard()}${milestonesCard()}</div>`;
}

function syncNote(): string {
  if (!save) return '';
  const now = Date.now();
  const left = seedsLeftThisHour(save.hour, now);
  return left === 0 ? t('seedReset', { time: formatTime(language, save.hour.start + HOUR) }) : t('syncNote', { rate: fmt(festivalActive(save.festival, now) ? 2 : 1), currency: t(festivalActive(save.festival, now) ? 'seeds' : 'seed'), left: fmt(left), cap: fmt(600) });
}

function shopView(): string {
  const s = save!;
  const group = (kind: ItemKind) => `<section class="group" aria-labelledby="g-${kind}"><h2 id="g-${kind}" class="h-sm">${t(`kind.${kind}`)}</h2>
    <ul class="items">${ITEMS.filter((i) => i.kind === kind && i.price > 0).map((i) => {
      const owned = i.kind !== 'food' && s.owned.includes(i.id);
      const effect = i.effect ? Object.entries(i.effect).map(([k, v]) => `${statLabel(k as StatKey)} ${v! > 0 ? '+' : ''}${fmt(v!)}`).join(', ') : itemNote(i.id);
      return `<li class="item"><div><strong>${itemName(i.id)}</strong><p class="small muted">${effect}${i.kind === 'food' ? `. ${t('pantry', { count: fmt(s.pantry[i.id] ?? 0) })}` : ''}</p></div>
        ${owned ? `<span class="small muted">${t('owned')}</span>` : `<button class="btn btn-sm" data-buy="${i.id}" aria-label="${esc(t('buyLabel', { item: itemName(i.id), price: fmt(i.price) }))}" ${s.seeds < i.price ? 'aria-disabled="true"' : ''}>${t('buy', { price: fmt(i.price) })}</button>`}</li>`;
    }).join('')}</ul></section>`;
  return `<h1 class="h-md">${t('shop')}</h1><p class="muted">${t('shopNote', { count: fmt(s.seeds) })}</p>
    ${group('food')}${group('toy')}${group('hat')}${group('skin')}${group('bg')}`;
}

function questsView(): string {
  const s = save!;
  const now = Date.now();
  const q = rollQuests(s.quests, now);
  const reset = nextResetAt(now) - now;
  const st = stageFor(s.pet.xp);
  return `<h1 class="h-md">${t('dailyQuests')}</h1><p class="muted">${t('questsReset', { hours: fmt(Math.floor(reset / HOUR)), minutes: fmt(Math.floor((reset % HOUR) / MINUTE)), time: formatTime(language, nextResetAt(now)) })}</p>
    <ul class="quests">${q.ids.map((id) => {
      const d = QUESTS[id];
      const p = Math.min(q.progress[id] ?? 0, d.target);
      const percent = Math.floor((p / d.target) * 100);
      const claimed = q.claimed.includes(id);
      const title = t(`quest.${id}`);
      const shown = t('questProgress', { value: d.unit === 'mm' ? fmt(p / 1e6, 2) : fmt(Math.floor(p)), target: fmt(d.unit === 'mm' ? 2 : d.target), unit: t(`unit.${d.unit}` as MessageKey) });
      return `<li class="card quest"><div class="quest-top"><strong>${title}</strong><span class="small">${t('seedReward', { count: fmt(d.reward) })}</span></div>
        <div class="bar" role="progressbar" aria-label="${title}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="inline-size:${percent}%"></span></div>
        <div class="quest-top"><span class="small muted">${shown}${d.live ? `. ${t('usesLive')}` : ''}</span>
        ${claimed ? `<span class="small">${t('claimed')}</span>` : questDone(q, id) ? `<button class="btn btn-primary btn-sm" data-claim="${id}">${t('claim')}</button>` : ''}</div></li>`;
    }).join('')}</ul>
    <section class="group" aria-labelledby="growth-h"><h2 id="growth-h" class="h-sm">${t('growth')}</h2>
      <p>${esc(t('growthBody', { name: s.pet.name, stage: stageName(st.stage.id), xp: fmt(s.pet.xp) }))} ${st.next ? t('growthNext', { stage: stageName(st.next.id), xp: fmt(st.next.xp) }) : t('growthTop')}</p>
      <div class="bar" role="progressbar" aria-label="${t('growthProgress')}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.floor(st.progress * 100)}"><span style="inline-size:${st.progress * 100}%"></span></div>
      <p class="small muted">${t('growthNote')}</p></section>`;
}

function wardrobeView(): string {
  const s = save!;
  const row = (kind: 'hat' | 'skin' | 'bg') => {
    const owned = ITEMS.filter((i) => i.kind === kind && s.owned.includes(i.id));
    const ids = kind === 'hat' ? ['', ...owned.map((i) => i.id)] : owned.map((i) => i.id);
    const cur = kind === 'hat' ? s.equipped.hat ?? '' : s.equipped[kind];
    return `<section class="group" aria-labelledby="w-${kind}"><h2 id="w-${kind}" class="h-sm">${t(`wardrobe.${kind}`)}</h2>
      <div class="chips">${ids.map((id) => `<button class="chip" data-equip="${kind}" data-id="${id}" aria-pressed="${cur === id}">${id ? itemName(id) : t('noHat')}</button>`).join('')}</div>
      ${kind !== 'hat' && owned.length < 2 ? `<p class="small muted"><a href="#/shop">${t('findMore')}</a></p>` : ''}
      ${kind === 'hat' && owned.length === 0 ? `<p class="small muted">${t('noHats')} <a href="#/shop">${t('browseHats')}</a></p>` : ''}</section>`;
  };
  return `<h1 class="h-md">${t('wardrobe')}</h1><canvas id="scene" width="${W}" height="${H}" role="img" aria-label="${esc(t('wardrobePreview', { name: s.pet.name }))}"></canvas>
    ${row('hat')}${row('skin')}${row('bg')}`;
}

function aboutView(): string {
  const s = save;
  return `${s ? '' : `<p class="small"><a href="#/home">${t('backAdopt')}</a></p>`}<h1 class="h-md">${t('aboutTitle')}</h1><p>${t('aboutIntro')}</p>
    <section class="group" aria-labelledby="a-sync"><h2 id="a-sync" class="h-sm">${t('howSync')}</h2>
      <ul class="prose">${[1, 2, 3, 4, 5, 6].map((i) => `<li>${t(`about.rule${i}` as MessageKey)}</li>`).join('')}</ul></section>
    <section class="group" aria-labelledby="a-data"><h2 id="a-data" class="h-sm">${t('dataSource')}</h2><p class="prose-text">${t('aboutData')} <a href="${STREAM_URL}" target="_blank" rel="noopener">${t('live.watch')}</a>.</p></section>
    <section class="group credits" aria-label="${t('source')}"><p>${t('madeBy')} <a href="https://x.com/Truongsonxyz" target="_blank" rel="noopener">@Truongsonxyz</a></p>
      <p><a href="https://squeekchain.com/genesis/e86n3z8y" target="_blank" rel="noopener">${t('genesisLink')}</a></p><p class="small muted">${t('genesisNote')}</p>
      <p><a href="https://github.com/identity-md-launches/launch-2696-build-squeek-pet-browser" target="_blank" rel="noopener">${t('source')}</a></p></section>
    ${s ? `<section class="group" aria-labelledby="a-save"><h2 id="a-save" class="h-sm">${t('saveCode')}</h2><p class="small muted">${t('saveNote')}</p>
      <label class="field"><span>${t('yourCode')}</span><textarea id="export" rows="3" readonly>${encodeSave(s)}</textarea></label><button class="btn btn-sm" data-act="copy">${t('copyCode')}</button>
      <label class="field"><span>${t('pasteCode')}</span><textarea id="import" rows="3" aria-describedby="import-err" placeholder="SQPET1:…"></textarea></label>
      <p id="import-err" class="small err" aria-live="polite"></p><button class="btn btn-sm" data-act="import">${t('loadCode')}</button>
      <h3 class="h-sm">${t('reset')}</h3><p class="small muted">${t('resetNote')}</p><button class="btn btn-sm btn-danger" data-act="reset">${t('reset')}</button></section>` : ''}`;
}

function adoptView(): string {
  return `<section class="adopt" aria-labelledby="adopt-h"><h1 id="adopt-h" class="h-lg">${t('adoptTitle')}</h1><p class="lead">${t('adoptLead')}</p>
    <canvas id="scene" width="${W}" height="${H}" role="img" aria-label="${t('newHamster')}"></canvas>
    <form id="adopt-form" novalidate><label class="field"><span>${t('nameHamster')}</span><input id="pet-name" name="petname" maxlength="20" autocomplete="off" required placeholder="${t('defaultName')}" aria-describedby="name-err"></label>
      <p id="name-err" class="small err" aria-live="polite"></p><fieldset class="furs"><legend>${t('furColor')}</legend>
      ${FURS.map((f) => `<label class="fur"><input type="radio" name="fur" value="${f.id}" ${f.id === adoptFur ? 'checked' : ''}>
        <canvas class="fur-pic" width="32" height="26" data-fur="${f.id}" aria-hidden="true"></canvas><span>${t(`fur.${f.id}`)}</span></label>`).join('')}</fieldset>
      <button class="btn btn-primary btn-wide" type="submit">${t('adopt')}</button></form><p class="small"><a href="#/about">${t('learnSync')}</a></p></section>`;
}

function render() {
  const view = $('#view')!;
  const r = route();
  const active = document.activeElement as HTMLElement | null;
  const wasInside = !!active && view.contains(active);
  const focusSelector = wasInside && active ? active.id ? `#${CSS.escape(active.id)}` :
    ['act', 'buy', 'claim', 'feed', 'play'].find((key) => active.dataset[key] !== undefined) ? (() => {
      const key = ['act', 'buy', 'claim', 'feed', 'play'].find((k) => active.dataset[k] !== undefined)!;
      return `[data-${key}="${CSS.escape(active.dataset[key]!)}"]`;
    })() : active.dataset.equip ? `[data-equip="${active.dataset.equip}"][data-id="${active.dataset.id}"]` : null : null;
  const fields = ['pet-name', 'import'].map((id) => ({ id, value: $<HTMLInputElement>(`#${id}`)?.value, invalid: $(`#${id}`)?.getAttribute('aria-invalid') === 'true' }));
  const sameRoute = view.dataset.route === r;
  document.querySelectorAll<HTMLAnchorElement>('.tabs a').forEach((a) => {
    if (a.getAttribute('href') === `#/${r}`) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.body.dataset.adopted = save ? 'yes' : 'no';
  if (!save && r !== 'about') {
    if (!view.querySelector('#adopt-form') || view.dataset.language !== language) {
      view.innerHTML = adoptView();
      document.querySelectorAll<HTMLCanvasElement>('.fur-pic').forEach((c) => drawPortrait(c.getContext('2d')!, c.dataset.fur as FurId, 2));
    }
  } else {
    view.innerHTML = r === 'shop' ? shopView() : r === 'quests' ? questsView() : r === 'wardrobe' ? wardrobeView() : r === 'about' ? aboutView() : homeView();
  }
  if (sameRoute) for (const field of fields) {
    const input = $<HTMLInputElement>(`#${field.id}`);
    if (input && field.value !== undefined) input.value = field.value;
    if (input && field.invalid) {
      input.setAttribute('aria-invalid', 'true');
      const error = $(field.id === 'import' ? '#import-err' : '#name-err');
      if (error) error.textContent = t(field.id === 'import' ? 'invalidCode' : 'nameError');
    }
  }
  view.dataset.language = language;
  view.dataset.route = r;
  document.documentElement.lang = language;
  document.title = t('title');
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('description'));
  document.querySelector('meta[property="og:title"]')?.setAttribute('content', t('brand'));
  document.querySelector('meta[property="og:description"]')?.setAttribute('content', t('description'));
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => el.textContent = t(el.dataset.i18n as MessageKey));
  document.querySelectorAll<HTMLElement>('[data-i18n-label]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nLabel as MessageKey)));
  document.querySelectorAll<HTMLElement>('button[data-language]').forEach((el) => el.setAttribute('aria-pressed', String(el.dataset.language === language)));
  paintHeader();
  if (focusSelector) view.querySelector<HTMLElement>(focusSelector)?.focus({ preventScroll: true });
  drawNow();
}

function paintHeader() {
  const seeds = $('#seeds');
  if (seeds) seeds.textContent = fmt(save?.seeds ?? 0);
  $('#sound')?.setAttribute('aria-pressed', String(!!save && !save.muted));
}

/** Light update for the clock and status polls, without rebuilding the view. */
function paint() {
  paintHeader();
  if (!save) return;
  const stEl = $('#stats');
  if (stEl) stEl.innerHTML = statBars();
  const mood = $('#mood');
  const line = moodLine();
  if (mood && mood.textContent !== line) mood.textContent = line;
  const note = $('#sync-note');
  if (note) note.textContent = syncNote();
  const banner = $('#festival-banner');
  if (banner) {
    const left = Math.ceil((save.festival.until - Date.now()) / MINUTE);
    if (left <= 0) render();
    else banner.textContent = t('festivalBanner', { minutes: fmt(left) });
  }
  if (Math.floor(Date.now() / 1000) % 60 === 0) paintHomeData();
}

/** Preserve focus on the stream link when the live state changes. */
function paintLive() {
  const strip = $('.live');
  if (!strip) return;
  const focused = strip.contains(document.activeElement);
  strip.outerHTML = liveStrip();
  if (focused) $<HTMLAnchorElement>('.live a')?.focus({ preventScroll: true });
}

function canShareImage(): boolean {
  try { return !!shareImage && !!navigator.share && !!navigator.canShare?.({ files: [shareImage.file] }); }
  catch { return false; }
}
function releaseShare() {
  shareGeneration++;
  shareBusy = false;
  if (shareImage) URL.revokeObjectURL(shareImage.url);
  shareImage = null;
}
async function openShare() {
  if (!save || shareBusy) return;
  if (shareImage) { releaseShare(); render(); return; }
  const generation = ++shareGeneration;
  const snapshot = structuredClone(save);
  const scene = sceneData();
  shareBusy = true;
  render();
  try {
    const blob = await makeShareImage(snapshot, scene, Date.now(), frame, angle);
    if (generation !== shareGeneration) return;
    shareImage = { url: URL.createObjectURL(blob), file: new File([blob], 'squeek-pet.png', { type: 'image/png' }) };
  } catch { if (generation === shareGeneration) toast(t('shareError')); }
  finally {
    if (generation === shareGeneration) {
      shareBusy = false;
      render();
      $<HTMLElement>('#share-panel a[download]')?.focus({ preventScroll: true });
    }
  }
}
async function nativeShare() {
  if (!shareImage || !canShareImage()) return;
  try { await navigator.share({ files: [shareImage.file], title: t('brand'), text: t('shareTagline') }); }
  catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) toast(t('shareFailed')); }
}
function switchLanguage(next: Language) {
  if (next === language) return;
  releaseShare();
  language = next;
  if (save) save.language = next;
  try { localStorage.setItem('squeek-pet:language', next); } catch { /* memory-only preference */ }
  clearTimeout(toastTimer);
  $('#toast')!.textContent = '';
  persist();
  render();
}

// ---------- canvas loop ----------
let frame = 0;
let angle = 0;
let lastFrame = 0;
function sceneData() {
  if (!save) {
    return { fur: adoptFur, stage: 'pup' as const, pose: 'happy' as Pose, hat: null, skin: 'skin-classic', bg: 'bg-cozy', festival: false, reducedMotion: reducedMotion.matches };
  }
  const now = Date.now();
  const isWardrobe = route() === 'wardrobe';
  return {
    fur: save.pet.fur,
    stage: stageFor(save.pet.xp).stage.id,
    pose: isWardrobe ? ('happy' as Pose) : pose(now),
    hat: save.equipped.hat,
    skin: save.equipped.skin,
    bg: save.equipped.bg,
    festival: festivalActive(save.festival, now) && !isWardrobe,
    reducedMotion: reducedMotion.matches,
  };
}
function drawNow() {
  const c = $<HTMLCanvasElement>('#scene');
  const ctx = c?.getContext('2d');
  if (ctx) drawScene(ctx, sceneData(), Date.now(), frame, angle);
}
function loop(t: number) {
  requestAnimationFrame(loop);
  const sc = sceneData();
  const slow = save && isGrumpy(save.stats) ? 2 : 1; // grumpy pets are slow
  if (reducedMotion.matches) {
    // Slow two-frame walk. The renderer holds the wheel/background still.
    if (t - lastFrame > 1000) {
      lastFrame = t;
      frame++;
      drawNow();
    }
    return;
  }
  if (t - lastFrame < (1000 / 8) * slow) return;
  lastFrame = t;
  frame++;
  if (sc.pose === 'run') angle += 0.35 / slow;
  drawNow();
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('button, [data-act]');
  if (!el) return;
  const d = el.dataset;
  if (d.language === 'en' || d.language === 'vi') return switchLanguage(d.language);
  if (d.feed) return feed(d.feed);
  if (d.play !== undefined) return play(d.play || null);
  if (d.buy) return buy(d.buy);
  if (d.claim) return claim(d.claim as QuestId);
  if (d.equip) return equip(d.equip as 'hat' | 'skin' | 'bg', d.id || null);
  switch (d.act) {
    case 'share-card': return void openShare();
    case 'native-share': return void nativeShare();
    case 'close-share':
      releaseShare();
      render();
      $('[data-act="share-card"]')?.focus();
      return;
    case 'feed':
    case 'play':
      picker = picker === d.act ? null : (d.act as 'feed' | 'play');
      render();
      if (picker) $<HTMLElement>('#picker .opt')?.focus();
      return;
    case 'clean':
      return clean();
    case 'pet':
      return pet();
    case 'collect':
      return collectAway();
    case 'sound':
      if (!save) return toast(t('soundAdopt'));
      save.muted = !save.muted;
      blip('pet', save.muted);
      toast(t(save.muted ? 'soundOff' : 'soundOn'));
      return commit();
    case 'copy': {
      const ta = $<HTMLTextAreaElement>('#export');
      if (!ta) return;
      ta.select();
      if (!navigator.clipboard) return toast(t('copyManually'));
      void navigator.clipboard.writeText(ta.value).then(
        () => toast(t('copied')),
        () => toast(t('copyManually')),
      );
      return;
    }
    case 'import': {
      const ta = $<HTMLTextAreaElement>('#import');
      const err = $('#import-err');
      const s = ta ? decodeSave(ta.value, Date.now(), navigator.language) : null;
      if (!s) {
        if (err) err.textContent = t('invalidCode');
        ta?.setAttribute('aria-invalid', 'true');
        ta?.focus();
        return;
      }
      releaseShare();
      save = s;
      language = s.language;
      lastWork = null;
      persist();
      toast(t('welcomeBack', { name: s.pet.name }));
      location.hash = '#/home';
      return render();
    }
    case 'reset':
      if (!confirm(t('resetConfirm'))) return;
      try { localStorage.removeItem(KEY); } catch { /* storage may be blocked */ }
      releaseShare();
      $('#toast')!.textContent = '';
      picker = null;
      save = null;
      location.hash = '#/home';
      return render();
  }
});

document.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.name === 'fur') {
    adoptFur = t.value as FurId;
    drawNow();
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target as HTMLFormElement;
  if (form.id !== 'adopt-form') return;
  e.preventDefault();
  const input = $<HTMLInputElement>('#pet-name')!;
  const name = input.value.trim().replace(/\s+/g, ' ');
  if (!name) {
    $('#name-err')!.textContent = t('nameError');
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    return;
  }
  save = newSave(name.slice(0, 20), adoptFur, Date.now(), language);
  lastWork = null;
  lastBlock = null;
  persist();
  location.hash = '#/home';
  render();
  toast(t('welcomeHome', { name: save.pet.name }));
  if (lastEvents) applyEvents(lastEvents, Date.now());
  const h = $<HTMLElement>('#pet-h');
  h?.setAttribute('tabindex', '-1');
  h?.focus();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && shareImage) {
    releaseShare(); render(); $('[data-act="share-card"]')?.focus();
  }
  if (e.key === 'Escape' && picker) {
    const which = picker;
    picker = null;
    render();
    $<HTMLElement>(`[data-act="${which}"]`)?.focus();
  }
});

window.addEventListener('hashchange', () => {
  picker = null;
  render();
  const h1 = $<HTMLElement>('#view h1');
  h1?.setAttribute('tabindex', '-1');
  h1?.focus();
  window.scrollTo(0, 0);
});

document.addEventListener('visibilitychange', () => {
  if (!save) return;
  if (document.visibilityState === 'hidden') {
    save.lastSeen = Date.now();
    persist();
  } else {
    tick();
    pump();
  }
});
window.addEventListener('pagehide', persist);

// ---------- start ----------
if (save) arrive(Date.now());
render();
setInterval(() => {
  tick();
  pump();
}, 1000);
pump();
requestAnimationFrame(loop);
