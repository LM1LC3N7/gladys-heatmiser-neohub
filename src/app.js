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
// Commands (zones addressed by their device number, by name once a hub
// refused or ignored numbers):
//   - protective, never blocked by an option, a pause, a refused token, the
//     queue or a read in progress: "Standby" on a zone (FROST_ON) and "Away"
//     on the hub (AWAY_ON). Sent at once, out of the queue, before any
//     waiting command (a read of the polling stuck for 1 s is cut for them),
//     the standbys of a scene together; tried again within 250 ms; acked by
//     ~3.4 s, still sent after the ack when the hub is busy. Decided by the
//     first read sent after the answer of the hub: shown, done (a change made
//     later in the app wins); not shown or not answered, sent again by the
//     next reads (3 times at most), told in the status and the badge. The
//     commands queued before them are cancelled; a newer "Schedule" / "Home"
//     that left (or is about to, written to /data first) lifts them.
//   - sensitive, refused unless "Allow heating commands" is on: the setpoint
//     (SET_TEMP), "Schedule" (FROST_OFF) and "Home" (AWAY_OFF). A bounded
//     queue (8), equal commands of a scene grouped; decided on a fresh read
//     (never on memory), the hub and the zone (number and name) checked; the
//     option, the bounds and the stop guards checked on arrival, after the
//     fresh read and right before the first byte (beforeSend); sent within
//     2.8 s of the click or refused unsent, acked by ~3.4 s; a command that
//     may have left is never "not sent"; confirmed by a read back showing the
//     value. A setpoint is refused while the zone (or the hub) is in standby,
//     away or on holiday, and for 10 min after a standby or an away, which
//     only "Schedule" or "Home" lift.
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

/** The zone name a created Gladys device was given at the Scan (a parameter). */
const zoneNameParam = (device) => {
  const value = device?.params?.find?.((p) => p?.name === 'zone_name')?.value;
  return typeof value === 'string' ? value : undefined;
};

