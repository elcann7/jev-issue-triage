// Local storage of results (a JSON file). After a restart the same issue is not analyzed again (saves money).
// The daily usage counter is stored here too.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function createStore(path, { maxItems = 500, now = Date.now } = {}) {
  let db = { items: {}, days: {} };
  if (path && existsSync(path)) {
    try {
      db = JSON.parse(readFileSync(path, "utf8"));
      db.items ||= {};
      db.days ||= {};
    } catch {
      db = { items: {}, days: {} }; // corrupt file: start empty
    }
  }
  const dayKey = () => new Date(now()).toISOString().slice(0, 10);
  const save = () => {
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(db));
    renameSync(tmp, path);
  };
  const prune = () => {
    const keys = Object.keys(db.items);
    if (keys.length <= maxItems) return;
    keys.sort((a, b) => db.items[a].analyzedAt - db.items[b].analyzedAt);
    for (const k of keys.slice(0, keys.length - maxItems)) delete db.items[k];
  };
  return {
    getSettings: () => (db.settings && typeof db.settings === "object" ? { ...db.settings } : null),
    setSettings(obj) { db.settings = { ...obj }; save(); },
    getWatch: () => (Array.isArray(db.watch) ? [...db.watch] : null),
    setWatch(list) { db.watch = [...new Set(list)]; save(); },
    has: (key) => key in db.items,
    get: (key) => db.items[key] ?? null,
    put(item) { db.items[item.key] = item; prune(); save(); },
    list: (limit = 100) => Object.values(db.items).sort((a, b) => b.analyzedAt - a.analyzedAt).slice(0, limit),
    today: () => ({ requests: 0, input_tokens: 0, output_tokens: 0, ...(db.days[dayKey()] || {}) }),
    addUsage({ requests = 0, input_tokens = 0, output_tokens = 0 }) {
      const t = { requests: 0, input_tokens: 0, output_tokens: 0, ...(db.days[dayKey()] || {}) };
      db.days[dayKey()] = { requests: t.requests + requests, input_tokens: t.input_tokens + input_tokens, output_tokens: t.output_tokens + output_tokens };
      const days = Object.keys(db.days).sort();
      for (const d of days.slice(0, Math.max(0, days.length - 30))) delete db.days[d];
      save();
    },
  };
}
