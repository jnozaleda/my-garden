// Care rules: what's due for each plant, and how the forecast changes it.
// Pure functions over plain data, so the same file can run later in the daily push job.

export const CARE = {
  water: { label: "Regar", done: "Regado", icon: "💧" },
  feed: { label: "Abonar", done: "Abonado", icon: "🧪" },
  prune: { label: "Podar", done: "Podado", icon: "✂️" },
  treat: { label: "Tratar", done: "Tratado", icon: "🐞" },
  note: { label: "Nota", done: "Nota", icon: "📝" },
  task: { label: "Tarea", done: "Tarea hecha", icon: "☑️" },
};

// ---------- Year calendar (checklist) ----------
// Each plant may carry `yearTasks` from the AI: [{ type, title, how, months: [1..12] }].
const monthOf = (iso) => Number(iso.slice(5, 7));
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// The run of consecutive months (wrapping the year) that contains today's month, as ISO dates;
// null if the task doesn't apply this month.
export function taskWindow(months, today) {
  const m = monthOf(today);
  if (!months.includes(m)) return null;
  const has = (k) => months.includes(((k - 1 + 12) % 12) + 1);
  let back = 0, fwd = 0;
  while (back < 11 && has(m - back - 1)) back++;
  while (fwd < 11 - back && has(m + fwd + 1)) fwd++;
  const y = Number(today.slice(0, 4));
  const sm = m - back, em = m + fwd;
  const sy = y + Math.floor((sm - 1) / 12), ey = y + Math.floor((em - 1) / 12);
  const smm = ((sm - 1 + 12) % 12) + 1, emm = ((em - 1 + 12) % 12) + 1;
  return { start: `${sy}-${pad(smm)}-01`, end: `${ey}-${pad(emm)}-${pad(lastDay(ey, emm))}`, lastMonth: fwd === 0, months: back + fwd + 1 };
}

// This month's year tasks for the given plants, with done = logged since the window opened.
// Each: { plant, i, task, window, done, ref }
export function monthTasks(plants, log, today) {
  const out = [];
  for (const plant of plants) {
    (plant.yearTasks ?? []).forEach((task, i) => {
      if (task.off) return; // «No aplica»: removed by the user
      if (task.matureOnly && plant.size === "small") return; // thinning fruit etc. doesn't apply to a small plant
      const window = taskWindow(task.months, today);
      if (!window) return;
      const ref = `${plant.id}:${i}`;
      const done = log.some((e) => e.type === "task" && e.ref === ref && e.date >= window.start);
      out.push({ plant, i, task, window, done, ref });
    });
  }
  return out.sort((a, b) => a.done - b.done || b.window.lastMonth - a.window.lastMonth || plantLabel(a.plant).localeCompare(plantLabel(b.plant)));
}

// Garden-wide jobs (clean, mulch, protect from cold) are done for every plant at once, so the
// week card shows one row per type with all its plants; one tick logs it on each. Pruning,
// repotting, treating and harvesting stay per plant.
export const GROUPED_TYPES = { clean: "Limpiar hojas secas y flores marchitas", mulch: "Acolchar", protect: "Proteger del frío" };
export function groupGardenTasks(items) {
  const out = [];
  const groups = {};
  for (const x of items) {
    const type = x.task.type;
    if (!GROUPED_TYPES[type]) { out.push({ members: [x], title: x.task.title, how: x.task.how, window: x.window, done: x.done }); continue; }
    if (!groups[type]) out.push(groups[type] = { members: [], how: x.task.how, type });
    groups[type].members.push(x);
  }
  for (const g of Object.values(groups)) {
    g.title = g.members.length > 1 ? GROUPED_TYPES[g.type] : g.members[0].task.title;
    g.done = g.members.every((m) => m.done);
    g.window = g.members.reduce((a, m) => (m.window.lastMonth < a.lastMonth ? m.window : a), g.members[0].window);
  }
  return out.sort((a, b) => a.done - b.done);
}