/** Lists the first 5 entries, then "and N more". */
function bounded(entries, language) {
  const shown = entries.slice(0, 5).map((e) => e[language]);
  const more = entries.length - shown.length;
  return shown.join(', ') + (more > 0 ? T.andMore(more)[language] : '');
}

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
    /** hub -> 'name' once it refused or ignored device numbers in a command. */
    this.forms = new Map();
    /** delay -> the follow-up timer of that delay. */
    this.followUpBy = new Map();
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
    /** Commands sent, answered, waiting for a read back (until their ack). */
    this.unchecked = [];
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
    this.starting = true;
    try {
      await this.startSteps(raw);
    } finally {
      this.starting = false;
    }
  }

  async startSteps(raw) {
    this.stop();
    await this.running;
    this.config = normalizeConfig(raw);
    this.reset();
    const now = this.now();
    const mono = this.monotonic();
    let loaded = null;
    // Nothing is written to /data until it has been read (it would overwrite the pins).
    this.memoryUnreadable = true;
    try {
      loaded = await this.bounded(this.store.load());
      this.memoryUnreadable = false;
    } catch (err) {
      // Unreadable is not empty: the pins and the refused token are kept as they
      // were (never overwritten); read again every 10 s.
      this.memoryUnreadable = true;
      this.logger.warn(`heatmiser-neohub: /data unreadable (${err?.code ?? 'error'})`);
      // Only slow: read again at once, in the background, with more time; else in 10 s.
      this.scheduleMemoryRetry(err?.code === 'ETIMEDOUT' ? 0 : TIMINGS.dataRetry);
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
    if (this.tokenChanged) {
      // The token changed in this session: a new token is always tried (never
      // taken for the refused one by a collision of its 8-bit tag).
      this.memory.refused = null;
      if (!this.memoryUnreadable) this.tokenChanged = false;
    } else if (refused && refused.key === this.config.key && this.config.token) {
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
      // A fingerprint typed by the user is the pin from now on (the newest entry: kept first).
      delete this.memory.pins[this.config.key];
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
    // A standby or an away kept in /data and not yet answered leaves first, before
    // any read (never with a refused token: resendGuards checks it).
    await this.resendGuards(this.generation);
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
    this.followUpBy.clear();
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
    if (this.started && next.token !== previous.token) {
      this.tokenChanged = true;
    }
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
  bounded(promise, ms = TIMINGS.dataTimeout) {
    let timer;
    const late = new Promise((_resolve, reject) => {
      timer = this.timers.setTimeout(
        () => reject(Object.assign(new Error('/data too slow'), { code: 'ETIMEDOUT' })),
        ms,
      );
    });
    promise.catch(() => {});
    return Promise.race([promise, late]).finally(() => this.timers.clearTimeout(timer));
  }

  /** /data unreadable at start: read again on its own timer (one read at a time), then merged. */
  scheduleMemoryRetry(delay = TIMINGS.dataRetry) {
    const generation = this.generation;
    this.timers.clearTimeout(this.memoryTimer);
    this.memoryTimer = this.timers.setTimeout(async () => {
      this.memoryTimer = undefined;
      if (generation !== this.generation) return;
      let loaded;
      try {
        // Off the path of any command: a slow disk gets more time here.
        loaded = await this.bounded(this.store.load(), TIMINGS.dataRetryTimeout);
      } catch {
        if (generation === this.generation) this.scheduleMemoryRetry();
        return;
      }
      if (generation !== this.generation) return;
      await this.mergeMemory(loaded);
    }, delay);
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
      !this.tokenChanged &&
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
    this.tokenChanged = false;
    await this.persist(mono);
    if (!hadPin && this.pin() && isComplete(this.config)) {
      // The pin is back: the status says so, a stop asked meanwhile leaves, then a read.
      this.openClient();
      const generation = this.generation;
      await this.setStatus(false, this.refused ? T.tokenRefused : T.connecting);
      await this.resendGuards(generation);
      if (generation === this.generation && !this.refused) {
        this.schedule();
        await this.tick();
      }
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

  /**
   * GET_LIVE_DATA -> `{ hubId, live, at }` (`at`: when it left); kept as the
   * last read, which a command arrived before it may use as its fresh read.
   */
  async readLive(client, deadline, priority = false) {
    let at = this.monotonic();
    const generation = this.generation;
    const { hubId, response } = await client.request(API.commands.live, 0, {
      deadline,
      priority,
      onSent: () => {
        at = this.monotonic();
      },
    });
    const live = parseLive(response);
    if (!live) {
      throw new NeoHubError('protocol', 'not live data', { sent: true });
    }
    const read = { hubId, live, at, generation };
    if (!this.lastRead || at >= this.lastRead.at) this.lastRead = read;
    return read;
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
    if (this.unit !== undefined && live.systemStamp !== this.systemStamp) {
      // The system of the hub changed (°C / °F among others): no temperature
      // published nor setpoint sent until GET_SYSTEM is read again.
      this.unit = undefined;
    }
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
    // Commands waiting for a read back get their answer from this read.
    this.settleChecked();
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
    if (!this.config.fingerprint && this.pin()) {
      // Learnt on the first click: said so, with the fingerprint to compare.
      message = join(message, T.learnt(this.pin()));
    }
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
    const contradicted = [...this.guards.entries()].filter(([, g]) => g.contradicted && !g.shown);
    if (contradicted.length > 0) {
      const names = contradicted.map(([key, g]) =>
        g.kind === 'away'
          ? T.hub
          : both(this.zones.get(key)?.zone.name ?? key, this.zones.get(key)?.zone.name ?? key),
      );
      message = join(
        message,
        T.guardContradicted(both(bounded(names, 'en'), bounded(names, 'fr'))),
      );
    } else if ([...this.guards.entries()].some(([key, g]) => this.stillPending(key, g))) {
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
    const guard = this.guards.get(key);
    if (guard?.contradicted && !guard.shown) {
      return {
        transport: DEVICE_TRANSPORTS.LOCAL,
        degraded: true,
        message: both(
          guard.kind === 'away'
            ? 'Away answered by the hub but not applied: sent again'
            : 'Standby answered by the hub but not applied: sent again',
          guard.kind === 'away'
            ? 'Absence répondue par le hub mais pas appliquée : renvoyée'
            : 'Veille répondue par le hub mais pas appliquée : renvoyée',
        ),
      };
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
   * checked, then queued (8 at most). A queued command whose turn has not come
   * by its send deadline is refused unsent at that moment (the ack never waits
   * for the commands before it).
   */
  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.monotonic();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !COMMAND_ROLES.includes(target.role)) {
      throw this.refusal(ERRORS.readOnly);
    }
    // Protective first: not even the configuration of Gladys is needed to keep it
    // (it leaves as soon as the configuration is read, before the first read).
    if (target.role === F.MODE && value === MODES.STANDBY) {
      return this.protective(target, received, 'standby');
    }
    if (target.role === F.AWAY && value === AWAY.AWAY) {
      return this.protective(target, received, 'away');
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
      const job = { target, wanted, received, ahead, seq, resolve, reject, done: false };
      job.timer = this.timers.setTimeout(() => {
        const i = this.commands.indexOf(job);
        if (i >= 0) {
          this.commands.splice(i, 1);
          this.settleJob(job, this.lateError(ahead));
        }
      }, TIMINGS.commandSendBy - TIMINGS.commandMinSend);
      this.commands.push(job);
      this.serveCommands();
    });
  }

  /** Answers a job once (an Error rejects it, anything else resolves it). */
  settleJob(job, result) {
    if (job.done) return;
    job.done = true;
    this.timers.clearTimeout(job.timer);
    if (result instanceof Error) job.reject(result);
    else job.resolve(result);
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

  /**
   * One group at a time: the first waiting command and those of the queue
   * that ask the same thing (the same setpoint, Schedule) of other zones of the
   * same hub, sent in one command (the PDF takes a list of devices).
   */
  serveCommands() {
    if (this.serving) {
      return this.serving;
    }
    this.serving = (async () => {
      // The commands of a scene arrive within a few ms: gathered, then grouped.
      await this.sleep(TIMINGS.gather);
      while (this.commands.length > 0) {
        const head = this.commands.shift();
        const group = [head];
        for (const job of [...this.commands]) {
          if (
            job.wanted.command === head.wanted.command &&
            job.wanted.tenths === head.wanted.tenths &&
            job.target.hub === head.target.hub &&
            !group.some((g) => g.target.key === job.target.key)
          ) {
            this.commands.splice(this.commands.indexOf(job), 1);
            group.push(job);
          }
        }
        for (const job of group) this.timers.clearTimeout(job.timer);
        try {
          await this.serveGroup(group);
        } catch (err) {
          for (const job of group) this.settleJob(job, err);
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

  /**
   * The stop guard of a key in force at `mono`, else undefined: an expired one
   * is forgotten; one that a newer command of its target lifted is no longer
   * in force.
   */
  guardOf(key, mono) {
    const guard = this.guards.get(key);
    if (guard && guard.until <= mono) {
      this.guards.delete(key);
      return undefined;
    }
    return guard && !this.lifted(key, guard) ? guard : undefined;
  }

  /**
   * A newer "Schedule" or "Home" of the target lifted the guard: it left
   * (its number is the last that left), or it is about to (`liftPending`, set
   * and written to /data right before its first byte).
   */
  lifted(key, guard) {
    return guard.liftPending === true || (this.lastLeft.get(key) ?? 0) > guard.seq;
  }

  /** A command of `seq` left for `key` (its number is set when its first byte leaves). */
  markLeft(key, seq) {
    this.lastLeft.set(key, Math.max(this.lastLeft.get(key) ?? 0, seq));
  }

  /** A stop guard still to be sent again: not answered by the hub yet, not lifted. */
  stillPending(key, guard) {
    return guard.pending && !this.lifted(key, guard);
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

  /**
   * The zone of a fresh read for a command on `target`, its identity checked
   * (the hub; the zone at its device number, with the name the previous read
   * gave it: renamed or swapped since, refused); throws a refusal.
   */
  freshZone(target, hubId, live, expected) {
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
    if (expected === undefined) {
      throw this.refusal(ERRORS.zoneNotRead);
    }
    if (zone.rawName !== expected) {
      throw this.refusal(ERRORS.zoneRenamed);
    }
    if (zone.offline !== false) {
      throw this.refusal(ERRORS.zoneOffline);
    }
    return zone;
  }

  /** A live read sent after `since` and after the last write on each of `keys`, else undefined. */
  freshRead(since, keys) {
    const read = this.lastRead;
    if (!read || read.generation !== this.generation || read.at < since) {
      return undefined;
    }
    return keys.every((k) => read.at >= (this.writtenAt.get(k) ?? -Infinity)) ? read : undefined;
  }

  async serveGroup(group) {
    const generation = this.generation;
    const client = this.client;
    const { command, tenths } = group[0].wanted;
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
    const sendBy = Math.min(...group.map((j) => j.received)) + TIMINGS.commandSendBy;
    const answerBy = Math.min(...group.map((j) => j.received)) + TIMINGS.commandAnswerBy;
    let jobs = group.filter((job) => {
      try {
        this.checkGuards(job, start);
        return true;
      } catch (err) {
        this.settleJob(job, err);
        return false;
      }
    });
    if (jobs.length === 0) return;
    if (start > sendBy - TIMINGS.commandMinSend) {
      for (const job of jobs) this.settleJob(job, this.lateError(job.ahead));
      return;
    }
    // The names the zones had at the previous read (identity), then the fresh read:
    // one sent after the arrival of every command of the group (shared), never memory.
    const expected = new Map(
      jobs.map((j) => [
        j.target.key,
        // The previous read, else (right after a restart) the name kept at the Scan.
        this.zones.get(j.target.key)?.zone.rawName ??
          zoneNameParam(this.createdDevice(j.target.key)),
      ]),
    );
    const keys = jobs.map((j) => j.target.key);
    let read = this.freshRead(Math.max(...jobs.map((j) => j.received)), keys);
    if (!read) {
      try {
        read = await this.readLive(
          client,
          Math.min(start + TIMINGS.commandReadMax, sendBy - TIMINGS.commandMinSend),
        );
      } catch (err) {
        if (err instanceof NeoHubError && (err.kind === 'late' || err.kind === 'timeout')) {
          for (const job of jobs) this.settleJob(job, this.lateError(job.ahead));
          return;
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
      this.absorb(read.hubId, read.live, read.at);
    }
    // A setpoint needs the unit: read now when unknown (right after a restart), within the deadline.
    if (
      tenths !== undefined &&
      this.unit === undefined &&
      this.monotonic() < sendBy - 2 * TIMINGS.commandMinSend
    ) {
      try {
        const { hubId, response } = await client.request(API.commands.system, 0, {
          deadline: sendBy - TIMINGS.commandMinSend,
        });
        const system = parseSystem(response);
        if (
          generation === this.generation &&
          hubId === read.hubId &&
          system?.unit &&
          this.unit === undefined
        ) {
          this.unit = system.unit;
          this.systemStamp = read.live.systemStamp;
        }
      } catch {
        // Unknown: the setpoint is refused below.
      }
    }
    const fresh = new Map();
    jobs = jobs.filter((job) => {
      try {
        const zone = this.freshZone(
          job.target,
          read.hubId,
          read.live,
          expected.get(job.target.key),
        );
        const entry = { live: read.live, zone };
        this.checkBeforeSend(job, generation, client, entry);
        // Already so, and no stop guard waits on it: nothing to write.
        const already =
          tenths !== undefined
            ? zone.targetTenths === tenths
            : command === API.commands.standbyOff
              ? zone.standby === false && !this.guardOf(job.target.key, this.monotonic())
              : read.live.hubAway === false && !this.guardOf(job.target.key, this.monotonic());
        if (already) {
          this.settleJob(job, undefined);
          return false;
        }
        fresh.set(job, entry);
        return true;
      } catch (err) {
        this.settleJob(job, err);
        return false;
      }
    });
    if (jobs.length === 0) return;
    // "Schedule" / "Home": the lift of its stop guard is written to /data (and
    // succeeds) before the first byte; a restart never sends the stop again after it.
    const lifting = jobs.filter(
      (j) => tenths === undefined && this.guardOf(j.target.key, this.monotonic()),
    );
    for (const job of lifting) this.guards.get(job.target.key).liftPending = true;
    const unlift = () => {
      for (const job of lifting) {
        const guard = this.guards.get(job.target.key);
        if (guard && (this.lastLeft.get(job.target.key) ?? 0) <= guard.seq)
          guard.liftPending = false;
      }
      if (lifting.length > 0) this.persist(this.monotonic()).catch(() => {});
    };
    if (lifting.length > 0 && !(await this.persist(this.monotonic()))) {
      unlift();
      for (const job of jobs) this.settleJob(job, this.refusal(ERRORS.liftNotSaved));
      return;
    }
    let sending = jobs;
    let left = false;
    // Device numbers (PDF p. 8), or names once this hub refused or ignored numbers.
    const form = this.formOf(group[0].target.hub);
    try {
      await client.request(
        command,
        () => {
          const ids = sending.map((j) =>
            form === 'name' ? fresh.get(j).zone.rawName : j.target.zone,
          );
          if (tenths !== undefined) return [tenths / 10, ids];
          return command === API.commands.standbyOff ? ids : 0;
        },
        {
          deadline: answerBy,
          sendBy,
          beforeSend: () => {
            // Right before the first byte: the option, the ceiling, the guards and the session again.
            sending = sending.filter((job) => {
              try {
                this.checkBeforeSend(job, generation, client, fresh.get(job));
                if (
                  form === 'name' &&
                  job.target.zone !== HUB_KEY &&
                  !isSafeName(fresh.get(job).zone.rawName)
                ) {
                  throw this.refusal(ERRORS.zoneNameUnknown);
                }
                return true;
              } catch (err) {
                this.settleJob(job, err);
                return false;
              }
            });
            if (sending.length === 0) {
              throw new NeoHubError('late', 'nothing left to send');
            }
            if (this.monotonic() >= sendBy) {
              throw new NeoHubError('late', 'too late to send');
            }
          },
          onSent: () => {
            left = true;
            const at = this.monotonic();
            for (const job of sending) {
              const key = job.target.key;
              // From now on its number lifts the stop (the pending mark is not needed any more).
              this.markLeft(key, job.seq);
              const guard = this.guards.get(key);
              if (guard) guard.liftPending = false;
              this.writtenAt.set(key, at);
              this.pendingWrites.set(key, {
                command,
                expected: tenths,
                name: fresh.get(job).zone?.name,
                checks: 1 + TIMINGS.followUps.length,
              });
            }
          },
        },
      );
    } catch (err) {
      if (!left) unlift();
      if (left) this.afterWrite(generation);
      if (!(err instanceof NeoHubError)) {
        for (const job of sending) this.settleJob(job, err);
        return;
      }
      let result;
      if (!left || !err.sent) {
        result =
          err.kind === 'late'
            ? this.lateError(sending[0]?.ahead ?? 0)
            : this.refusal(ERRORS.notSent(reasonOf(err)));
      } else if (err.kind === 'hub' && form === 'number' && command !== API.commands.awayOff) {
        // The hub may not take device numbers: names from now on for this hub.
        this.forms.set(group[0].target.hub, 'name');
        result = this.refusal(ERRORS.numbersRefused);
      } else if (err.kind === 'hub') {
        result = this.refusal(ERRORS.refusedByHub(err.text));
      } else if (err.kind === 'token') {
        await this.tokenRefused();
        result = this.refusal(ERRORS.tokenRefusedSent);
      } else {
        result = this.refusal(ERRORS.unconfirmed);
      }
      for (const job of sending) {
        if (err.kind === 'hub' || err.kind === 'token') this.pendingWrites.delete(job.target.key);
        else if (!left) this.pendingWrites.delete(job.target.key);
        this.settleJob(job, result);
      }
      return;
    }
    this.afterWrite(generation);
    for (const job of sending) {
      this.lastCheck.delete(job.target.key);
      this.unchecked.push({
        job,
        key: job.target.key,
        tenths,
        before: fresh.get(job).zone?.targetTenths,
      });
    }
    // Answered: read back within the ack. When other commands wait, the read
    // back of the last of them confirms this one too (one read for the scene);
    // whatever no read shows by the ack is "sent, not shown yet".
    const answeredAt = this.monotonic();
    this.timers.setTimeout(
      () => {
        for (const job of sending) this.settleJob(job, this.refusal(ERRORS.verifyLater));
        this.unchecked = this.unchecked.filter((u) => !u.job.done);
      },
      Math.max(0, answerBy - answeredAt),
    );
    if (this.commands.length > 0 || answeredAt >= answerBy - TIMINGS.commandMinSend) {
      return;
    }
    let check;
    try {
      check = await this.readLive(client, answerBy);
    } catch {
      check = undefined;
    }
    if (check && generation === this.generation) {
      this.absorb(check.hubId, check.live, check.at);
      // The ack never waits for the publication to Gladys.
      this.refreshStatus().catch(() => {});
    }
  }

  /** The commands sent and waiting for a read back: answered from what the reads showed. */
  settleChecked() {
    for (const entry of this.unchecked) {
      const result = this.lastCheck.get(entry.key);
      if (result === 'applied') {
        this.settleJob(entry.job, undefined);
      } else if (result === 'not_applied') {
        this.settleJob(
          entry.job,
          this.refusal(
            entry.tenths !== undefined
              ? ERRORS.notAppliedNow(degrees(entry.before), degrees(entry.tenths))
              : ERRORS.notShownYet,
          ),
        );
      }
      if (entry.job.done) this.lastCheck.delete(entry.key);
    }
    this.unchecked = this.unchecked.filter((u) => !u.job.done);
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
      // One follow-up per delay for every command that leaves meanwhile (grouped).
      if (this.followUpBy.has(delay)) continue;
      const timer = this.timers.setTimeout(() => {
        this.followUps.delete(timer);
        this.followUpBy.delete(delay);
        if (generation !== this.generation) {
          return undefined;
        }
        return this.followUp().catch((err) =>
          this.logger.warn(`heatmiser-neohub: follow-up read failed (${err?.kind ?? 'error'})`),
        );
      }, delay);
      this.followUps.add(timer);
      this.followUpBy.set(delay, timer);
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

  /** How this hub takes its zones in a command: 'number' (PDF p. 8) until it refuses or ignores one, then 'name'. */
  formOf(hub) {
    return this.forms.get(hub) ?? 'number';
  }

  /** The exact name of a zone for a command: the last read, else the Scan; undefined when none can be sent. */
  nameOf(key) {
    const name = this.zones.get(key)?.zone.rawName ?? zoneNameParam(this.createdDevice(key));
    return isSafeName(name) ? name : undefined;
  }

  /**
   * A stop is decided by the first read sent after the hub answered it: shown,
   * it is done (a change made later in the app wins, it is never sent again);
   * not shown, it is contradicted: sent again with the next reads (by name when
   * it went by number), told in the status and the badge. Before any answer, a
   * read sent after it that shows it settles it too. Expired guards are forgotten.
   */
  settleGuards(hubId, live, at) {
    let changed = false;
    for (const [key, guard] of this.guards) {
      if (guard.until <= at) {
        this.guards.delete(key);
        changed = true;
        continue;
      }
      if (guard.shown || !key.startsWith(`${hubId}-`)) {
        continue;
      }
      const shown =
        guard.kind === 'away'
          ? live.hubAway === true
          : live.zones.find((z) => targetKey(hubId, z.id) === key)?.standby === true;
      const decisive = guard.answeredAt !== undefined && at >= guard.answeredAt;
      if (shown && (decisive || at >= (guard.sentAt ?? -Infinity))) {
        guard.shown = true;
        guard.pending = false;
        guard.contradicted = false;
        changed = true;
      } else if (decisive && !shown && !guard.decided) {
        guard.decided = true;
        guard.contradicted = true;
        guard.pending = true;
        if (guard.kind === 'standby' && guard.form === 'number') {
          this.forms.set(hubId, 'name');
        }
        this.logger.warn(`heatmiser-neohub: the hub answered a ${guard.kind} but does not show it`);
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
   * target are cancelled (nothing asked before a stop leaves after it). The
   * ack comes by ~3.4 s; a stop not sent by then stays in the lane and leaves
   * as soon as the hub is free.
   */
  async protective(target, received, kind) {
    const seq = ++this.seq;
    const key = kind === 'away' ? targetKey(target.hub, HUB_KEY) : target.key;
    const mono = this.monotonic();
    const guard = {
      kind,
      seq,
      hub: target.hub,
      zone: kind === 'away' ? HUB_KEY : target.zone,
      until: mono + TIMINGS.stopGuard,
      pending: true,
      shown: false,
      resends: TIMINGS.protectiveResends,
    };
    this.guards.set(key, guard);
    for (const job of [...this.commands]) {
      if (job.target.hub === target.hub && (kind === 'away' || job.target.key === key)) {
        this.commands.splice(this.commands.indexOf(job), 1);
        this.settleJob(
          job,
          this.refusal(kind === 'away' ? ERRORS.cancelledByAway : ERRORS.cancelledByStandby),
        );
      }
    }
    // Kept in /data in the background: a failing /data never delays nor blocks a stop.
    this.persist(mono).catch(() => {});
    if (this.hubId !== undefined && this.hubId !== target.hub) {
      guard.pending = false;
      throw this.refusal(ERRORS.otherHub);
    }
    let timer;
    const ack = new Promise((resolve) => {
      timer = this.timers.setTimeout(
        () => resolve({ late: true }),
        Math.max(0, received + TIMINGS.commandAnswerBy - this.monotonic()),
      );
    });
    const outcome = await Promise.race([this.sendProtective(key, guard), ack]);
    this.timers.clearTimeout(timer);
    // The status and the badges follow; the ack never waits for them.
    this.refreshStatus().catch(() => {});
    if (outcome.late) {
      throw this.refusal(
        guard.sentAt !== undefined && this.guards.get(key) === guard
          ? ERRORS.protectiveWaiting
          : ERRORS.protectiveSending,
      );
    }
    if (outcome.error) {
      throw this.refusal(outcome.error);
    }
    if (outcome.lifted) {
      throw this.refusal(ERRORS.liftedBefore);
    }
    if (guard.shown) {
      return undefined;
    }
    if (guard.contradicted) {
      throw this.refusal(ERRORS.protectiveContradicted);
    }
    if (outcome.answered) {
      throw this.refusal(ERRORS.protectiveAccepted);
    }
    throw this.refusal(outcome.sent ? ERRORS.protectiveUnconfirmed : ERRORS.protectiveLater);
  }

  /**
   * Sends a stop: the standbys waiting for the lane go together (one FROST_ON
   * with their device numbers, or one per zone by name when the hub refuses
   * numbers); an away alone. Resolves the outcome of this guard, never throws.
   */
  sendProtective(key, guard) {
    if (!this.configLoaded) {
      return Promise.resolve({ error: ERRORS.protectiveLater });
    }
    if (!this.client) {
      // During a restart of the connection it leaves at its end (kept pending).
      return Promise.resolve({
        error: this.starting ? ERRORS.protectiveLater : (this.configMessage() ?? ERRORS.noPin),
      });
    }
    if (!this.pin()) {
      return Promise.resolve({ error: ERRORS.noPin });
    }
    const slot = guard.kind === 'away' ? 'awayBatch' : 'standbyBatch';
    let batch = this[slot];
    if (!batch || batch.closed) {
      batch = { kind: guard.kind, guards: new Map(), closed: false };
      this[slot] = batch;
      batch.promise = this.runProtective(batch).finally(() => {
        batch.closed = true;
        if (this[slot] === batch) this[slot] = undefined;
      });
    }
    batch.guards.set(key, guard);
    return batch.promise.then((outcomes) => outcomes.get(key) ?? { lifted: true });
  }

  /** Every guard of a batch -> its outcome. By number first; by name per zone when the hub needs it. */
  async runProtective(batch) {
    const outcomes = new Map();
    // Let the standbys of a scene join (they arrive within a few ms).
    await this.sleep(TIMINGS.gather);
    const hub = [...batch.guards.values()][0]?.hub;
    let keys = [...batch.guards.keys()];
    if (batch.kind === 'away' || this.formOf(hub) === 'number') {
      const result = await this.sendStop(batch, keys, 'number');
      if (!result.numbersRefused) {
        for (const k of keys) {
          // A guard left out at the send was lifted by a newer command.
          outcomes.set(k, result.included && !result.included.has(k) ? { lifted: true } : result);
        }
        return outcomes;
      }
      // The hub refused the device numbers: by name from now on, zone by zone.
      this.forms.set(hub, 'name');
      this.logger.warn('heatmiser-neohub: the hub refused device numbers; zones are sent by name');
      keys = [...result.included];
    }
    for (const k of keys) {
      outcomes.set(k, await this.sendStop(batch, [k], 'name'));
    }
    batch.closed = true;
    return outcomes;
  }

  /**
   * One stop command for `keys` (a list of numbers, or one name), tried again
   * within 250 ms while nothing left; then a read to decide it. Never throws.
   */
  async sendStop(batch, keys, form) {
    const client = this.client;
    const generation = this.generation;
    const command = batch.kind === 'away' ? API.commands.awayOn : API.commands.standbyOn;
    let firstFailure;
    for (;;) {
      let included;
      let left = false;
      try {
        await client.request(
          command,
          () => {
            // Right before the first byte: a guard lifted by a newer "Schedule" / "Home" is left out.
            included = new Map(
              keys
                .map((k) => [k, batch.guards.get(k)])
                .filter(([k, g]) => g && this.guards.get(k) === g && !this.lifted(k, g)),
            );
            if (included.size === 0) {
              throw new NeoHubError('lifted', 'a newer command left');
            }
            if (batch.kind === 'away') return 0;
            if (form === 'number') return [...included.values()].map((g) => g.zone);
            const name = this.nameOf(keys[0]);
            if (name === undefined) throw new NeoHubError('noname', 'no name to send');
            return [name];
          },
          {
            deadline: this.monotonic() + TIMINGS.requestTimeout,
            // Never dropped from the lane: it leaves as soon as the hub is free.
            sendBy: Infinity,
            priority: true,
            onSent: () => {
              left = true;
              batch.closed = true;
              const at = this.monotonic();
              for (const [k, g] of included) {
                g.sentAt = at;
                g.form = batch.kind === 'away' ? 'number' : form;
                g.answeredAt = undefined;
                g.decided = false;
                this.markLeft(k, g.seq);
              }
            },
          },
        );
      } catch (err) {
        if (generation !== this.generation) {
          return { sent: left };
        }
        const done = included ? new Set(included.keys()) : undefined;
        if (left || err?.sent) {
          this.afterWrite(generation);
          if (err?.kind === 'token') {
            // Not done: kept pending (only a new token or a click sends it again).
            await this.tokenRefused();
            return { sent: true, included: done, error: ERRORS.tokenRefusedSent };
          }
          if (err?.kind === 'hub') {
            if (form === 'number' && batch.kind === 'standby') {
              return { sent: true, included: done, numbersRefused: true };
            }
            for (const g of included.values()) g.pending = false;
            this.persist(this.monotonic()).catch(() => {});
            return { sent: true, included: done, error: ERRORS.refusedByHub(err.text) };
          }
          return { sent: true, included: done };
        }
        if (err?.kind === 'lifted') {
          return { sent: false, lifted: true };
        }
        if (err?.kind === 'noname') {
          return { sent: false, error: ERRORS.zoneNameUnknown };
        }
        const mono = this.monotonic();
        firstFailure ??= mono;
        if (
          err?.kind === 'nopin' ||
          err?.kind === 'pin' ||
          err?.kind === 'stopped' ||
          mono - firstFailure >= TIMINGS.protectiveBudget
        ) {
          this.logger.warn(
            `heatmiser-neohub: ${batch.kind} not sent now (${err?.kind ?? 'error'}); kept for the next reads`,
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
      // Answered without error: the first read sent from now on decides it.
      const answeredAt = this.monotonic();
      for (const g of included.values()) g.answeredAt = answeredAt;
      this.persist(answeredAt).catch(() => {});
      this.afterWrite(generation);
      try {
        const check = await this.readLive(client, this.monotonic() + TIMINGS.commandReadMax, true);
        if (generation === this.generation) {
          this.absorb(check.hubId, check.live, check.at);
        }
      } catch {
        // Decided by the next reads.
      }
      return { sent: true, answered: true, included: new Set(included.keys()) };
    }
  }

  /**
   * The pending stop guards sent again (after a read, or at start from
   * /data), 3 times at most each; never with a refused token, never one a
   * newer command lifted, never one of another hub.
   */
  async resendGuards(generation) {
    if (this.refused) {
      return;
    }
    // Before the hub of this session answers, only the hub of the devices created in Gladys.
    const hubs = new Set(
      this.hubId !== undefined
        ? [this.hubId]
        : this.createdDevices().map((d) => parseDeviceId(d.external_id).hub),
    );
    const sends = [];
    for (const [key, guard] of [...this.guards]) {
      if (generation !== this.generation) return;
      const mono = this.monotonic();
      if (!this.stillPending(key, guard) || guard.until <= mono || guard.resends <= 0) continue;
      const [hub, zone] = key.split('-');
      if (!hubs.has(hub)) continue;
      guard.hub ??= hub;
      guard.zone ??= zone === HUB_KEY ? HUB_KEY : Number(zone);
      guard.resends -= 1;
      this.logger.info(`heatmiser-neohub: ${guard.kind} sent again (not applied yet)`);
      sends.push(this.sendProtective(key, guard));
    }
    await Promise.all(sends);
    await this.persist(this.monotonic());
    if (sends.length > 0 && generation === this.generation) {
      await this.refreshStatus();
    }
  }
}
