// -----------------------------------------------------------------------------
// The integration: the neoHub typed in the configuration (its local address,
// an API token, a pinned certificate), one read of its live data every poll
// interval, one Gladys device per thermostat zone plus the hub itself, the
// transport badges, the "Test the connection" button, and the commands.
// index.js only wires the SDK handlers.
//
// The pace is global and kept across restarts: never two reads less than an
// interval apart (start to start), whatever asks (a reconnection, a save of
// the form, the test button, the Discover tab, a restart: the time of the
// last attempt is kept in /data). A failed read pauses 1, 2, 5, 10 then
// 15 min, never under the interval, the pause kept in /data. A refused token
// stops the automatic reads until the token changes or the button is clicked.
// Two clocks: `now` (wall clock) dates what /data keeps; `monotonic` paces
// the reads, the pauses, the budgets and the guards. The clock is read once
// per decision (`dueAt(mono)` computes on the caller's instant).
//
// Commands:
//   - protective, never blocked by an option, a pause, a refused token, the
//     queue or a read in progress: "Standby" on a zone (FROST_ON) and "Away"
//     on the hub (AWAY_ON). Sent at once, out of the queue, before any
//     waiting command (a read of the polling stuck for 1 s is cut for them);
//     tried again within 250 ms, then kept in /data and sent again by the
//     next reads (3 times at most) until a read shows them; the commands
//     queued before them are cancelled; a newer command of the same target
//     that left stops their resending. They need what any command needs: the
//     token and the pinned certificate.
//   - sensitive, refused unless "Allow heating commands" is on: the setpoint
//     (SET_TEMP), "Schedule" (FROST_OFF) and "Home" (AWAY_OFF). A bounded
//     queue (8), one at a time; decided on a fresh read (never on memory),
//     the hub and the zone (id and name) checked; the option, the bounds and
//     the stop guards checked on arrival, after the fresh read and right
//     before the first byte (beforeSend); sent within 3.5 s of the click or
//     refused unsent; a command that may have left is never "not sent";
//     confirmed by a read back showing the value. A setpoint is refused while
//     the zone (or the hub) is in standby, away or on holiday, and for 10 min
//     after a standby or an away, which only "Schedule" or "Home" lift.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { isComplete, normalizeConfig, tokenTag } from './config.js';
import { API, AWAY, FEATURES as F, HUB_KEY, MODES, SETPOINT, TIMINGS } from './constants.js';
import {
  COMMAND_ROLES,
  buildHubDevice,
  buildZoneDevice,
  hubStates,
  idsOf,
  parseDeviceId,
  parseFeatureId,
  targetKey,
  zoneStates,
} from './devices.js';
import { ERRORS, T, age, both, join, reasonOf, word } from './i18n.js';
import { NeoHubClient } from './neohub/client.js';
import { NeoHubError } from './neohub/errors.js';
import { parseLive, parseSystem } from './neohub/model.js';
import { isSafeName } from './neohub/protocol.js';
import { readFingerprint } from './neohub/tls.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

/** A number sent by Gladys: a finite number, or a plain decimal text ('' and null are not 0). */
function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^-?\d{1,3}(\.\d{1,3})?$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

/** "21.5 °C" in each language. */
const degrees = (tenths) =>
  tenths === undefined
    ? both('?', '?')
    : both(`${tenths / 10} °C`, `${String(tenths / 10).replace('.', ',')} °C`);

/** Lists the first 5 entries, then "and N more". */
function bounded(entries, language) {
  const shown = entries.slice(0, 5).map((e) => e[language]);
  const more = entries.length - shown.length;
  return shown.join(', ') + (more > 0 ? T.andMore(more)[language] : '');
}

/** The zone name of a created Gladys device (the exact name the hub reported at the Scan). */
const zoneNameParam = (device) => {
  const value = device?.params?.find?.((p) => p?.name === 'zone_name')?.value;
  return typeof value === 'string' ? value : undefined;
};