// ---------- Sun ----------
export const SUN_LABEL = { sun: "Sol", partial: "Media sombra", shade: "Sombra" };
export const SUN_NEED_LABEL = { sun: "pleno sol", partial: "media sombra", shade: "sombra" };
// The exposure a plant gets: its own choice, else its zone's («Sol de cada zona» in Ajustes).
export const exposureOf = (plant, zoneSun = {}) => plant.sun || zoneSun[plant.zone || ""] || null;
// How well an exposure suits what the plant asks for: "ok" | "warn" | "no" (null when unknown).
export function sunFit(need, sensitive, exposure) {
  if (!exposure) return null;
  if (sensitive) return { sun: "no", partial: "warn", shade: "ok" }[exposure];
  return ({ sun: { sun: "ok", partial: "warn", shade: "no" }, partial: { sun: "warn", partial: "ok", shade: "warn" }, shade: { sun: "no", partial: "warn", shade: "ok" } }[need ?? "sun"])[exposure];
}
// One line for the plant sheet when its light doesn't match, or null.
export function sunAdvice(plant, zoneSun = {}) {
  const exposure = exposureOf(plant, zoneSun);
  const fit = sunFit(plant.sunNeed, plant.sunSensitive, exposure);
  if (!fit || fit === "ok") return null;
  const asks = `${plant.sunSensitive ? "Es muy sensible al sol directo" : `Pide ${SUN_NEED_LABEL[plant.sunNeed ?? "sun"]}`}`;
  const move = plant.sunSensitive || plant.sunNeed === "shade" ? "sombra" : plant.sunNeed === "sun" ? "una zona más soleada" : "media sombra";
  return { level: fit, text: `${asks} y recibe ${SUN_LABEL[exposure].toLowerCase()}: mejor en ${move}.` };
}

// «Explorar»: how a plant (its care sheet from the AI) fits the user's garden.
// Returns { verdict: "good" | "mid" | "bad", headline, summary, rows: [{ kind, level, title, text }] }.
export function fitReport(care, plants, zoneSun, season, place) {
  const rows = [];
  const names = (list) => list.map(plantLabel).join(", ").replace(/, ([^,]*)$/, " y $1");
  const climate = [care.climateNote, care.minTemp != null ? `Aguanta hasta ${care.minTemp}°.` : ""].filter(Boolean).join(" ");
  rows.push({ kind: "climate", level: care.climateFit ?? "warn", title: "Clima", text: climate || (care.frostSensitive ? "Sufre con las heladas." : "Sin problemas de clima.") });
  const every = care.seasons?.[season]?.water;
  if (every) {
    const like = plants.filter((p) => { const e = intervalFor(p, "water", season); return e && Math.abs(e - every) <= 1; });
    rows.push({
      kind: "water", level: every <= 2 ? "warn" : "ok", title: "Agua",
      text: `${every <= 2 ? "Muy exigente: riego casi diario en maceta" : `Riego cada ${every} días`} en ${SEASON_LABEL[season].toLowerCase()}.${like.length ? ` Parecido a ${names(like.slice(0, 3))}.` : ""}`,
    });
  }
  const zones = [...new Set([...plants.map((p) => p.zone || ""), ...Object.keys(zoneSun)])].filter((z) => zoneSun[z]);
  const zoneName = (z) => z || "Sin zona";
  const fits = zones.map((z) => [z, sunFit(care.sunNeed, care.sunSensitive, zoneSun[z])]);
  const okZ = fits.filter(([, f]) => f === "ok").map(([z]) => zoneName(z));
  const warnZ = fits.filter(([, f]) => f === "warn").map(([z]) => zoneName(z));
  const noZ = fits.filter(([, f]) => f === "no").map(([z]) => zoneName(z));
  rows.push({
    kind: "sun", level: !zones.length ? "info" : okZ.length ? "ok" : warnZ.length ? "warn" : "no", title: "Sol",
    text: `Pide ${SUN_NEED_LABEL[care.sunNeed ?? "sun"]}${care.sunSensitive ? " y el sol directo le perjudica: mejor en sombra" : ""}.` +
      (okZ.length ? ` Encaja en ${okZ.join(", ")}.` : "") + (!okZ.length && warnZ.length ? ` Con reservas en ${warnZ.join(", ")}.` : "") +
      (noZ.length ? ` No encaja en ${noZ.join(", ")}.` : "") + (!zones.length ? " Indica el sol de tus zonas (Ajustes) para saber dónde encaja." : ""),
  });
  const genus = String(care.species ?? "").split(" ")[0].toLowerCase();
  const kin = genus ? plants.filter((p) => String(p.species ?? "").split(" ")[0].toLowerCase() === genus) : [];
  if (kin.length) rows.push({ kind: "similar", level: "ok", title: "Parecidas en tu jardín", text: `Ya tienes ${names(kin.slice(0, 3))}, de la misma familia.` });
  const bad = rows.find((r) => r.kind === "climate")?.level === "no";
  const concern = rows.find((r) => r.level === "warn" || r.level === "no");
  const verdict = bad ? "bad" : concern ? "mid" : "good";
  const where = place || "tu zona";
  return {
    verdict,
    headline: { good: `Encaja bien en ${where}`, mid: `Encaja con reservas en ${where}`, bad: `No es buena idea en ${where}` }[verdict],
    summary: concern ? concern.text : "No veo pegas con tu clima, tu luz ni lo que ya tienes.",
    rows,
  };
}

