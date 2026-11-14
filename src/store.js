// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), bounded and repaired when read back:
//   - the time of the last read attempt (a restart never reads sooner than
//     the interval);
//   - for the hub address in use (a hash of it: the address itself is never
//     written), the pause after failed reads;
//   - the certificate pins, by address hash (4 at most);
//   - a refused token: its 8-bit tag and salt only (src/config.js tokenTag),
//     never the token;
//   - the stop guards (standby, away): their target, their end and whether
//     the command still has to be sent again (3 times at most).
// A small JSON file, written through a temporary file and a rename, one save
// after the other, readable by the container user only (0600).
// -----------------------------------------------------------------------------

import { open, readFile, rename } from 'node:fs/promises';
import { TIMINGS } from './constants.js';

export const STATE_FILE = '/data/heatmiser-neohub-state.json';
/** A larger file is not ours: refused (read bounded). */
const MAX_STATE_BYTES = 64 * 1024;
const MAX_PINS = 4;
const MAX_GUARDS = 70;

export function fileStore(path = STATE_FILE) {
  let chain = Promise.resolve();
  return {
    /** null when there is no file (a fresh install); throws when it cannot be read or parsed. */
    async load() {
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') {
          return null;
        }
        throw err;
      }
      if (Buffer.byteLength(text) > MAX_STATE_BYTES) {
        throw new Error('state file too large');
      }
      return JSON.parse(text);
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        const file = await open(temporary, 'w', 0o600);
        try {
          await file.writeFile(text, 'utf8');
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** The same in memory (tests). */
export function memoryStore(initial = null) {
  return {
    data: initial,
    saves: 0,
    async load() {
      return this.data === null ? null : structuredClone(this.data);
    },
    async save(data) {
      this.saves += 1;
      this.data = structuredClone(data);
    },
  };
}

const time = (value) => (Number.isFinite(value) && value > 0 ? value : undefined);
const KEY = /^[0-9a-f]{32}$/;
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
/** `<hub>-<zone>` or `<hub>-hub`. */
export const TARGET = /^[0-9a-f]{12}-(\d{1,5}|hub)$/;

/**
 * The persisted state, repaired. Ends (pause, guards) are capped from `now`
 * (wall clock): a date further than its longest duration is invalid (a
 * clock set back, a hand-edited file), never kept as is.
 */
export function normalizeMemory(raw, now = Date.now()) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const lastAttemptAt = time(r.lastAttemptAt);
  const key = typeof r.key === 'string' && KEY.test(r.key) ? r.key : '';
  const p = r.pause;
  const pause =
    key && p && typeof p === 'object' && time(p.until) && p.until <= now + TIMINGS.pauseMax
      ? {
          until: p.until,
          failures: Number.isInteger(p.failures) && p.failures >= 0 ? Math.min(p.failures, 10) : 0,
        }
      : null;
  const pins = {};
  if (r.pins && typeof r.pins === 'object' && !Array.isArray(r.pins)) {
    for (const [k, v] of Object.entries(r.pins).slice(0, MAX_PINS)) {
      if (KEY.test(k) && typeof v === 'string' && FINGERPRINT.test(v)) {
        pins[k] = v;
      }
    }
  }
  const f = r.refused;
  const refused =
    f &&
    typeof f === 'object' &&
    typeof f.key === 'string' &&
    KEY.test(f.key) &&
    typeof f.salt === 'string' &&
    /^[0-9a-f]{16,32}$/.test(f.salt) &&
    typeof f.tag === 'string' &&
    /^[0-9a-f]{2}$/.test(f.tag)
      ? { key: f.key, salt: f.salt, tag: f.tag }
      : null;
  const guards = [];
  if (Array.isArray(r.guards)) {
    for (const g of r.guards.slice(0, MAX_GUARDS)) {
      if (
        g &&
        typeof g === 'object' &&
        typeof g.target === 'string' &&
        TARGET.test(g.target) &&
        (g.kind === 'standby' || g.kind === 'away') &&
        time(g.until) &&
        g.until > now &&
        g.until <= now + TIMINGS.stopGuard
      ) {
        guards.push({
          target: g.target,
          kind: g.kind,
          until: g.until,
          pending: g.pending === true,
          resends:
            Number.isInteger(g.resends) && g.resends >= 0
              ? Math.min(g.resends, TIMINGS.protectiveResends)
              : TIMINGS.protectiveResends,
        });
      }
    }
  }
  return {
    lastAttemptAt: lastAttemptAt === undefined ? null : Math.min(lastAttemptAt, now),
    key,
    pause,
    pins,
    refused,
    guards,
  };
}
