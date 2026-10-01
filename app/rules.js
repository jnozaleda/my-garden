// Care rules: what's due for each plant, and how the forecast changes it.
// Pure functions over plain data, so the same file can run later in the daily push job.

export const CARE = {
  water: { label: "Regar", done: "Regado", icon: "💧" },
  feed: { label: "Abonar", done: "Abonado", icon: "🧪" },
  prune: { label: "Podar", done: "Podado", icon: "✂️" },
  treat: { label: "Tratar", done: "Tratado", icon: "🐞" },
  note: { label: "Nota", done: "Nota", icon: "📝" },
};

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
export function nextDue(plant, log, type, today, lat) {
  const every = intervalFor(plant, type, seasonOf(today, lat));
  if (!every) return null;
  const due = addDays(lastDone(log, plant.id, type) ?? plant.created, every);
  // Feeding resumes with the season: count from its first day, not from last year's feed.
  if (type === "feed") {
    const start = seasonStart(today, lat);
    if (due < start) return start;
  }
  return due;
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
  return tasks.sort((a, b) => a.days - b.days || a.plant.name.localeCompare(b.plant.name));
}

// Garden-wide alerts: frost, wind, heatwave. Each: { level: "warn"|"danger", icon, title, text }
export function weatherAlerts(plants, weather, today) {
  const o = outlook(weather);
  if (!o) return [];
  const alerts = [];
  const names = (list) => list.map((p) => p.name).join(", ");
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