// Weather-driven checks for the week, beyond the alerts: rain spells (fungus, snails), cold
// nights above frost, heat for sun-sensitive plants. Each: { kind, title, text, plantIds }
export function weatherChecks(plants, weather, today) {
  if (!weather) return [];
  const { days, today: t } = weather;
  const recent = days.slice(Math.max(0, t - 2), t + 1);
  const week = days.slice(t, t + 7);
  const out = [];
  const names = (list) => list.map(plantLabel).join(", ").replace(/, ([^,]*)$/, " y $1");
  const wet = recent.reduce((sum, d) => sum + d.rain, 0) >= 15 || recent.filter((d) => d.rain >= 2).length >= 2;
  if (wet) {
    const fungus = plants.filter((p) => p.rainReaches && p.risks?.includes("fungus"));
    const snails = plants.filter((p) => p.rainReaches && p.risks?.includes("snails"));
    const hit = [...new Set([...fungus, ...snails])];
    if (hit.length) {
      const what = fungus.length && snails.length ? "hongos y caracoles" : fungus.length ? "hongos" : "caracoles y babosas";
      out.push({ kind: "rain", title: "Tras los días de lluvia", text: `Revisa ${what} en ${names(hit)}.`, plantIds: hit.map((p) => p.id) });
    }
  }
  const cold = week.find((d) => d.min <= 5 && d.min > LIMITS.frostC);
  const tender = plants.filter((p) => p.frostSensitive);
  if (cold && tender.length) {
    out.push({ kind: "cold", title: `Noches frías ${whenLabel(today, cold.date)} (${Math.round(cold.min)}°)`, text: `Ten a mano protección para ${names(tender)}.`, plantIds: tender.map((p) => p.id) });
  }
  const hot = week.find((d) => d.max >= LIMITS.heatC);
  const sunny = plants.filter((p) => p.risks?.includes("sunburn"));
  if (hot && sunny.length) {
    out.push({ kind: "heat", title: `Calor ${whenLabel(today, hot.date)} (${Math.round(hot.max)}°)`, text: `Da sombra en las horas centrales a ${names(sunny)}.`, plantIds: sunny.map((p) => p.id) });
  }
  // Automatic irrigation: tell when the timer could pause (rain reached them) or needs checking (heat).
  const auto = plants.filter(irrigated);
  const rainNext = days.slice(t + 1, t + 3).reduce((sum, d) => sum + d.rain, 0);
  const autoRain = auto.filter((p) => p.rainReaches);
  if (autoRain.length && (wet || rainNext >= LIMITS.rainSkipMm)) {
    const mm = Math.round(recent.reduce((sum, d) => sum + d.rain, 0) + rainNext);
    out.push({ kind: "rain", title: "Riego automático: puedes pausarlo", text: `Entre lo que ha llovido y lo que viene, unos ${mm} mm. ${names(autoRain).replace(/^./, (c) => c.toUpperCase())} ${autoRain.length === 1 ? "no necesita" : "no necesitan"} el riego estos días.`, plantIds: autoRain.map((p) => p.id) });
  }
  if (hot && auto.length) {
    out.push({ kind: "heat", title: `Calor: revisa el goteo (${Math.round(hot.max)}° ${whenLabel(today, hot.date)})`, text: `Comprueba que el riego automático llega bien a ${names(auto)} o añade un riego más.`, plantIds: auto.map((p) => p.id) });
  }
  return out;
}

// Thresholds (tunable once there's real use behind them).
export const LIMITS = { rainSkipMm: 5, rainProb: 60, heatC: 32, heatwaveC: 35, frostC: 2, gustKmh: 50 };