export class NeoHubApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'heatmiser-neohub' }),
    createClient = (options) => new NeoHubClient(options),
    fingerprint = readFingerprint,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.createClient = createClient;
    this.readFingerprint = fingerprint;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.publisher = new StatePublisher({ gladys, logger, now: monotonic, timers });
    this.config = normalizeConfig();
    this.configLoaded = false;
    this.configTries = 0;
    this.configTimer = undefined;
    this.configGeneration = 0;
    this.memory = normalizeMemory(null);
    this.client = undefined;
    this.generation = 0;
    this.started = false;
    this.timer = undefined;
    this.running = undefined;
    this.followUps = new Set();
    /** Commands waiting their turn, and the one being served. */
    this.commands = [];
    this.serving = undefined;
    /** Arrival numbers of the commands; target key -> the number of the last one that left. */
    this.seq = 0;
    this.lastLeft = new Map();
    /** target key -> { kind, seq, until (monotonic), pending, resends, name, sending } */
    this.guards = new Map();
    this.lastStatus = undefined;
    this.lastTestAt = -Infinity;
    /** Nothing read from /data yet: never written before it is (it would overwrite the pins). */
    this.memoryUnreadable = true;
    /** target key -> 'applied' | 'not_applied': the last check of a write by a read. */
    this.lastCheck = new Map();
    this.reset();
  }

  reset() {
    this.hubId = undefined;
    this.live = undefined;
    this.liveAt = undefined;
    /** 'C', 'F' or undefined (GET_SYSTEM not read yet). */
    this.unit = undefined;
    this.systemStamp = undefined;
    /** target key -> { zone, at } of the last read. */
    this.zones = new Map();
    this.lastReadAt = undefined;
    this.pause = undefined;
    this.failures = 0;
    this.offline = false;
    this.lastReason = undefined;
    this.refused = false;
    this.closedFirst = 0;
    this.pinError = undefined;
    this.writtenAt = new Map();
    this.pendingWrites = new Map();
    this.warnings = new Map();
    this.published = undefined;
    this.badges = new Map();
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Connected to Gladys: the configuration is read, and read again on failure, with a status. */
  async onConnected(load) {
    this.configLoader = load;
    this.configTries = 0;
    this.clearConfigTimer();
    await this.loadConfig();
  }

  async loadConfig() {
    const generation = ++this.configGeneration;
    let raw;
    try {
      raw = await this.configLoader();
    } catch (err) {
      if (generation !== this.configGeneration) {
        return;
      }
      const wait = TIMINGS.configRetry[Math.min(this.configTries, TIMINGS.configRetry.length - 1)];
      this.configTries += 1;
      this.logger.warn(
        `heatmiser-neohub: configuration not read (${err?.name ?? 'Error'}); new try in ${Math.round(wait / 1000)} s`,
      );
      if (!this.configLoaded) {
        await this.setStatus(false, T.configNotRead(age(wait)));
      }
      this.clearConfigTimer();
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        return this.loadConfig().catch(() => {});
      }, wait);
      return;
    }
    if (generation !== this.configGeneration) {
      return;
    }
    this.configTries = 0;
    await this.connected(raw);
  }

  clearConfigTimer() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  async start(raw = {}) {
    try {
      await this.startNow(raw);
    } catch (err) {
      // Never left without a timer, whatever failed.
      this.logger.error(`heatmiser-neohub: start failed (${err?.name ?? 'Error'})`);
      this.failures += 1;
      this.setPause(this.monotonic(), this.interval);
      this.schedule();
    }
  }

  async startNow(raw = {}) {
    this.stop();
    await this.running;
    this.config = normalizeConfig(raw);
    this.reset();
    const now = this.now();
    const mono = this.monotonic();
    let loaded = null;
    this.memoryUnreadable = false;
    try {
      loaded = await this.bounded(this.store.load());
    } catch (err) {
      // Unreadable is not empty: the pins and the refused token are kept as they
      // were (never overwritten); read again every 10 s.
      this.memoryUnreadable = true;
      this.logger.warn(`heatmiser-neohub: /data unreadable (${err?.code ?? 'error'})`);
      this.scheduleMemoryRetry();
    }
    const saved = normalizeMemory(loaded, now);
    if (saved.lastAttemptAt !== null) {
      this.lastReadAt = mono - (now - saved.lastAttemptAt);
    }
    if (saved.key !== this.config.key) {
      // Another hub address: the pause of the previous one is not its own.
      saved.key = this.config.key;
      saved.pause = null;
    }
    this.memory = saved;
    if (saved.pause && saved.pause.until > now) {
      this.pause = { due: mono + (saved.pause.until - now) };
      this.failures = saved.pause.failures;
    }
    const refused = saved.refused;
    if (refused && refused.key === this.config.key && this.config.token) {
      if (tokenTag(refused.salt, this.config.token) === refused.tag) {
        this.refused = true;
      } else {
        // A new token: always tried.
        this.memory.refused = null;
      }
    }
    for (const g of saved.guards) {
      if (!this.guards.has(g.target)) {
        this.guards.set(g.target, {
          kind: g.kind,
          seq: ++this.seq,
          until: mono + (g.until - now),
          pending: g.pending && g.resends > 0,
          resends: g.resends,
          name: undefined,
        });
      }
    }
    this.publisher.start();
    const missing = this.configMessage();
    if (missing) {
      await this.setStatus(false, missing);
      return;
    }
    if (this.config.fingerprint && this.memory.pins[this.config.key] !== this.config.fingerprint) {
      // A fingerprint typed by the user is the pin from now on.
      this.memory.pins[this.config.key] = this.config.fingerprint;
    }
    this.openClient();
    if (!this.memoryUnreadable) {
      await this.saveMemory();
    }
    await this.publishDevices();
    if (!this.pin()) {
      await this.setStatus(false, T.noPin);
      return;
    }
    if (this.refused) {
      await this.setStatus(false, T.tokenRefused);
    } else {
      await this.setStatus(false, this.pause ? this.pauseMessage(mono) : T.connecting);
    }
    // A standby or an away kept in /data and not yet shown leaves first, before any read.
    await this.resendGuards(this.generation);
    if (this.refused) {
      return;
    }
    this.schedule();
    await this.tick();
  }

  openClient() {
    this.client?.stop();
    this.client = this.createClient({
      host: this.config.host,
      port: this.config.port,
      pin: this.pin(),
      token: this.config.token,
      monotonic: this.monotonic,
      timers: this.timers,
    });
  }

  /** The pin of the address in use: typed in the configuration, else learnt by the button. */
  pin() {
    return this.config.fingerprint ?? this.memory.pins[this.config.key];
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    this.timers.clearTimeout(this.memoryTimer);
    this.memoryTimer = undefined;
    for (const timer of this.followUps) {
      this.timers.clearTimeout(timer);
    }
    this.followUps.clear();
    this.publisher.stop();
    this.client?.stop();
    this.client = undefined;
    for (const job of this.commands.splice(0)) {
      job.reject(this.refusal(ERRORS.stopped));
    }
  }

  /** The container stops: every timer, the configuration retry included; /data written. */
  async shutdown() {
    this.configGeneration += 1;
    this.clearConfigTimer();
    this.stop();
    await this.persist(this.monotonic());
  }

  clearTimer() {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** What the configuration lacks, as a status message; undefined when complete. */
  configMessage() {
    const error = this.config.error;
    if (error) {
      return T.configError[error] ?? T.configError.invalid;
    }
    return isComplete(this.config) ? undefined : T.noConfig;
  }

  /**
   * The configuration of Gladys read. The first time, start; after a
   * reconnection (Gladys restarted), resend what Gladys keeps in memory only.
   */
  async connected(raw = {}) {
    this.configLoaded = true;
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.configUpdated(raw);
    this.published = undefined;
    this.badges.clear();
    const status = this.lastStatus;
    this.lastStatus = undefined;
    if (status) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    await this.publishDevices();
    await this.publishBadges();
  }

  /** New address, token or fingerprint: restart; new options, ceiling, interval or language: apply at once. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    const previous = this.config;
    this.configLoaded = true;
    this.clearConfigTimer();
    if (
      !this.started ||
      next.key !== previous.key ||
      next.token !== previous.token ||
      next.fingerprint !== previous.fingerprint ||
      next.error !== previous.error
    ) {
      this.started = true;
      return this.start(raw);
    }
    this.config = next;
    if (next.allowHeating !== previous.allowHeating) {
      this.logger.info(
        `heatmiser-neohub: heating commands ${next.allowHeating ? 'allowed' : 'off'} (standby and away are always allowed)`,
      );
    }
    if (next.pollInterval !== previous.pollInterval && !this.refused) {
      this.schedule();
    }
    if (next.language !== previous.language) {
      this.published = undefined;
      await this.publishDevices();
    }
    return undefined;
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  get lastMessage() {
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? undefined;
  }

  /** A /data operation, never awaited more than 2 s (a slow disk never holds a read nor a command). */
  bounded(promise) {
    let timer;
    const late = new Promise((_resolve, reject) => {
      timer = this.timers.setTimeout(
        () => reject(Object.assign(new Error('/data too slow'), { code: 'ETIMEDOUT' })),
        TIMINGS.dataTimeout,
      );
    });
    promise.catch(() => {});
    return Promise.race([promise, late]).finally(() => this.timers.clearTimeout(timer));
  }

  /** /data unreadable at start: read again on its own timer (one read at a time), then merged. */
  scheduleMemoryRetry() {
    const generation = this.generation;
    this.timers.clearTimeout(this.memoryTimer);
    this.memoryTimer = this.timers.setTimeout(async () => {
      this.memoryTimer = undefined;
      if (generation !== this.generation) return;
      let loaded;
      try {
        loaded = await this.bounded(this.store.load());
      } catch {
        if (generation === this.generation) this.scheduleMemoryRetry();
        return;
      }
      if (generation !== this.generation) return;
      await this.mergeMemory(loaded);
    }, TIMINGS.dataRetry);
  }

  /** What /data held, merged once readable: never over what this run decided since. */
  async mergeMemory(loaded) {
    const now = this.now();
    const mono = this.monotonic();
    const saved = normalizeMemory(loaded, now);
    const hadPin = Boolean(this.pin());
    for (const [key, fp] of Object.entries(saved.pins)) {
      this.memory.pins[key] ??= fp;
    }
    if (saved.lastAttemptAt !== null) {
      const at = mono - (now - saved.lastAttemptAt);
      this.lastReadAt = Math.max(this.lastReadAt ?? -Infinity, at);
    }
    if (saved.key === this.config.key && saved.pause && saved.pause.until > now && !this.pause) {
      this.pause = { due: mono + (saved.pause.until - now) };
      this.failures = Math.max(this.failures, saved.pause.failures);
    }
    const refused = saved.refused;
    if (
      refused &&
      refused.key === this.config.key &&
      this.config.token &&
      tokenTag(refused.salt, this.config.token) === refused.tag
    ) {
      this.memory.refused = refused;
      this.refused = true;
      this.clearTimer();
    }
    for (const g of saved.guards) {
      if (!this.guards.has(g.target)) {
        this.guards.set(g.target, {
          kind: g.kind,
          seq: ++this.seq,
          until: mono + (g.until - now),
          pending: g.pending && g.resends > 0,
          resends: g.resends,
          name: undefined,
        });
      }
    }
    this.memoryUnreadable = false;
    await this.persist(mono);
    if (!hadPin && this.pin() && isComplete(this.config)) {
      this.openClient();
      this.schedule();
    }
  }

  /** true when /data was written. A failure is logged once until a save succeeds again. */
  async saveMemory() {
    try {
      await this.bounded(this.store.save(this.memory));
      this.saveFailed = false;
      this.memoryUnreadable = false;
      return true;
    } catch (err) {
      if (!this.saveFailed) {
        this.saveFailed = true;
        this.logger.warn(`Saving the state to /data failed: ${err?.code ?? 'error'}`);
      }
      return false;
    }
  }

  /** The pause and the guards, dated on the wall clock, kept in /data (never over an unreadable file). */
  async persist(mono) {
    if (this.memoryUnreadable) {
      return false;
    }
    const now = this.now();
    this.memory.key = this.config.key;
    this.memory.pause = this.pause
      ? { until: now + this.pauseLeft(mono), failures: this.failures }
      : null;
    this.memory.guards = [...this.guards.entries()]
      .filter(([key, g]) => g.until > mono && !this.lifted(key, g))
      .map(([target, g]) => ({
        target,
        kind: g.kind,
        until: now + Math.min(g.until - mono, TIMINGS.stopGuard),
        pending: this.stillPending(target, g),
        resends: g.resends,
      }));
    return this.saveMemory();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  // --- Pace ------------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * 1000;
  }

  /** The rest of the pause (ms), capped at every use; 0 when none. */
  pauseLeft(mono) {
    if (!this.pause) {
      return 0;
    }
    return Math.min(Math.max(0, this.pause.due - mono), TIMINGS.pauseMax);
  }

  /** The monotonic time from which the next read may start, from the caller's instant. */
  dueAt(mono) {
    const due = this.lastReadAt === undefined ? mono : this.lastReadAt + this.interval;
    return Math.max(due, mono + this.pauseLeft(mono));
  }

  setPause(mono, wait) {
    this.pause = { due: mono + Math.min(wait, TIMINGS.pauseMax) };
  }

  pauseMessage(mono) {
    const reason =
      this.lastReason ?? both('earlier reads failed', 'les lectures précédentes ont échoué');
    return T.unreachable(reason, age(this.pauseLeft(mono)));
  }

  /** One timer: the next read when it is due. */
  schedule() {
    this.clearTimer();
    if (!this.client || this.refused || !this.pin()) {
      return;
    }
    const mono = this.monotonic();
    const wait = Math.max(0, this.dueAt(mono) - mono);
    const generation = this.generation;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      return generation === this.generation ? this.tick() : undefined;
    }, wait);
  }

  /** One read at a time: a tick during a read joins it. */
  tick() {
    if (!this.running) {
      const generation = this.generation;
      this.running = this.read()
        .catch((err) => this.recover(err, generation))
        .finally(() => {
          this.running = undefined;
        });
    }
    return this.running;
  }

  /** An internal error (a bug, never an answer of the hub): a pause, and the next read scheduled. */
  async recover(err, generation) {
    this.logger.error(`heatmiser-neohub: unexpected error (${err?.name ?? 'Error'})`);
    if (generation !== this.generation) {
      return;
    }
    this.failures += 1;
    this.setPause(this.monotonic(), this.interval);
    this.schedule();
  }

  /** GET_LIVE_DATA -> `{ hubId, live }`; throws a NeoHubError. */
  async readLive(client, deadline, priority = false) {
    const { hubId, response } = await client.request(API.commands.live, 0, { deadline, priority });
    const live = parseLive(response);
    if (!live) {
      throw new NeoHubError('protocol', 'not live data', { sent: true });
    }
    return { hubId, live };
  }

  async read() {
    const generation = this.generation;
    const client = this.client;
    if (!client || this.refused) {
      return;
    }
    const mono = this.monotonic();
    if (mono < this.dueAt(mono)) {
      this.schedule();
      return;
    }
    const gone = () => generation !== this.generation;
    this.lastReadAt = mono;
    // Kept BEFORE the read: a restart during it never reads again sooner.
    this.memory.lastAttemptAt = this.now();
    if (!this.memoryUnreadable) {
      await this.saveMemory();
    }
    if (gone()) return;
    let result;
    try {
      result = await this.readLive(client, mono + TIMINGS.requestTimeout);
    } catch (err) {
      if (gone()) return;
      await this.failed(err, mono);
      if (!gone()) this.schedule();
      return;
    }
    if (gone()) return;
    // The unit of the hub (GET_SYSTEM): read once, again when the hub says its system changed.
    // A secondary request: its failure never fails the read of the zones.
    if (this.unit === undefined || result.live.systemStamp !== this.systemStamp) {
      try {
        const { hubId, response } = await client.request(API.commands.system, 0, {
          deadline: this.monotonic() + TIMINGS.requestTimeout,
        });
        const system = parseSystem(response);
        if (!gone() && hubId === result.hubId && system?.unit) {
          this.unit = system.unit;
          this.systemStamp = result.live.systemStamp;
        }
      } catch (err) {
        if (gone()) return;
        this.logger.warn(`heatmiser-neohub: unit of the hub not read (${err?.kind ?? 'error'})`);
      }
    }
    if (gone()) return;
    await this.succeeded(result, mono);
    if (!gone()) {
      await this.resendGuards(generation);
      this.schedule();
    }
  }

  async succeeded({ hubId, live }, at) {
    this.pause = undefined;
    this.failures = 0;
    this.offline = false;
    this.lastReason = undefined;
    this.closedFirst = 0;
    this.pinError = undefined;
    this.absorb(hubId, live, at, { round: true });
    await this.persist(at);
    await this.setStatus(true, this.statusMessage());
    await this.publishDevices();
    await this.publishBadges();
    await this.flush();
  }

  /**
   * A live read (a round, a follow-up, the check of a command): the zones
   * kept, their states queued, the writes and the stop guards checked. A
   * read that started before a write on a zone left never publishes over it.
   */
  absorb(hubId, live, at, { round = false } = {}) {
    if (this.hubId !== undefined && hubId !== this.hubId) {
      // Another hub answers (the pin is per address): its zones are its own devices.
      this.logger.warn('heatmiser-neohub: another hub answers at this address');
      this.zones.clear();
    }
    this.hubId = hubId;
    if (this.liveAt === undefined || at >= this.liveAt) {
      this.live = live;
      this.liveAt = at;
    }
    const created = this.createdFeatures();
    const celsius = this.unit === 'C';
    const seen = new Set();
    for (const zone of live.zones) {
      const key = targetKey(hubId, zone.id);
      seen.add(key);
      if (at < (this.writtenAt.get(key) ?? -Infinity)) {
        continue;
      }
      const previous = this.zones.get(key);
      if (previous && at < previous.at) {
        continue;
      }
      this.zones.set(key, { zone, at });
      this.checkWrite(key, zone, at);
      this.queue(key, zoneStates(zone, { celsius }), created);
    }
    if (round) {
      for (const key of [...this.zones.keys()]) {
        if (!seen.has(key)) this.zones.delete(key);
      }
    }
    const hubKey = targetKey(hubId, HUB_KEY);
    if (at >= (this.writtenAt.get(hubKey) ?? -Infinity)) {
      this.checkWrite(hubKey, live, at);
      this.queue(hubKey, hubStates(live), created);
    }
    this.settleGuards(hubId, live, at);
  }

  queue(key, states, created) {
    const ids = idsOf(this.gladys, key);
    for (const [role, state] of states) {
      const id = ids.feature(role);
      if (created.has(id)) {
        this.publisher.push(id, state);
      }
    }
  }

  /** The read failed: a pause (or the token refused), the zones of the last read kept for Discovery only. */
  async failed(err, mono) {
    const kind = err instanceof NeoHubError ? err.kind : 'internal';
    if (kind === 'cut' || kind === 'stopped') {
      // Cut for a standby or an away: not a failure, read again at the next interval.
      return;
    }
    if (kind === 'token' || (kind === 'closed' && err.first && ++this.closedFirst >= 2)) {
      await this.tokenRefused();
      return;
    }
    if (kind === 'pin') {
      this.pinError = { fingerprint: err.fingerprint };
    }
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)],
    );
    this.failures += 1;
    this.setPause(mono, wait);
    this.offline = true;
    this.lastReason = reasonOf(err);
    this.logger.warn(
      `heatmiser-neohub: read failed (${kind}); next try in ${Math.round(wait / 1000)} s`,
    );
    await this.persist(mono);
    await this.setStatus(
      false,
      kind === 'pin' ? T.pinChanged(err.fingerprint) : T.unreachable(this.lastReason, age(wait)),
    );
    await this.publishBadges();
  }

  /** The token refused: kept in /data (its 8-bit tag), no automatic read until it changes or a click. */
  async tokenRefused() {
    this.refused = true;
    this.offline = true;
    this.clearTimer();
    const salt = randomBytes(8).toString('hex');
    this.memory.refused = {
      key: this.config.key,
      salt,
      tag: tokenTag(salt, this.config.token),
    };
    this.logger.warn('heatmiser-neohub: the hub refused the token; automatic reads stopped');
    await this.persist(this.monotonic());
    await this.setStatus(false, T.tokenRefused);
    await this.publishBadges();
  }

  /** "Connected: 4 zones." plus what is worth knowing (5 names listed at most). */
  statusMessage() {
    const zones = [...this.zones.values()].map((e) => e.zone);
    let message = zones.length === 0 ? T.noZone : T.connected(zones.length);
    if (this.unit === 'F') {
      message = join(message, T.fahrenheit);
    } else if (this.unit === undefined) {
      message = join(message, T.unitUnknown);
    }
    const offline = zones.filter((z) => z.offline !== false).map((z) => both(z.name, z.name));
    if (offline.length > 0) {
      message = join(message, T.offlineZones(both(bounded(offline, 'en'), bounded(offline, 'fr'))));
    }
    if (this.live?.duplicates) {
      message = join(message, T.duplicates);
    }
    if (this.warnings.size > 0) {
      const entries = [...this.warnings.values()];
      message = join(message, T.notApplied(both(bounded(entries, 'en'), bounded(entries, 'fr'))));
    }
    if ([...this.guards.entries()].some(([key, g]) => this.stillPending(key, g))) {
      message = join(message, T.guardPending);
    }
    return message;
  }

  // --- Gladys ----------------------------------------------------------------

  createdDevices() {
    return (this.gladys.devices ?? []).filter((d) => parseDeviceId(d.external_id) !== undefined);
  }

  createdDevice(key) {
    return (this.gladys.devices ?? []).find((d) => parseDeviceId(d.external_id)?.key === key);
  }

  createdFeatures() {
    return new Map(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => [f.external_id, f])),
    );
  }

  /** The devices to publish: the hub and the zones read, plus those already created (never dropped). */
  async publishDevices() {
    const language = this.config.language;
    const devices = new Map();
    if (this.hubId) {
      const key = targetKey(this.hubId, HUB_KEY);
      devices.set(
        key,
        buildHubDevice(this.gladys, this.hubId, { language, created: this.createdDevice(key) }),
      );
      const sorted = [...this.zones.entries()].sort(([, a], [, b]) => a.zone.id - b.zone.id);
      for (const [key, { zone }] of sorted) {
        devices.set(
          key,
          buildZoneDevice(
            this.gladys,
            { hub: this.hubId, id: zone.id },
            { zone, language, created: this.createdDevice(key) },
          ),
        );
      }
    }
    for (const created of this.createdDevices()) {
      const ids = parseDeviceId(created.external_id);
      if (devices.has(ids.key)) continue;
      devices.set(
        ids.key,
        ids.zone === HUB_KEY
          ? buildHubDevice(this.gladys, ids.hub, { language, created })
          : buildZoneDevice(this.gladys, { hub: ids.hub, id: ids.zone }, { language, created }),
      );
    }
    if (devices.size === 0) {
      return;
    }
    const list = [...devices.values()];
    const json = JSON.stringify(list);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(list);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  badge(key) {
    if (this.offline) {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE };
    }
    if (!key.endsWith(`-${HUB_KEY}`) && this.liveAt !== undefined) {
      const entry = this.zones.get(key);
      if (!entry || entry.zone.offline !== false) {
        return {
          transport: DEVICE_TRANSPORTS.UNREACHABLE,
          degraded: true,
          message: both(
            'Offline or absent from the last read of the hub',
            'Hors ligne ou absent de la dernière lecture du hub',
          ),
        };
      }
    }
    if (this.warnings.has(key)) {
      return {
        transport: DEVICE_TRANSPORTS.LOCAL,
        degraded: true,
        message: both(
          'The last command is not shown by the hub (read back differs)',
          'La dernière commande n’apparaît pas dans le hub (la relecture diffère)',
        ),
      };
    }
    return { transport: DEVICE_TRANSPORTS.LOCAL };
  }

  async publishBadges() {
    const entries = [];
    for (const device of this.createdDevices()) {
      const ids = parseDeviceId(device.external_id);
      const entry = { external_id: device.external_id, ...this.badge(ids.key) };
      const json = JSON.stringify(entry);
      if (this.badges.get(device.external_id) !== json) {
        entries.push([device.external_id, json, entry]);
      }
    }
    if (entries.length === 0) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries.map(([, , entry]) => entry));
      for (const [externalId, json] of entries) {
        this.badges.set(externalId, json);
      }
    } catch (err) {
      this.logger.warn(`Transport badges failed: ${err.message}`);
    }
  }

  /**
   * A device was created (or updated): its last values at once, only when
   * they are fresh (the last read succeeded and is younger than an interval).
   */
  async deviceCreated(device) {
    this.badges.delete(device?.external_id);
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.set(f.external_id, f);
    }
    const ids = parseDeviceId(device?.external_id);
    const mono = this.monotonic();
    const fresh =
      ids &&
      this.live &&
      ids.hub === this.hubId &&
      !this.offline &&
      this.pauseLeft(mono) === 0 &&
      mono - this.liveAt <= this.interval;
    if (fresh) {
      if (ids.zone === HUB_KEY) {
        this.queue(ids.key, hubStates(this.live), created);
      } else {
        const entry = this.zones.get(ids.key);
        if (entry && mono - entry.at <= this.interval) {
          this.queue(ids.key, zoneStates(entry.zone, { celsius: this.unit === 'C' }), created);
        }
      }
    }
    await this.flush();
    await this.publishBadges();
  }

  async deviceDeleted(device) {
    this.badges.delete(device?.external_id);
    if (device?.external_id) {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: a read now when it is due, else the last list. */
  async scan() {
    if (this.client && !this.running && !this.refused) {
      const mono = this.monotonic();
      if (mono >= this.dueAt(mono)) {
        await this.tick();
        return;
      }
    }
    await this.publishDevices();
  }

  // --- Configuration button --------------------------------------------------

  /**
   * "Test the connection": the first click pins the certificate the hub
   * shows (nothing else is sent on that handshake); a refused token is tried
   * again; then a read, never sooner than the interval.
   */
  async testConnection() {
    const missing = this.configMessage();
    if (missing) {
      return missing;
    }
    const mono = this.monotonic();
    if (mono - this.lastTestAt < TIMINGS.testCooldown) {
      return this.lastMessage ?? T.connecting;
    }
    this.lastTestAt = mono;
    if (!this.pin()) {
      if (this.memoryUnreadable) {
        return T.test.memoryUnreadable;
      }
      let seen;
      try {
        seen = await this.readFingerprint({ host: this.config.host, port: this.config.port });
      } catch (err) {
        return T.test.noCertificate(reasonOf(err));
      }
      this.memory.pins[this.config.key] = seen;
      if (!(await this.saveMemory())) {
        delete this.memory.pins[this.config.key];
        return T.test.pinNotSaved(seen);
      }
      this.logger.info(
        'heatmiser-neohub: certificate of the hub pinned (first click of the button)',
      );
      this.openClient();
      if (!this.refused) {
        this.schedule();
      }
      await this.setStatus(false, T.connecting);
      const read = await this.testRead();
      return join(T.test.pinned(seen), read);
    }
    if (this.refused) {
      // An explicit click tries the same token again (never automatically).
      this.refused = false;
      this.closedFirst = 0;
      this.memory.refused = null;
      await this.persist(this.monotonic());
    }
    if (this.running) {
      return T.test.busy;
    }
    const due = this.dueAt(this.monotonic());
    if (this.monotonic() < due) {
      // Never a read sooner than the interval (nor during a pause).
      this.schedule();
      return join(T.test.wait(age(due - this.monotonic())), this.lastMessage ?? T.connecting);
    }
    return this.testRead();
  }

  async testRead() {
    let handle;
    const budget = new Promise((resolve) => {
      handle = this.timers.setTimeout(() => resolve('slow'), TIMINGS.testBudget);
    });
    const result = await Promise.race([this.tick().then(() => 'done'), budget]);
    this.timers.clearTimeout(handle);
    if (result === 'slow') {
      return T.test.slow;
    }
    return this.lastMessage ?? T.connecting;
  }

  // --- The commands ----------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  /**
   * A command from Gladys: a protective one goes at once; a sensitive one is
   * checked, then queued (8 at most) and served one at a time.
   */
  async setValue(device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.monotonic();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !COMMAND_ROLES.includes(target.role)) {
      throw this.refusal(ERRORS.readOnly);
    }
    // Protective first: not even the configuration of Gladys is needed to keep it
    // (it leaves as soon as the configuration is read, before the first read).
    if (target.role === F.MODE && value === MODES.STANDBY) {
      return this.protective(target, device, received, 'standby');
    }
    if (target.role === F.AWAY && value === AWAY.AWAY) {
      return this.protective(target, device, received, 'away');
    }
    if (!this.configLoaded) {
      throw this.refusal(ERRORS.configNotLoaded);
    }
    const wanted = this.parseCommand(target.role, value);
    if (!this.config.allowHeating) {
      throw this.refusal(ERRORS.heatingDisabled);
    }
    if (this.commands.length >= TIMINGS.commandQueue) {
      throw this.refusal(ERRORS.queueFull(this.commands.length));
    }
    const ahead = this.commands.length + (this.serving ? 1 : 0);
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      this.commands.push({ target, device, wanted, received, ahead, seq, resolve, reject });
      this.serveCommands();
    });
  }

  /** The value of a sensitive command, checked strictly. */
  parseCommand(role, value) {
    if (role === F.MODE) {
      if (value !== MODES.SCHEDULE) throw this.refusal(ERRORS.badOption);
      return { command: API.commands.standbyOff };
    }
    if (role === F.AWAY) {
      if (value !== AWAY.HOME) throw this.refusal(ERRORS.badOption);
      return { command: API.commands.awayOff };
    }
    const number = numberOf(value);
    if (number === undefined) {
      throw this.refusal(ERRORS.badNumber);
    }
    const tenths = Math.round(number * 10);
    if (Math.abs(number * 10 - tenths) > 1e-6 || tenths % 5 !== 0) {
      throw this.refusal(ERRORS.badStep);
    }
    const high = Math.min(SETPOINT.max, this.config.ceiling);
    if (tenths < SETPOINT.min * 10 || tenths > high * 10) {
      throw this.refusal(ERRORS.outOfRange(SETPOINT.min, high));
    }
    return { command: API.commands.setTemp, tenths };
  }

  serveCommands() {
    if (this.serving) {
      return this.serving;
    }
    this.serving = (async () => {
      while (this.commands.length > 0) {
        const job = this.commands.shift();
        try {
          job.resolve(await this.command(job));
        } catch (err) {
          job.reject(err);
        }
      }
    })().finally(() => {
      this.serving = undefined;
      if (this.commands.length > 0) {
        this.serveCommands();
      }
    });
    return this.serving;
  }

  sleep(ms) {
    return new Promise((resolve) => this.timers.setTimeout(resolve, ms));
  }

  /** The stop guard of a key, alive at `mono`, else undefined (an expired one is forgotten). */
  /**
   * The stop guard of a key in force at `mono`, else undefined: an expired one
   * is forgotten; one that a newer command of its target lifted (that command
   * left: "Schedule" or "Home") is no longer in force.
   */
  guardOf(key, mono) {
    const guard = this.guards.get(key);
    if (guard && guard.until <= mono) {
      this.guards.delete(key);
      return undefined;
    }
    return guard && !this.lifted(key, guard) ? guard : undefined;
  }

  /** A newer command of the target left after the guard was set. */
  lifted(key, guard) {
    return (this.lastLeft.get(key) ?? 0) > guard.seq;
  }

  /**
   * The stop guards a sensitive command meets, at `mono`: a standby or an
   * away newer than the command cancels it; a setpoint is refused while one
   * lives on its zone or on the hub.
   */
  checkGuards(job, mono) {
    const zoneGuard = this.guardOf(job.target.key, mono);
    const hubGuard = this.guardOf(targetKey(job.target.hub, HUB_KEY), mono);
    for (const guard of [zoneGuard, hubGuard]) {
      if (guard && guard.seq > job.seq) {
        throw this.refusal(
          guard.kind === 'away' ? ERRORS.cancelledByAway : ERRORS.cancelledByStandby,
        );
      }
    }
    if (job.wanted.tenths !== undefined && (zoneGuard || hubGuard)) {
      throw this.refusal(
        (hubGuard ?? zoneGuard).kind === 'away' ? ERRORS.awayGuard : ERRORS.standbyGuard,
      );
    }
  }

  /** The checks before sending, on the latest configuration, guards and state. */
  checkBeforeSend(job, generation, client, fresh) {
    if (!this.config.allowHeating) {
      throw this.refusal(ERRORS.heatingDisabled);
    }
    if (generation !== this.generation || this.client !== client) {
      throw this.refusal(ERRORS.stopped);
    }
    if (this.refused) {
      throw this.refusal(ERRORS.tokenRefused);
    }
    const mono = this.monotonic();
    if (this.pauseLeft(mono) > 0) {
      throw this.refusal(ERRORS.paused);
    }
    this.checkGuards(job, mono);
    const { tenths } = job.wanted;
    if (tenths !== undefined) {
      // The ceiling may have been lowered since the command arrived.
      const high = Math.min(SETPOINT.max, this.config.ceiling);
      if (tenths < SETPOINT.min * 10 || tenths > high * 10) {
        throw this.refusal(ERRORS.outOfRange(SETPOINT.min, high));
      }
      if (this.unit !== 'C') {
        throw this.refusal(this.unit === 'F' ? ERRORS.fahrenheit : ERRORS.unitUnknown);
      }
      const { live, zone } = fresh;
      if (
        zone.standby !== false ||
        zone.away !== false ||
        zone.holiday !== false ||
        live.hubAway !== false ||
        live.hubHoliday !== false
      ) {
        throw this.refusal(ERRORS.notScheduled);
      }
    }
  }

  /** Too late to send: the true cause (the commands before it, or the hub). */
  lateError(ahead) {
    return this.refusal(ahead > 0 ? ERRORS.queueLate(ahead) : ERRORS.tooSlow);
  }

  /** The zone of a fresh read for a command on `target`, its identity checked; throws a refusal. */
  freshZone(target, device, hubId, live) {
    if (hubId !== target.hub) {
      throw this.refusal(ERRORS.otherHub);
    }
    if (target.zone === HUB_KEY) {
      return undefined;
    }
    const zone = live.zones.find((z) => z.id === target.zone);
    if (!zone) {
      throw this.refusal(ERRORS.zoneGone);
    }
    const expected =
      zoneNameParam(device) ??
      zoneNameParam(this.createdDevice(target.key)) ??
      this.zones.get(target.key)?.zone.rawName;
    if (expected === undefined || zone.rawName !== expected) {
      throw this.refusal(ERRORS.zoneRenamed);
    }
    if (!isSafeName(zone.rawName)) {
      throw this.refusal(ERRORS.nameNotSendable);
    }
    if (zone.offline !== false) {
      throw this.refusal(ERRORS.zoneOffline);
    }
    return zone;
  }

  async command(job) {
    const { target, device, wanted, received, ahead } = job;
    const generation = this.generation;
    const client = this.client;
    if (!client || !this.pin()) {
      throw this.refusal(this.configMessage() ?? ERRORS.noPin);
    }
    if (this.refused) {
      throw this.refusal(ERRORS.tokenRefused);
    }
    const start = this.monotonic();
    if (this.pauseLeft(start) > 0) {
      throw this.refusal(ERRORS.paused);
    }
    this.checkGuards(job, start);
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    if (start > sendBy - TIMINGS.commandMinSend) {
      throw this.lateError(ahead);
    }
    // The fresh read: never the values in memory.
    let read;
    try {
      read = await this.readLive(
        client,
        Math.min(start + TIMINGS.commandReadMax, sendBy - TIMINGS.commandMinSend),
      );
    } catch (err) {
      if (err instanceof NeoHubError && (err.kind === 'late' || err.kind === 'timeout')) {
        throw this.lateError(ahead);
      }
      if (err instanceof NeoHubError && err.kind === 'token') {
        await this.tokenRefused();
        throw this.refusal(ERRORS.tokenRefused);
      }
      throw this.refusal(ERRORS.unknownState(reasonOf(err)));
    }
    if (generation !== this.generation) {
      throw this.refusal(ERRORS.stopped);
    }
    const at = start;
    this.absorb(read.hubId, read.live, at);
    const zone = this.freshZone(target, device, read.hubId, read.live);
    const fresh = { live: read.live, zone };
    this.checkBeforeSend(job, generation, client, fresh);
    const key = target.key;
    // Already so, and no stop guard waits on it: nothing to write.
    const already =
      wanted.tenths !== undefined
        ? zone.targetTenths === wanted.tenths
        : wanted.command === API.commands.standbyOff
          ? zone.standby === false && !this.guardOf(key, this.monotonic())
          : read.live.hubAway === false && !this.guardOf(key, this.monotonic());
    if (already) {
      return undefined;
    }
    const argument =
      wanted.tenths !== undefined
        ? [wanted.tenths / 10, [zone.rawName]]
        : wanted.command === API.commands.standbyOff
          ? [zone.rawName]
          : 0;
    const before = wanted.tenths !== undefined ? zone.targetTenths : undefined;
    let left = false;
    try {
      await client.request(wanted.command, argument, {
        deadline: answerBy,
        beforeSend: () => {
          // Right before the first byte: the option, the ceiling, the guards and the session again.
          this.checkBeforeSend(job, generation, client, fresh);
          if (this.monotonic() >= sendBy) {
            throw this.lateError(ahead);
          }
        },
        onSent: () => {
          left = true;
          // "Schedule" or "Home" lifts the stop guard of its target as it leaves (never sooner).
          this.markLeft(key, job.seq);
          if (wanted.tenths === undefined && this.guards.has(key)) {
            this.persist(this.monotonic()).catch(() => {});
          }
          this.writtenAt.set(key, this.monotonic());
          this.pendingWrites.set(key, {
            command: wanted.command,
            expected: wanted.tenths,
            name: zone?.name,
            checks: 1 + TIMINGS.followUps.length,
          });
        },
      });
    } catch (err) {
      if (left) {
        this.afterWrite(generation);
      }
      if (!(err instanceof NeoHubError)) {
        throw err;
      }
      if (!left || !err.sent) {
        if (err.kind === 'late') throw this.lateError(ahead);
        throw this.refusal(ERRORS.notSent(reasonOf(err)));
      }
      if (err.kind === 'hub') {
        this.pendingWrites.delete(key);
        throw this.refusal(ERRORS.refusedByHub(err.text));
      }
      if (err.kind === 'token') {
        this.pendingWrites.delete(key);
        await this.tokenRefused();
        throw this.refusal(ERRORS.tokenRefusedSent);
      }
      throw this.refusal(ERRORS.unconfirmed);
    }
    this.afterWrite(generation);
    // Answered: read back within the ack when there is time, and compared.
    if (this.monotonic() <= received + TIMINGS.commandSendBy) {
      this.lastCheck.delete(key);
      let check;
      const checkedAt = this.monotonic();
      try {
        check = await this.readLive(client, answerBy);
      } catch {
        check = undefined;
      }
      if (check && generation === this.generation) {
        this.absorb(check.hubId, check.live, checkedAt);
        const result = this.lastCheck.get(key);
        this.lastCheck.delete(key);
        if (result === 'applied') {
          await this.refreshStatus();
          return undefined;
        }
        if (result === 'not_applied') {
          await this.refreshStatus();
          throw this.refusal(
            wanted.tenths !== undefined
              ? ERRORS.notAppliedNow(degrees(before), degrees(wanted.tenths))
              : ERRORS.notShownYet,
          );
        }
      }
    }
    throw this.refusal(ERRORS.verifyLater);
  }

  /** A command of `seq` left for `key` (its number is set when its first byte leaves). */
  markLeft(key, seq) {
    this.lastLeft.set(key, Math.max(this.lastLeft.get(key) ?? 0, seq));
  }

  /**
   * A stop guard still to be sent again: not shown by a read yet, and no
   * newer command of its target has left since (that one wins).
   */
  stillPending(key, guard) {
    return guard.pending && !this.lifted(key, guard);
  }

  /**
   * A read after a write: compared when the read started after the write
   * left. Records 'applied' or 'not_applied' in `lastCheck`. A write the
   * reads contradict is told (log, status, badge) until a read shows it, or
   * until the next read once its checks are spent.
   */
  checkWrite(key, subject, at) {
    const pending = this.pendingWrites.get(key);
    if (!pending || at < (this.writtenAt.get(key) ?? -Infinity)) {
      if (!pending) this.warnings.delete(key);
      return;
    }
    let ok;
    let unknown;
    if (pending.command === API.commands.setTemp) {
      ok = subject.targetTenths === pending.expected;
      unknown = subject.targetTenths === undefined;
    } else if (pending.command === API.commands.standbyOff) {
      ok = subject.standby === false;
      unknown = subject.standby === undefined;
    } else {
      ok = subject.hubAway === false;
      unknown = subject.hubAway === undefined;
    }
    if (ok) {
      this.pendingWrites.delete(key);
      this.warnings.delete(key);
      this.lastCheck.set(key, 'applied');
      return;
    }
    if (unknown) {
      return;
    }
    pending.checks -= 1;
    if (pending.checks <= 0) {
      this.pendingWrites.delete(key);
    }
    if (!this.warnings.has(key)) {
      this.logger.warn(`heatmiser-neohub: a command on ${key} is not shown by the hub`);
    }
    const label = pending.name ?? word(T.hub, 'en');
    this.warnings.set(key, both(label, pending.name ?? word(T.hub, 'fr')));
    this.lastCheck.set(key, 'not_applied');
  }

  async refreshStatus() {
    if (this.liveAt !== undefined && !this.offline) {
      await this.setStatus(true, this.statusMessage());
    }
    await this.publishBadges();
    await this.flush();
  }

  /** After a command that left: the hub read again 5 s and 20 s later. */
  afterWrite(generation) {
    for (const delay of TIMINGS.followUps) {
      const timer = this.timers.setTimeout(() => {
        this.followUps.delete(timer);
        if (generation !== this.generation) {
          return undefined;
        }
        return this.followUp().catch((err) =>
          this.logger.warn(`heatmiser-neohub: follow-up read failed (${err?.kind ?? 'error'})`),
        );
      }, delay);
      this.followUps.add(timer);
    }
  }

  /** One live read after a command: never skipped (it waits its turn behind a read or a command). */
  async followUp() {
    const client = this.client;
    const generation = this.generation;
    if (!client || this.refused) {
      return;
    }
    while (this.serving) {
      await this.serving;
    }
    if (generation !== this.generation) {
      return;
    }
    const at = this.monotonic();
    const { hubId, live } = await this.readLive(client, at + TIMINGS.requestTimeout);
    if (generation !== this.generation) {
      return;
    }
    this.absorb(hubId, live, at);
    await this.persist(this.monotonic());
    await this.refreshStatus();
  }

  // --- Protective commands (standby, away) -------------------------------------

  /** The guards a read shows done are not sent again; the expired ones are forgotten. */
  settleGuards(hubId, live, at) {
    let changed = false;
    for (const [key, guard] of this.guards) {
      if (guard.until <= at) {
        this.guards.delete(key);
        changed = true;
        continue;
      }
      if (!guard.pending || !key.startsWith(`${hubId}-`) || at < (guard.sentAt ?? -Infinity)) {
        continue;
      }
      const shown =
        guard.kind === 'away'
          ? live.hubAway === true
          : live.zones.find((z) => targetKey(hubId, z.id) === key)?.standby === true;
      if (shown) {
        guard.pending = false;
        changed = true;
      }
    }
    if (changed) {
      this.persist(this.monotonic()).catch(() => {});
    }
  }

  /**
   * Standby or away: never blocked by an option, a pause, a refused token,
   * the queue or a read in progress. The commands queued before it on its
   * target are cancelled (nothing asked before a stop leaves after it).
   */
  async protective(target, device, received, kind) {
    const seq = ++this.seq;
    const key = kind === 'away' ? targetKey(target.hub, HUB_KEY) : target.key;
    const name =
      kind === 'away'
        ? undefined
        : (zoneNameParam(device) ??
          zoneNameParam(this.createdDevice(key)) ??
          this.zones.get(key)?.zone.rawName);
    const mono = this.monotonic();
    const guard = {
      kind,
      seq,
      until: mono + TIMINGS.stopGuard,
      pending: true,
      resends: TIMINGS.protectiveResends,
      name,
    };
    this.guards.set(key, guard);
    for (const job of [...this.commands]) {
      if (job.target.hub === target.hub && (kind === 'away' || job.target.key === key)) {
        this.commands.splice(this.commands.indexOf(job), 1);
        job.reject(
          this.refusal(kind === 'away' ? ERRORS.cancelledByAway : ERRORS.cancelledByStandby),
        );
      }
    }
    // Kept in /data in the background: a failing /data never delays nor blocks a stop.
    this.persist(mono).catch(() => {});
    if (kind === 'standby' && (name === undefined || !isSafeName(name))) {
      guard.pending = false;
      throw this.refusal(name === undefined ? ERRORS.zoneNameUnknown : ERRORS.nameNotSendable);
    }
    if (this.hubId !== undefined && this.hubId !== target.hub) {
      guard.pending = false;
      throw this.refusal(ERRORS.otherHub);
    }
    const outcome = await this.sendProtective(key, guard, {
      sendBy: received + TIMINGS.commandSendBy,
      answerBy: received + TIMINGS.commandAnswerBy,
    });
    if (outcome.error) {
      throw this.refusal(outcome.error);
    }
    if (outcome.confirmed) {
      return undefined;
    }
    throw this.refusal(outcome.sent ? ERRORS.protectiveUnconfirmed : ERRORS.protectiveLater);
  }

  /**
   * One attempt (tried again within 250 ms when nothing left), then a read
   * to confirm it when there is time. Resolves `{ sent, confirmed, error }`;
   * never throws. The guard stays pending (sent again by the reads) unless
   * a read shows it or the hub refused it.
   */
  async sendProtective(key, guard, { sendBy, answerBy }) {
    const client = this.client;
    const generation = this.generation;
    if (!this.configLoaded) {
      return { error: ERRORS.protectiveLater };
    }
    if (!client) {
      return { error: this.configMessage() ?? ERRORS.noPin };
    }
    if (!this.pin()) {
      return { error: ERRORS.noPin };
    }
    if (guard.sending) {
      // Already on its way (a resend in progress): the same request, not a second one.
      return guard.sending;
    }
    const command = guard.kind === 'away' ? API.commands.awayOn : API.commands.standbyOn;
    const argument = guard.kind === 'away' ? 0 : [guard.name];
    guard.sending = (async () => {
      let firstFailure;
      for (;;) {
        let left = false;
        try {
          await client.request(command, argument, {
            deadline: answerBy,
            priority: true,
            beforeSend: () => {
              if (this.monotonic() >= sendBy) {
                throw new NeoHubError('late', 'too late to send');
              }
            },
            onSent: () => {
              left = true;
              guard.sentAt = this.monotonic();
              this.markLeft(key, guard.seq);
            },
          });
        } catch (err) {
          if (generation !== this.generation) {
            return { sent: left };
          }
          if (left || err?.sent) {
            if (err?.kind === 'token') {
              // Not done: kept pending (a new token restarts and sends it again from /data).
              await this.tokenRefused();
              return { sent: true, error: ERRORS.tokenRefusedSent };
            }
            if (err?.kind === 'hub') {
              guard.pending = false;
              this.persist(this.monotonic()).catch(() => {});
              return { sent: true, error: ERRORS.refusedByHub(err.text) };
            }
            this.afterWrite(generation);
            return { sent: true };
          }
          const mono = this.monotonic();
          firstFailure ??= mono;
          if (
            err?.kind === 'nopin' ||
            err?.kind === 'pin' ||
            err?.kind === 'stopped' ||
            mono - firstFailure >= TIMINGS.protectiveBudget ||
            mono >= sendBy - TIMINGS.commandMinSend
          ) {
            this.logger.warn(
              `heatmiser-neohub: ${guard.kind} not sent now (${err?.kind ?? 'error'}); kept for the next reads`,
            );
            return {
              sent: false,
              error:
                err?.kind === 'pin'
                  ? ERRORS.pinChanged
                  : err?.kind === 'nopin'
                    ? ERRORS.noPin
                    : ERRORS.protectiveNotSent(reasonOf(err)),
            };
          }
          await this.sleep(50);
          continue;
        }
        this.afterWrite(generation);
        // Answered: a read sent after it shows it?
        if (this.monotonic() < answerBy - TIMINGS.commandMinSend) {
          try {
            const at = this.monotonic();
            const check = await this.readLive(client, answerBy, true);
            if (generation === this.generation) {
              this.absorb(check.hubId, check.live, at);
              await this.refreshStatus();
            }
          } catch {
            // Checked by the next reads.
          }
        }
        return { sent: true, confirmed: !guard.pending };
      }
    })().finally(() => {
      guard.sending = undefined;
    });
    return guard.sending;
  }

  /**
   * The pending stop guards sent again (after a read, or at start from
   * /data), 3 times at most each, unless a newer command of the target left.
   */
  async resendGuards(generation) {
    for (const [key, guard] of [...this.guards]) {
      if (generation !== this.generation) return;
      const mono = this.monotonic();
      if (!this.stillPending(key, guard) || guard.until <= mono || guard.resends <= 0) continue;
      const [hub, zone] = key.split('-');
      if (this.hubId !== undefined && hub !== this.hubId) continue;
      if (guard.kind === 'standby' && guard.name === undefined) {
        guard.name = zoneNameParam(this.createdDevice(key)) ?? this.zones.get(key)?.zone.rawName;
        if (guard.name === undefined || !isSafeName(guard.name) || zone === HUB_KEY) {
          guard.pending = false;
          continue;
        }
      }
      guard.resends -= 1;
      this.logger.info(`heatmiser-neohub: ${guard.kind} sent again (not shown yet)`);
      await this.sendProtective(key, guard, {
        sendBy: mono + TIMINGS.commandSendBy,
        answerBy: mono + TIMINGS.commandAnswerBy,
      });
    }
    await this.persist(this.monotonic());
  }
}
