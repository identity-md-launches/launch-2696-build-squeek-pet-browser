import './styles.css';
import { drawScene, drawPortrait, H, W, type Pose } from './art';
import { getJson, parseEvents, parseStats, parseStatus, POLL, STREAM_URL, type Endpoint, type LiveStats, type LiveStatus } from './api';
import { blip } from './audio';
import {
  applyEffect, awaySeeds, bumpQuest, CLEAN_EFFECT, decodeSave, encodeSave, festivalActive, FREE_PLAY, FURS, HOUR, isGrumpy,
  ITEMS, itemById, MINUTE, newSave, nextResetAt, offlineDecay, parseSave, PET_DAILY_CAP, PET_EFFECT, petMode, processEvents,
  questDone, QUESTS, rollQuests, runXp, seedsLeftThisHour, squeekDay, stageFor, syncEarnings, decay, workBetween,
  type FurId, type ItemKind, type MilestoneEvent, type Mode, type QuestId, type Save, type StatKey, type Wheel,
} from './logic';

const KEY = 'squeek-pet:v1';
const AWAY_MIN_MS = 5 * MINUTE;

// ---------- state ----------
let save: Save | null = load();
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
const fmt = (n: number, d = 0) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

function load(): Save | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? parseSave(JSON.parse(raw), Date.now()) : null;
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
  const n = save.pet.name;
  const m = mode();
  if (m === 'run') return `${n} is running beside Squeektoshi.`;
  if (m === 'napTogether') return `${n} is napping with Squeektoshi. Energy comes back twice as fast.`;
  if (m === 'nap') return `${n} is tired and taking a nap. Naps are good too.`;
  if (isGrumpy(save.stats)) {
    if (save.stats.hunger >= 80) return `${n} is hungry and a bit grumpy. A snack would help.`;
    if (save.stats.cleanliness <= 20) return `${n} is grumpy about a messy cage.`;
    return `${n} feels a bit lonely. Some play or a pet would help.`;
  }
  if (live?.coreStatus === 'ACTIVE' && conn === 'ok') return `${n} wants to run but needs energy first.`;
  return `${n} is pottering about the cage.`;
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
    toast(`${save.pet.name} grew into a ${after.name}.`);
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
    if (save.seeds < item.price) return toast(`You need ${item.price} Seeds for a ${item.name.toLowerCase()}.`);
    save.seeds -= item.price;
  } else save.pantry[id] -= 1;
  save.stats = applyEffect(save.stats, item.effect ?? {});
  quest('feed3', 1);
  addXp(5);
  animate('eat');
  blip('eat', save.muted);
  toast(`${save.pet.name} ate a ${item.name.toLowerCase()}.`);
  picker = null;
  commit();
}
function play(id: string | null) {
  if (!save) return;
  if (save.stats.energy < 15) return toast(`${save.pet.name} is too sleepy to play. A nap will help.`);
  const item = id ? itemById(id) : null;
  if (id && (!item || !save.owned.includes(id))) return;
  save.stats = applyEffect(save.stats, item?.effect ?? FREE_PLAY);
  quest('play2', 1);
  addXp(item ? 6 : 3);
  animate('happy');
  blip('happy', save.muted);
  toast(item ? `${save.pet.name} played with the ${item.name.toLowerCase()}.` : `${save.pet.name} chased your finger around the cage.`);
  picker = null;
  commit();
}
function clean() {
  if (!save) return;
  if (save.stats.cleanliness >= 95) return toast('The cage is already spotless.');
  save.stats = applyEffect(save.stats, CLEAN_EFFECT);
  quest('clean1', 1);
  addXp(3);
  animate('happy', 1600);
  blip('clean', save.muted);
  toast('Fresh bedding, clean cage.');
  commit();
}
function pet() {
  if (!save) return;
  const day = squeekDay(Date.now());
  if (save.pets.day !== day) save.pets = { day, count: 0 };
  if (save.pets.count >= PET_DAILY_CAP) return toast(`${save.pet.name} has had plenty of pets today. More after 12:00 UTC.`);
  save.pets.count += 1;
  save.stats = applyEffect(save.stats, PET_EFFECT);
  quest('pet5', 1);
  addXp(1);
  animate('happy', 1400);
  blip('pet', save.muted);
  toast(`${save.pet.name} leans into your hand.`);
  commit();
}
function buy(id: string) {
  if (!save) return;
  const item = itemById(id);
  if (!item) return;
  if (save.seeds < item.price) return toast(`You need ${item.price - save.seeds} more Seeds for the ${item.name.toLowerCase()}.`);
  if (item.kind !== 'food' && save.owned.includes(id)) return;
  save.seeds -= item.price;
  if (item.kind === 'food') save.pantry[id] = (save.pantry[id] ?? 0) + 1;
  else save.owned.push(id);
  blip('buy', save.muted);
  toast(item.kind === 'food' ? `Bought a ${item.name.toLowerCase()}.` : `Bought the ${item.name.toLowerCase()}.`);
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
  save.seeds += QUESTS[id].reward;
  addXp(25);
  blip('buy', save.muted);
  toast(`Quest done: +${QUESTS[id].reward} Seeds.`);
  commit();
}
function collectAway() {
  if (!save?.away) return;
  save.seeds += save.away.seeds;
  addXp(runXp(save.away.passes * 0.5));
  toast(`+${fmt(save.away.seeds)} Seeds collected.`);
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
  if (now - from >= AWAY_MIN_MS) save.awayPending = { from: Math.max(from, now - 12 * HOUR), to: now };
  if (stats && lastFetched.stats >= now - 1000) settleAway();
  persist();
}
function settleAway() {
  if (!save?.awayPending || !stats || stats.days.length === 0) return;
  const { from, to } = save.awayPending;
  const passes = workBetween(stats.days, from, to) ?? 0;
  const seeds = awaySeeds(passes, to - from);
  const prev = save.away;
  save.away = { passes: passes + (prev?.passes ?? 0), seeds: seeds + (prev?.seeds ?? 0) };
  save.awayPending = null;
  persist();
  render();
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
    if (s) {
      stats = s;
      settleAway();
    }
  } else {
    const ev = parseEvents(res.data);
    if (ev) {
      lastEvents = ev;
      applyEvents(ev, now);
    }
  }
}