const DAY = 86400000;
export const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
export const addDays = (iso, n) => isoDay(new Date(iso + "T12:00:00Z").getTime() + n * DAY);
export const daysBetween = (a, b) => Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / DAY);

export function lastDone(log, plantId, type) {
  let last = null;
  for (const e of log) if (e.plantId === plantId && e.type === type && (!last || e.date > last)) last = e.date;
  return last;
}

// ---------- Seasons ----------
// Meteorological seasons (whole months: spring = March–May in the north), flipped south of the
// equator. Each plant keeps a water/feed interval per season; the one in force is today's.
export const SEASONS = ["spring", "summer", "autumn", "winter"];
export const SEASON_LABEL = { spring: "Primavera", summer: "Verano", autumn: "Otoño", winter: "Invierno" };
const pad = (n) => String(n).padStart(2, "0");

export function seasonOf(iso, lat) {
  const m = Number(iso.slice(5, 7));
  const north = lat < 0 ? ((m + 5) % 12) + 1 : m;
  return SEASONS[Math.floor(((north + 9) % 12) / 3)];
}

// First day of the season that contains `iso`.
export function seasonStart(iso, lat) {
  const season = seasonOf(iso, lat);
  let y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7));
  for (let i = 0; i < 2; i++) {
    const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y;
    if (seasonOf(`${py}-${pad(pm)}-01`, lat) !== season) break;
    m = pm; y = py;
  }
  return `${y}-${pad(m)}-01`;
}

export function nextSeasonStart(iso, lat) {
  const start = seasonStart(iso, lat);
  let y = Number(start.slice(0, 4)), m = Number(start.slice(5, 7)) + 3;
  if (m > 12) { m -= 12; y += 1; }
  return `${y}-${pad(m)}-01`;
}

// Plants saved before the seasonal sheet have one interval for the whole year.
export function intervalFor(plant, type, season) {
  const s = plant.seasons?.[season];
  if (s) return type === "water" ? s.water : s.feed;
  return type === "water" ? plant.waterEvery : plant.feedEvery;
}

// Next due date for a recurring care type in today's season, or null if it doesn't apply now
// (no interval, or feeding paused this season).
// What the user calls the plant: its own name (nick, e.g. «Limonero del patio») or its type.
export const plantLabel = (plant) => plant.nick || plant.name;

// Automatic irrigation running for this plant: it has it (autoWater) and its zone hasn't paused it.
export const irrigated = (plant) => Boolean(plant.autoWater && !plant.irrigationOff);

export function nextDue(plant, log, type, today, lat) {
  // Automatic irrigation waters it: no watering turns (weather checks speak to the timer instead).
  if (type === "water" && irrigated(plant)) return null;
  const every = intervalFor(plant, type, seasonOf(today, lat));
  if (!every) return null;
  // Irrigation just paused: the timer watered it until then, so count from the pause.
  const since = [lastDone(log, plant.id, type) ?? plant.created, type === "water" ? plant.irrigationOffSince : null].filter(Boolean).sort().pop();
  const due = addDays(since, every);
  // Feeding resumes with the season: count from its first day, not from last year's feed.
  if (type === "feed") {
    const start = seasonStart(today, lat);
    if (due < start) return start;
  }
  return due;
}

// Care due on each of the next `days` days (tomorrow onwards), following each season's interval.
// Something due today or overdue is assumed done today, so its next turn is counted from today.
// Returns [{ date, items: [{ plant, type }] }], one entry per day, empty days included.
export function upcomingTasks(plants, log, today, lat, days = 7) {
  const out = Array.from({ length: days }, (_, i) => ({ date: addDays(today, i + 1), items: [] }));
  const last = addDays(today, days);
  for (const plant of plants) {
    for (const type of ["water", "feed"]) {
      let due = nextDue(plant, log, type, today, lat);
      if (!due) continue;
      if (due <= today) {
        const every = intervalFor(plant, type, seasonOf(today, lat));
        due = every ? addDays(today, every) : null;
      }
      for (let guard = 0; due && due <= last && guard < 60; guard++) {
        out[daysBetween(today, due) - 1]?.items.push({ plant, type });
        const every = intervalFor(plant, type, seasonOf(due, lat));
        due = every ? addDays(due, every) : null;
      }
    }
  }
  for (const d of out) d.items.sort((a, b) => a.type.localeCompare(b.type) || plantLabel(a.plant).localeCompare(plantLabel(b.plant)));
  return out;
}

