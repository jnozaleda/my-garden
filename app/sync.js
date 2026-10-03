// Garden sync through the Worker («clave del jardín»). Every plant and log entry carries `_at`, the
// time of its last change; deletions are kept as tombstones (`deleted: { id: time }`) so they reach
// the other phones. mergeGardens must stay identical to the copy in worker/src/worker.js.

export function mergeGardens(a, b) {
  if (!a) return b;
  if (!b) return a;
  const deleted = { ...(a.deleted ?? {}) };
  for (const [id, at] of Object.entries(b.deleted ?? {})) deleted[id] = Math.max(deleted[id] ?? 0, at);
  const merge = (x = [], y = []) => {
    const byId = new Map();
    for (const item of [...x, ...y]) {
      const prev = byId.get(item.id);
      if (!prev || (item._at ?? 0) > (prev._at ?? 0)) byId.set(item.id, item);
    }
    return [...byId.values()].filter((item) => !(deleted[item.id] >= (item._at ?? 0)));
  };
  const settings = (a.settingsAt ?? 0) >= (b.settingsAt ?? 0) ? a : b;
  return {
    plants: merge(a.plants, b.plants),
    log: merge(a.log, b.log),
    deleted,
    pausedZones: settings.pausedZones ?? [],
    settingsAt: settings.settingsAt ?? 0,
  };
}

// The part of the app's data that syncs (location and view choices stay per phone).
export const gardenDoc = (data) => ({
  plants: data.plants, log: data.log, deleted: data.deleted ?? {}, pausedZones: data.pausedZones ?? [], settingsAt: data.settingsAt ?? 0,
});

// Cheap content hash (without `_at`) to notice what changed since the last save.
function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i);
  return (h >>> 0).toString(36);
}
const itemHash = (item) => hash(JSON.stringify({ ...item, _at: undefined }));
export function hashesOf(data) {
  const out = { settings: hash(JSON.stringify(data.pausedZones ?? [])) };
  for (const item of [...data.plants, ...data.log]) out[item.id] = itemHash(item);
  return out;
}
// Marks what changed since `prev` (new or edited → `_at` now, gone → tombstone) and returns the new hashes.
export function stampChanges(data, prev) {
  const now = Date.now();
  const next = hashesOf(data);
  for (const item of [...data.plants, ...data.log]) if (prev[item.id] !== next[item.id] || item._at === undefined) item._at = now;
  data.deleted ??= {};
  for (const id of Object.keys(prev)) if (id !== "settings" && !(id in next)) data.deleted[id] = now;
  if (prev.settings !== next.settings) data.settingsAt = now;
  return next;
}
export const docHash = (doc) => hash(JSON.stringify(gardenDoc(doc)));
// Whether `local` has anything newer than `remote` (by `_at`, tombstones, settings): only then push.
// Content isn't compared, so fields the app derives on load (irrigationOff) can't cause a loop.
export function needsPush(local, remote) {
  const at = new Map([...(remote.plants ?? []), ...(remote.log ?? [])].map((i) => [i.id, i._at ?? 0]));
  if ([...local.plants, ...local.log].some((i) => !at.has(i.id) || (i._at ?? 0) > at.get(i.id))) return true;
  if (Object.entries(local.deleted ?? {}).some(([id, t]) => (remote.deleted?.[id] ?? 0) < t)) return true;
  return (local.settingsAt ?? 0) > (remote.settingsAt ?? 0);
}

// Keys: 16 characters without look-alikes (0/O, 1/I/L), shown as XXXX-XXXX-XXXX-XXXX.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}
export const formatKey = (key) => key.match(/.{1,4}/g).join("-");
export function parseKey(text) {
  const raw = String(text ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-Z0-9]{16}$/.test(raw) ? raw : null;
}

export async function fetchGarden(api, key) {
  const res = await fetch(`${api}/garden/${key}`, { signal: AbortSignal.timeout(20000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`sync ${res.status}`);
  return res.json();
}
export async function putGarden(api, key, doc, device) {
  const res = await fetch(`${api}/garden/${key}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Device": device },
    body: JSON.stringify(gardenDoc(doc)),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`sync ${res.status}`);
  return res.json();
}