function applyEvents(ev: MilestoneEvent[], now: number) {
  if (!save) return;
  const r = processEvents(save.festival, ev, now);
  save.festival = r.state;
  if (r.started) {
    toast('A festival started: 2x Seeds for one hour.');
    blip('grow', save.muted);
  }
  commit();
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
  const was = conn;
  live = s;
  liveAt = now;
  conn = 'ok';
  if (save) {
    const fest = festivalActive(save.festival, now);
    const r = syncEarnings(lastWork, s.work, { coreStatus: s.coreStatus, online: s.online }, save.stats.energy, save.hour, now, fest);
    save.hour = r.window;
    if (r.seeds > 0) {
      save.seeds += r.seeds;
      addXp(runXp(r.passes));
      quest('runBeside', r.passes);
    }
    if (r.capped && r.seeds === 0) toast('Hourly Seed limit reached. Running is still fun.');
    if (s.distanceMm !== null) quest('distance2km', s.distanceMm, true);
    if (s.blockHeight !== null && lastBlock !== null && s.blockHeight > lastBlock) {
      quest('newBlock', 1);
      toast(`Squeek block ${fmt(s.blockHeight)} just landed.`);
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
const STAT_LABEL: Record<StatKey, string> = { hunger: 'Hunger', happiness: 'Happiness', energy: 'Energy', cleanliness: 'Clean' };

function route(): string {
  const r = location.hash.replace(/^#\/?/, '') || 'home';
  return ['home', 'shop', 'quests', 'wardrobe', 'about'].includes(r) ? r : 'home';
}

function liveStrip(): string {
  const now = Date.now();
  if (conn === 'down' || (conn === 'ok' && !live)) {
    return `<section class="live" aria-labelledby="live-h">
      <h2 id="live-h" class="sr-only">Squeektoshi live</h2>
      <p class="live-row"><span class="pill pill-off">Offline</span> <span>Can't reach the wheel right now. Your pet is fine and the game keeps going.</span></p>
      ${liveAt ? `<p class="muted small">Last reading ${Math.max(1, Math.round((now - liveAt) / MINUTE))} min ago.</p>` : ''}
      <p class="small"><a href="${STREAM_URL}" target="_blank" rel="noopener">Watch Squeektoshi's stream</a></p>
    </section>`;
  }
  if (!live) {
    return `<section class="live" aria-labelledby="live-h"><h2 id="live-h" class="sr-only">Squeektoshi live</h2>
      <p class="live-row"><span class="pill">Checking</span> <span class="muted">Looking for Squeektoshi's wheel...</span></p></section>`;
  }
  const st = live.coreStatus;
  const pill = st === 'ACTIVE' ? ['pill-run', 'Running'] : st === 'IDLE' ? ['pill-rest', 'Resting'] : st === 'COUNTER_FAULT' ? ['pill-off', 'Sensor fault'] : ['pill-off', 'Unknown'];
  const kmh = live.speedMmPerSecond === null ? null : live.speedMmPerSecond * 0.0036;
  const km = live.distanceMm === null ? null : live.distanceMm / 1e6;
  const prog = live.blockProgress;
  const dash = '<span class="muted">n/a</span>';
  return `<section class="live" aria-labelledby="live-h">
    <div class="live-head">
      <h2 id="live-h" class="h-sm">Squeektoshi live</h2>
      <span class="pill ${pill[0]}" id="live-pill">${pill[1]}</span>
      ${live.online ? '' : '<span class="muted small">Reading is stale</span>'}
    </div>
    <dl class="live-grid">
      <div><dt>RPM</dt><dd id="live-rpm">${live.rpm === null ? dash : fmt(live.rpm, 1)}</dd></div>
      <div><dt>Speed</dt><dd id="live-kmh">${kmh === null ? dash : `${fmt(kmh, 2)} km/h`}</dd></div>
      <div><dt>Today</dt><dd id="live-km">${km === null ? dash : `${fmt(km, 2)} km`}</dd></div>
      <div><dt>Block</dt><dd id="live-block">${live.blockHeight === null ? dash : fmt(live.blockHeight)}</dd></div>
    </dl>
    <div class="block-prog">
      <span class="small" id="block-label">Next Squeek block${prog === null ? ': unknown' : ` ${Math.floor(prog * 100)}%`}</span>
      <div class="bar" role="progressbar" aria-label="Progress to next Squeek block" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${prog === null ? 0 : Math.floor(prog * 100)}"><span id="block-bar" style="inline-size:${prog === null ? 0 : prog * 100}%"></span></div>
    </div>
    <p class="small"><a href="${STREAM_URL}" target="_blank" rel="noopener">Watch Squeektoshi's stream</a></p>
  </section>`;
}

function statBars(): string {
  if (!save) return '';
  return (Object.keys(STAT_LABEL) as StatKey[])
    .map((k) => {
      const v = Math.round(save!.stats[k]);
      const low = k === 'hunger' ? v >= 70 : v <= 30;
      return `<div class="stat ${low ? 'stat-low' : ''}" id="stat-${k}">
        <span class="stat-label">${STAT_LABEL[k]}</span><span class="stat-val">${v}</span>
        <div class="bar bar-${k}" role="meter" aria-label="${STAT_LABEL[k]}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${v}"><span style="inline-size:${v}%"></span></div>
      </div>`;
    })
    .join('');
}

function pickerHtml(): string {
  if (!save || !picker) return '';
  if (picker === 'feed') {
    const foods = ITEMS.filter((i) => i.kind === 'food');
    return `<div class="picker" id="picker" role="group" aria-label="Choose a food">
      ${foods
        .map((f) => {
          const have = save!.pantry[f.id] ?? 0;
          return `<button class="opt" data-feed="${f.id}"><strong>${f.name}</strong><span class="small muted">${have > 0 ? `${have} in pantry` : `Buy and feed: ${f.price} Seeds`}</span></button>`;
        })
        .join('')}
    </div>`;
  }
  const toys = ITEMS.filter((i) => i.kind === 'toy' && save!.owned.includes(i.id));
  return `<div class="picker" id="picker" role="group" aria-label="Choose a game">
    <button class="opt" data-play=""><strong>Chase my finger</strong><span class="small muted">Free</span></button>
    ${toys.map((t) => `<button class="opt" data-play="${t.id}"><strong>${t.name}</strong><span class="small muted">${t.note}</span></button>`).join('')}
    ${toys.length === 0 ? '<a class="opt opt-link" href="#/shop"><strong>Get a toy</strong><span class="small muted">Ball, chew stick, tunnel</span></a>' : ''}
  </div>`;
}

function homeView(): string {
  const s = save!;
  const now = Date.now();
  const st = stageFor(s.pet.xp);
  const fest = festivalActive(s.festival, now);
  const petsLeft = s.pets.day === squeekDay(now) ? PET_DAILY_CAP - s.pets.count : PET_DAILY_CAP;
  return `
  ${fest ? `<p class="banner" role="status">Festival: Squeektoshi hit a milestone. 2x Seeds for <span id="fest-left">${Math.ceil((s.festival.until - now) / MINUTE)}</span> more min.</p>` : ''}
  ${
    s.away
      ? `<section class="card away" aria-labelledby="away-h">
      <h2 id="away-h" class="h-sm">While you were away</h2>
      <p>Squeektoshi ran ${fmt(s.away.passes)} passes; your pet earned ${fmt(s.away.seeds)} Seeds.${s.away.passes === 0 ? ' Naps are good too.' : ''}</p>
      <button class="btn btn-primary" data-act="collect">Collect ${fmt(s.away.seeds)} Seeds</button>
    </section>`
      : ''
  }
  <section class="stage" aria-labelledby="pet-h">
    <div class="pet-head">
      <h1 id="pet-h" class="h-md">${esc(s.pet.name)}</h1>
      <span class="muted small">${st.stage.name}${st.next ? `, ${Math.floor(st.progress * 100)}% to ${st.next.name}` : ''}</span>
    </div>
    <canvas id="scene" width="${W}" height="${H}" role="img" aria-label="${esc(s.pet.name)} in the cage"></canvas>
    <p class="mood" id="mood" aria-live="polite">${esc(moodLine())}</p>
    <div class="stats" id="stats">${statBars()}</div>
    <div class="actions">
      <button class="btn btn-primary" data-act="feed" aria-expanded="${picker === 'feed'}" aria-controls="picker">Feed</button>
      <button class="btn" data-act="play" aria-expanded="${picker === 'play'}" aria-controls="picker">Play</button>
      <button class="btn" data-act="clean">Clean</button>
      <button class="btn" data-act="pet">Pet <span class="small muted">${petsLeft} left</span></button>
    </div>
    ${pickerHtml()}
    <p class="small muted" id="sync-note">${syncNote()}</p>
  </section>
  ${liveStrip()}`;
}

function syncNote(): string {
  if (!save) return '';
  const left = seedsLeftThisHour(save.hour, Date.now());
  const fest = festivalActive(save.festival, Date.now());
  return `Each magnet pass while you run together earns ${fest ? '2 Seeds' : '1 Seed'}. ${fmt(left)} of 600 left this hour.`;
}

function shopView(): string {
  const s = save!;
  const group = (kind: ItemKind, title: string) => `
    <section class="group" aria-labelledby="g-${kind}">
      <h2 id="g-${kind}" class="h-sm">${title}</h2>
      <ul class="items">${ITEMS.filter((i) => i.kind === kind && i.price > 0)
        .map((i) => {
          const owned = i.kind !== 'food' && s.owned.includes(i.id);
          const eff = i.effect
            ? Object.entries(i.effect)
                .map(([k, v]) => `${STAT_LABEL[k as StatKey]} ${v! > 0 ? '+' : ''}${v}`)
                .join(', ')
            : i.note;
          return `<li class="item">
            <div><strong>${i.name}</strong><p class="small muted">${eff}${i.kind === 'food' ? `. ${s.pantry[i.id] ?? 0} in pantry` : ''}</p></div>
            ${owned ? '<span class="small muted">Owned</span>' : `<button class="btn btn-sm" data-buy="${i.id}" ${s.seeds < i.price ? 'aria-disabled="true"' : ''}>Buy for ${i.price}</button>`}
          </li>`;
        })
        .join('')}</ul>
    </section>`;
  return `<h1 class="h-md">Shop</h1>
    <p class="muted">You have ${fmt(s.seeds)} Seeds. Cosmetics show up on your pet once you wear them in the Wardrobe.</p>
    ${group('food', 'Food')}${group('toy', 'Toys')}${group('hat', 'Hats')}${group('skin', 'Wheel skins')}${group('bg', 'Cage backgrounds')}`;
}

function questsView(): string {
  const s = save!;
  const now = Date.now();
  const q = rollQuests(s.quests, now);
  const reset = nextResetAt(now) - now;
  const hh = Math.floor(reset / HOUR);
  const mm = Math.floor((reset % HOUR) / MINUTE);
  const st = stageFor(s.pet.xp);
  return `<h1 class="h-md">Daily quests</h1>
    <p class="muted">New quests in ${hh} h ${mm} min, at 12:00 UTC when the Squeek day turns over.</p>
    <ul class="quests">${q.ids
      .map((id) => {
        const d = QUESTS[id];
        const p = Math.min(q.progress[id] ?? 0, d.target);
        const pct = Math.floor((p / d.target) * 100);
        const claimed = q.claimed.includes(id);
        const shown = d.unit === 'mm' ? `${fmt(p / 1e6, 2)} of 2 km` : `${fmt(Math.floor(p))} of ${d.target} ${d.unit}`;
        return `<li class="card quest">
          <div class="quest-top"><strong>${d.title}</strong><span class="small">+${d.reward} Seeds</span></div>
          <div class="bar" role="progressbar" aria-label="${d.title}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="inline-size:${pct}%"></span></div>
          <div class="quest-top"><span class="small muted">${shown}${d.live ? '. Uses live wheel data' : ''}</span>
          ${claimed ? '<span class="small">Claimed</span>' : questDone(q, id) ? `<button class="btn btn-primary btn-sm" data-claim="${id}">Claim</button>` : ''}</div>
        </li>`;
      })
      .join('')}</ul>
    <section class="group" aria-labelledby="growth-h">
      <h2 id="growth-h" class="h-sm">Growth</h2>
      <p>${esc(s.pet.name)} is a ${st.stage.name} with ${fmt(s.pet.xp)} XP.${st.next ? ` ${st.next.name} at ${fmt(st.next.xp)} XP.` : ' The top stage.'}</p>
      <div class="bar" role="progressbar" aria-label="Growth to next stage" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.floor(st.progress * 100)}"><span style="inline-size:${st.progress * 100}%"></span></div>
      <p class="small muted">Stages: Pup, Junior, Adult, Wheel Legend. Care actions, quests and running together give XP.</p>
    </section>`;
}

function wardrobeView(): string {
  const s = save!;
  const row = (kind: 'hat' | 'skin' | 'bg', title: string) => {
    const owned = ITEMS.filter((i) => i.kind === kind && s.owned.includes(i.id));
    const opts = kind === 'hat' ? [{ id: '', name: 'No hat' }, ...owned] : owned;
    const cur = kind === 'hat' ? s.equipped.hat ?? '' : s.equipped[kind];
    return `<section class="group" aria-labelledby="w-${kind}">
      <h2 id="w-${kind}" class="h-sm">${title}</h2>
      <div class="chips">${opts.map((o) => `<button class="chip" data-equip="${kind}" data-id="${o.id}" aria-pressed="${cur === o.id}">${o.name}</button>`).join('')}</div>
      ${kind !== 'hat' && owned.length < 2 ? '<p class="small muted"><a href="#/shop">Find more in the shop</a></p>' : ''}
      ${kind === 'hat' && owned.length === 0 ? '<p class="small muted">No hats yet. <a href="#/shop">Browse hats in the shop</a></p>' : ''}
    </section>`;
  };
  return `<h1 class="h-md">Wardrobe</h1>
    <canvas id="scene" width="${W}" height="${H}" role="img" aria-label="Preview of ${esc(s.pet.name)} with the chosen look"></canvas>
    ${row('hat', 'Hat')}${row('skin', 'Wheel skin')}${row('bg', 'Cage background')}`;
}

function aboutView(): string {
  const s = save;
  return `${s ? '' : '<p class="small"><a href="#/home">Back to adopting your hamster</a></p>'}<h1 class="h-md">About Squeek Pet</h1>
    <p>An unofficial fan game. Testnet values have no monetary value, and Seeds exist only in this browser.</p>
    <section class="group" aria-labelledby="a-sync"><h2 id="a-sync" class="h-sm">How the sync works</h2>
      <ul class="prose">
        <li>Squeektoshi is a real hamster. His wheel powers Squeekchain, a proof-of-work toychain on Ethereum Sepolia.</li>
        <li>When his wheel reports ACTIVE and your pet has at least 20 Energy, your pet runs too. Each new magnet pass earns 1 Seed, up to 600 Seeds per hour.</li>
        <li>When he rests, your pet naps with him and gets Energy back twice as fast. Naps are good too.</li>
        <li>While the page is closed, stats drift for at most 12 hours, and your pet earns half of the passes he ran.</li>
        <li>A new speed record or distance milestone starts a one-hour festival with 2x Seeds.</li>
        <li>Your pet never dies. Neglect only makes it grumpy and slow.</li>
      </ul>
    </section>
    <section class="group" aria-labelledby="a-data"><h2 id="a-data" class="h-sm">Data source</h2>
      <p>Live readings come from the public, read-only Squeekchain API at api.squeekchain.com: status every 15 seconds, the 7-day log every 5 minutes and milestone events every 2 minutes, only while this tab is visible. No trackers, no analytics, no wallet. <a href="${STREAM_URL}" target="_blank" rel="noopener">Watch Squeektoshi's stream</a>.</p>
    </section>
    ${
      s
        ? `<section class="group" aria-labelledby="a-save"><h2 id="a-save" class="h-sm">Save code</h2>
      <p class="small muted">Your game saves in this browser. Copy the code to move it to another device.</p>
      <label class="field"><span>Your save code</span><textarea id="export" rows="3" readonly>${encodeSave(s)}</textarea></label>
      <button class="btn btn-sm" data-act="copy">Copy save code</button>
      <label class="field"><span>Paste a save code to load it</span><textarea id="import" rows="3" aria-describedby="import-err" placeholder="SQPET1:..."></textarea></label>
      <p id="import-err" class="small err" aria-live="polite"></p>
      <button class="btn btn-sm" data-act="import">Load save code</button>
      <h3 class="h-sm">Start over</h3>
      <p class="small muted">Adopt a new hamster. This replaces the current save in this browser.</p>
      <button class="btn btn-sm btn-danger" data-act="reset">Start over</button>
    </section>`
        : ''
    }`;
}

function adoptView(): string {
  return `<section class="adopt" aria-labelledby="adopt-h">
    <h1 id="adopt-h" class="h-lg">Meet your pocket hamster</h1>
    <p class="lead">A pixel pet that runs and naps in sync with Squeektoshi, the real hamster whose wheel powers Squeekchain.</p>
    <canvas id="scene" width="${W}" height="${H}" role="img" aria-label="Your new hamster"></canvas>
    <form id="adopt-form" novalidate>
      <label class="field"><span>Name your hamster</span>
        <input id="pet-name" name="petname" maxlength="20" autocomplete="off" required placeholder="Pip" aria-describedby="name-err"></label>
      <p id="name-err" class="small err" aria-live="polite"></p>
      <fieldset class="furs"><legend>Fur color</legend>
        ${FURS.map(
          (f) => `<label class="fur"><input type="radio" name="fur" value="${f.id}" ${f.id === adoptFur ? 'checked' : ''}>
          <canvas class="fur-pic" width="32" height="26" data-fur="${f.id}" aria-hidden="true"></canvas><span>${f.name}</span></label>`,
        ).join('')}
      </fieldset>
      <button class="btn btn-primary btn-wide" type="submit">Adopt</button>
    </form>
    <p class="small"><a href="#/about">How the sync with Squeektoshi works</a></p>
  </section>`;
}

function render() {
  const view = $('#view')!;
  const r = route();
  const active = document.activeElement as HTMLElement | null;
  const focusKey = active?.dataset?.act ?? active?.dataset?.buy ?? active?.dataset?.claim ?? (active?.dataset?.equip ? `${active.dataset.equip}:${active.dataset.id}` : null);
  document.querySelectorAll<HTMLAnchorElement>('.tabs a').forEach((a) => {
    if (a.getAttribute('href') === `#/${r}`) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.body.dataset.adopted = save ? 'yes' : 'no';
  if (!save && r !== 'about') {
    if (!view.querySelector('#adopt-form')) {
      view.innerHTML = adoptView();
      document.querySelectorAll<HTMLCanvasElement>('.fur-pic').forEach((c) => drawPortrait(c.getContext('2d')!, c.dataset.fur as FurId, 2));
    }
  } else {
    view.innerHTML = r === 'shop' ? shopView() : r === 'quests' ? questsView() : r === 'wardrobe' ? wardrobeView() : r === 'about' ? aboutView() : homeView();
  }
  paintHeader();
  if (focusKey) {
    const el =
      view.querySelector<HTMLElement>(`[data-act="${focusKey}"],[data-buy="${focusKey}"],[data-claim="${focusKey}"]`) ??
      (focusKey.includes(':') ? view.querySelector<HTMLElement>(`[data-equip="${focusKey.split(':')[0]}"][data-id="${focusKey.split(':')[1]}"]`) : null);
    el?.focus();
  }
  drawNow();
}

function paintHeader() {
  const seeds = $('#seeds');
  if (seeds) seeds.textContent = save ? fmt(save.seeds) : '0';
  const snd = $('#sound');
  if (snd) snd.setAttribute('aria-pressed', String(!!save && !save.muted));
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
  const fl = $('#fest-left');
  if (fl) {
    const left = Math.ceil((save.festival.until - Date.now()) / MINUTE);
    if (left <= 0) render();
    else fl.textContent = String(left);
  }
}

/** Update live numbers in place so focus inside the strip is never lost. */
function paintLive() {
  const strip = $('.live');
  if (!strip) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = liveStrip();
  const fresh = tmp.firstElementChild as HTMLElement;
  const ids = ['live-pill', 'live-rpm', 'live-kmh', 'live-km', 'live-block', 'block-label', 'block-bar'];
  const same = ids.every((id) => !!strip.querySelector(`#${id}`) === !!fresh.querySelector(`#${id}`)) && strip.querySelectorAll('.pill-off').length === fresh.querySelectorAll('.pill-off').length;
  if (!same) return void strip.replaceWith(fresh);
  for (const id of ids) {
    const cur = strip.querySelector<HTMLElement>(`#${id}`);
    const next = fresh.querySelector<HTMLElement>(`#${id}`);
    if (!cur || !next) continue;
    if (cur.innerHTML !== next.innerHTML) cur.innerHTML = next.innerHTML;
    if (cur.className !== next.className) cur.className = next.className;
    if (cur.getAttribute('style') !== next.getAttribute('style')) cur.setAttribute('style', next.getAttribute('style') ?? '');
  }
  const bar = strip.querySelector('.block-prog .bar');
  const nbar = fresh.querySelector('.block-prog .bar');
  if (bar && nbar) bar.setAttribute('aria-valuenow', nbar.getAttribute('aria-valuenow') ?? '0');
}

// ---------- canvas loop ----------
let frame = 0;
let angle = 0;
let lastFrame = 0;
function sceneData() {
  if (!save) {
    return { fur: adoptFur, stage: 'pup' as const, pose: 'happy' as Pose, hat: null, skin: 'skin-classic', bg: 'bg-cozy', festival: false };
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
    // no continuous motion: redraw only when the pose changes
    if (t - lastFrame > 1000) {
      lastFrame = t;
      frame = 1;
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
  if (d.feed) return feed(d.feed);
  if (d.play !== undefined) return play(d.play || null);
  if (d.buy) return el.getAttribute('aria-disabled') === 'true' ? toast(`You need ${itemById(d.buy)!.price - save!.seeds} more Seeds for that.`) : buy(d.buy);
  if (d.claim) return claim(d.claim as QuestId);
  if (d.equip) return equip(d.equip as 'hat' | 'skin' | 'bg', d.id || null);
  switch (d.act) {
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
      if (!save) return toast('Adopt a hamster first, then sound can be turned on.');
      save.muted = !save.muted;
      blip('pet', save.muted);
      toast(save.muted ? 'Sound off.' : 'Sound on.');
      return commit();
    case 'copy': {
      const ta = $<HTMLTextAreaElement>('#export');
      if (!ta) return;
      ta.select();
      navigator.clipboard?.writeText(ta.value).then(
        () => toast('Save code copied.'),
        () => toast('Select the code and copy it by hand.'),
      );
      return;
    }
    case 'import': {
      const ta = $<HTMLTextAreaElement>('#import');
      const err = $('#import-err');
      const s = ta ? decodeSave(ta.value, Date.now()) : null;
      if (!s) {
        if (err) err.textContent = 'That code could not be read. Paste the whole code, starting with SQPET1:';
        ta?.setAttribute('aria-invalid', 'true');
        ta?.focus();
        return;
      }
      save = s;
      lastWork = null;
      persist();
      toast(`Welcome back, ${s.pet.name}.`);
      location.hash = '#/home';
      return render();
    }
    case 'reset':
      if (!confirm('Start over with a new hamster? The current save in this browser will be replaced.')) return;
      localStorage.removeItem(KEY);
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
    $('#name-err')!.textContent = 'Give your hamster a name, up to 20 letters.';
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    return;
  }
  save = newSave(name.slice(0, 20), adoptFur, Date.now());
  persist();
  location.hash = '#/home';
  render();
  toast(`Welcome home, ${save.pet.name}.`);
  if (lastEvents) applyEvents(lastEvents, Date.now());
  const h = $<HTMLElement>('#pet-h');
  h?.setAttribute('tabindex', '-1');
  h?.focus();
});

document.addEventListener('keydown', (e) => {
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