// Weather facts for the next few days, relative to today.
function outlook(weather) {
  if (!weather) return null;
  const { days, today } = weather;
  const at = (i) => days[today + i] ?? null;
  const next = (n) => days.slice(today, today + n);
  return {
    rainYesterday: at(-1)?.rain ?? 0,
    rainSoon: next(2).find((d) => d.rain >= LIMITS.rainSkipMm && d.rainProb >= LIMITS.rainProb) ?? null,
    heat: next(2).find((d) => d.max >= LIMITS.heatC) ?? null,
    heatwave: next(3).find((d) => d.max >= LIMITS.heatwaveC) ?? null,
    frost: next(3).find((d) => d.min <= LIMITS.frostC) ?? null,
    wind: next(2).find((d) => d.gust >= LIMITS.gustKmh) ?? null,
  };
}

// Tasks to show today: overdue or due within `horizon` days, adjusted for the weather.
// Each task: { plant, type, due, days (negative = overdue), advice?: { kind: "skip"|"urgent", text } }
export function dueTasks(plants, log, weather, today, lat, horizon = 2) {
  const o = outlook(weather);
  const tasks = [];
  for (const plant of plants) {
    for (const type of ["water", "feed"]) {
      const due = nextDue(plant, log, type, today, lat);
      if (!due) continue;
      let days = daysBetween(today, due);
      let advice = null;
      if (type === "water" && o) {
        if (plant.rainReaches && o.rainYesterday >= LIMITS.rainSkipMm) {
          advice = { kind: "skip", text: `Ayer cayeron ${Math.round(o.rainYesterday)} mm: puedes saltarte este riego` };
        } else if (plant.rainReaches && o.rainSoon) {
          advice = { kind: "skip", text: `Se esperan ${Math.round(o.rainSoon.rain)} mm ${whenLabel(today, o.rainSoon.date)}: espera a la lluvia` };
        } else if (o.heat && days <= 2) {
          advice = { kind: "urgent", text: `${Math.round(o.heat.max)}° ${whenLabel(today, o.heat.date)}: riega hoy, mejor al amanecer o al atardecer` };
          days = Math.min(days, 0);
        }
      }
      if (days <= horizon) tasks.push({ plant, type, due, days, advice });
    }
  }
  return tasks.sort((a, b) => a.days - b.days || plantLabel(a.plant).localeCompare(plantLabel(b.plant)));
}

// Garden-wide alerts: frost, wind, heatwave. Each: { level: "warn"|"danger", icon, title, text }
export function weatherAlerts(plants, weather, today) {
  const o = outlook(weather);
  if (!o) return [];
  const alerts = [];
  const names = (list) => list.map(plantLabel).join(", ");
  if (o.frost) {
    const sensitive = plants.filter((p) => p.frostSensitive);
    alerts.push({
      level: "danger", icon: "🥶", title: `Helada ${whenLabel(today, o.frost.date)} (${Math.round(o.frost.min)}°)`,
      text: sensitive.length ? `Protege o resguarda: ${names(sensitive)}.` : "Revisa las plantas más delicadas.",
    });
  }
  if (o.heatwave) {
    const pots = plants.filter((p) => p.inPot);
    alerts.push({
      level: "danger", icon: "🔥", title: `Calor extremo ${whenLabel(today, o.heatwave.date)} (${Math.round(o.heatwave.max)}°)`,
      text: `Riega temprano y da sombra en las horas centrales${pots.length ? `, sobre todo a las macetas: ${names(pots)}` : ""}.`,
    });
  }
  if (o.wind) {
    const pots = plants.filter((p) => p.inPot);
    alerts.push({
      level: "warn", icon: "💨", title: `Rachas de ${Math.round(o.wind.gust)} km/h ${whenLabel(today, o.wind.date)}`,
      text: pots.length ? `Asegura o baja al suelo: ${names(pots)}.` : "Asegura tutores y macetas altas.",
    });
  }
  return alerts;
}

function whenLabel(today, date) {
  const n = daysBetween(today, date);
  if (n === 0) return "hoy";
  if (n === 1) return "mañana";
  return "el " + new Date(date + "T12:00:00Z").toLocaleDateString("es-ES", { weekday: "long" });
}
