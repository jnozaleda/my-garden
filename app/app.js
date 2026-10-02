// Mi Jardín — plant inventory, care log and weather-aware reminders. Plain template strings,
// data in localStorage (phase 1: this device only). Actions are wired by data-action attributes.

import { fetchWeather, searchCities, weatherKind } from "./weather.js?v=20261002m";
import {
  CARE, SEASONS, SEASON_LABEL, dueTasks, upcomingTasks, monthTasks, weatherChecks, taskWindow, weatherAlerts, nextDue, daysBetween, intervalFor, seasonOf, nextSeasonStart,
} from "./rules.js?v=20261002m";
import { buildICS } from "./calendar.js?v=20261002m";

const DEFAULT_LOC = { name: "Madrid", lat: 40.4168, lon: -3.7038 };
// Backend (MiJardin/worker): fills a plant's care sheet with AI. Needs the access code from Ajustes.
const API = "https://my-garden-api.tempcheck-app.workers.dev";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const here = () => state.loc ?? DEFAULT_LOC;
const localToday = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

// ---------- Storage ----------
const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};

const state = {
  data: store.get("mj_data", { plants: [], log: [] }),
  loc: store.get("mj_loc", null),
  tab: store.get("mj_tab", "today"),
  weather: null,
  weatherError: false,
};

function save() {
  if (!store.set("mj_data", state.data)) alert("No se ha podido guardar: el almacenamiento del navegador está lleno. Prueba con fotos más pequeñas o exporta una copia.");
}

const plantById = (id) => state.data.plants.find((p) => p.id === id);

// ---------- Dates ----------
function fmtDate(iso, opts = { day: "numeric", month: "short" }) {
  return new Date(iso + "T12:00:00").toLocaleDateString("es-ES", opts);
}
// When a care task is due, relative to today (negative = late).
function relDue(n) {
  if (n === 0) return "Hoy";
  if (n === 1) return "Mañana";
  if (n > 1) return `En ${n} días`;
  return n === -1 ? "Atrasado 1 día" : `Atrasado ${-n} días`;
}

// ---------- Weather ----------
async function loadWeather() {
  state.weather = null; state.weatherError = false;
  render();
  try { state.weather = await fetchWeather(state.loc ?? DEFAULT_LOC); } catch { state.weatherError = true; }
  render();
}

// The weather card: today large, the next six days with a rain bar each, and the alerts (or a
// single calm line) underneath.
function forecastCard(alerts = []) {
  if (state.weatherError) return `<section class="card"><p class="muted">No se ha podido cargar la previsión.</p><div class="row" style="margin-top:10px"><button class="btn small secondary" data-action="retry-weather">Reintentar</button></div></section>`;
  if (!state.weather) return `<section class="card"><p class="muted">Cargando el tiempo…</p></section>`;
  const { days, today } = state.weather;
  const t = days[today];
  const k = weatherKind(t.code);
  const rainLine = t.rain >= 1 ? `${Math.round(t.rain)} mm de lluvia` : "sin lluvia";
  const next = days.slice(today + 1, today + 7).map((d) => {
    const w = weatherKind(d.code);
    const pct = Math.min(100, Math.round((d.rain / 20) * 100));
    return `<div class="wx-day"><span>${fmtDate(d.date, { weekday: "short" }).replace(".", "")}</span>${ICONS[w.kind]}<b>${Math.round(d.max)}°</b>
      <span class="wx-bar" aria-hidden="true"><span style="height:${pct}%"></span></span><span class="wx-mm">${d.rain >= 1 ? Math.round(d.rain) : ""}</span></div>`;
  }).join("");
  const alertRows = alerts.length
    ? alerts.map((a) => `<div class="wx-alert ${a.level}">${ICONS[a.kind] ?? ICONS.alert}<div><strong>${esc(a.title)}</strong><span>${esc(a.text)}</span></div></div>`).join("")
    : `<div class="wx-calm">${ICONS.circleCheck}Sin heladas, calor extremo ni viento fuerte</div>`;
  return `<section class="card wx">
    <div class="wx-now"><span class="wx-ico ${k.kind}">${ICONS[k.kind]}</span><span class="wx-temp">${Math.round(t.max)}°</span>
      <div class="wx-desc">${k.label}<small>Mín. ${Math.round(t.min)}° · ${rainLine}</small></div></div>
    <div class="wx-days">${next}</div>
    ${alertRows}
  </section>`;
}

// ---------- Views ----------
function thumb(plant, cls = "thumb") {
  return plant.photo ? `<img class="${cls}" src="${plant.photo}" alt="" />` : `<span class="${cls} placeholder">${ICONS.sprout}</span>`;
}

// Discreet traits on the plant list: water need this season as 1–3 drops (≤3 days much, ≤7 medium,
// more = little) and a snowflake for frost-sensitive plants.
function traits(p) {
  const every = intervalFor(p, "water", seasonOf(localToday(), here().lat));
  const level = !every ? 0 : every <= 3 ? 3 : every <= 7 ? 2 : 1;
  const drops = level ? `<span class="t-drops" aria-label="Riego ${["", "bajo", "medio", "alto"][level]}">${[1, 2, 3].map((i) => `<span class="${i <= level ? "on" : ""}">${ICONS.droplet}</span>`).join("")}</span>` : "";
  const frost = p.frostSensitive ? `<span class="t-frost" aria-label="Sensible a heladas">${ICONS.snow}</span>` : "";
  return drops || frost ? `<span class="traits">${drops}${frost}</span>` : "";
}

function emptyGarden() {
  return `<section class="card empty"><div class="big">${ICONS.sprout}</div><p class="muted">Aún no tienes plantas. Añade la primera y te diremos cuándo regarla, abonarla y cuándo el tiempo cambia el plan.</p><button class="btn" data-action="new-plant">Añadir planta</button></section>`;
}

function todayView() {
  const today = localToday();
  const { plants, log } = state.data;
  const alerts = state.weather ? weatherAlerts(plants, state.weather, today).map((a) => ({ ...a, kind: ALERT_ICON[a.icon] })) : [];
  let html = upgradeBanner() + forecastCard(alerts);
  if (!plants.length) return html + emptyGarden();

  // Para hoy: overdue and due today (tomorrow onwards lives in «Próximos días»).
  const tasks = dueTasks(plants, log, state.weather, today, here().lat, 0);
  const rows = tasks.map((t) => `
    <div class="t-row">
      <span class="t-ico ${t.type}">${ICONS[TASK_ICON[t.type]]}</span>
      <div class="body">
        <div class="t-title">${CARE[t.type].label} ${esc(t.plant.name)}</div>
        ${t.type === "feed" && t.plant.feedTypes?.[seasonOf(today, here().lat)] ? `<div class="feed-type">${esc(t.plant.feedTypes[seasonOf(today, here().lat)])}</div>` : ""}
        <div class="t-when ${t.days < 0 ? "late" : ""}">${[t.days < 0 ? relDue(t.days) : "", t.plant.zone].filter(Boolean).map(esc).join(" · ") || "Hoy"}</div>
        ${t.advice ? `<div class="t-advice ${t.advice.kind}">${esc(t.advice.text)}${t.advice.kind === "skip" ? ` · <button type="button" class="link-inline" data-action="skip-rain" data-id="${t.plant.id}">Saltar</button>` : ""}</div>` : ""}
      </div>
      <button type="button" class="t-check" data-action="log" data-type="${t.type}" data-id="${t.plant.id}" aria-label="Marcar como hecho: ${CARE[t.type].label} ${esc(t.plant.name)}">${ICONS.check}</button>
    </div>`).join("");
  const upcoming = upcomingTasks(plants, log, today, here().lat, 7);
  const firstNext = upcoming.find((d) => d.items.length);
  const empty = `<div class="t-empty"><span class="badge">${ICONS.check}</span><div><b>Nada pendiente hoy</b><span>${firstNext
    ? `Próxima tarea ${dayPhrase(firstNext.date, today)}: ${CARE[firstNext.items[0].type].label.toLowerCase()} ${esc(firstNext.items[0].plant.name)}`
    : "Sin tareas en los próximos 7 días"}</span></div></div>`;
  html += tasks.length
    ? `<section class="card"><div class="sec">Para hoy <span class="meta">${tasks.length}</span></div>${rows}</section>`
    : `<section class="card">${empty}</section>`;
  return html + doneTodayCard(today) + gardenWeekCard(today) + upcomingCard(today, upcoming);
}

const TASK_ICON = { water: "droplet", feed: "flask" };
const YEAR_TYPE = {
  prune: ["scissors", "Poda"], repot: ["sprout", "Trasplante"], treat: ["bug", "Tratamiento"], mulch: ["shovel", "Acolchado"],
  protect: ["snow", "Frío"], clean: ["leaf", "Limpieza"], harvest: ["leaf", "Cosecha"], other: ["check", "Otros"],
};
const MONTH_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const WX_ICON = { rain: "cloud-rain", cold: "snow", heat: "flame" };

// When a year task is due: the last month of its window says «Hasta el 31 oct»; otherwise the range.
function windowLabel(w) {
  return w.lastMonth
    ? `<span class="yt-when soon">${ICONS.clock}Hasta el ${fmtDate(w.end, { day: "numeric", month: "short" })}</span>`
    : `<span class="yt-when">${ICONS.calendar}${MONTH_SHORT[Number(w.start.slice(5, 7)) - 1]} – ${MONTH_SHORT[Number(w.end.slice(5, 7)) - 1]}</span>`;
}

// «Esta semana en el jardín»: weather checks with plant names, then this month's tasks for all plants.
let weekAll = false;
// Garden-wide jobs (clean, mulch, protect from cold) are done for every plant at once, so the
// week card shows one row per type with all its plants; one tick logs it on each. Pruning,
// repotting, treating and harvesting stay per plant.
const GROUPED_TYPES = { clean: "Limpiar hojas secas y flores marchitas", mulch: "Acolchar", protect: "Proteger del frío" };
function groupGardenTasks(items) {
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

// Ticks a grouped row: if every plant has it done, undo all; otherwise log it on those missing.
function toggleTasks(refs) {
  const today = localToday();
  const items = refs.map((ref) => {
    const [id, i] = ref.split(":");
    const p = plantById(id);
    const task = p?.yearTasks?.[+i];
    const w = task && taskWindow(task.months, today);
    return task && w && { p, task, ref, logs: state.data.log.filter((e) => e.type === "task" && e.ref === ref && e.date >= w.start) };
  }).filter(Boolean);
  if (items.every((x) => x.logs.length)) {
    const drop = new Set(items.flatMap((x) => x.logs));
    state.data.log = state.data.log.filter((e) => !drop.has(e));
  } else {
    const time = new Date().toTimeString().slice(0, 5);
    for (const x of items.filter((x) => !x.logs.length)) state.data.log.push({ id: uid(), plantId: x.p.id, type: "task", ref: x.ref, date: today, time, note: x.task.title });
    track("task_done");
  }
  save();
  render();
}

function gardenWeekCard(today) {
  const { plants, log } = state.data;
  const checks = weatherChecks(plants, state.weather, today);
  const items = groupGardenTasks(monthTasks(plants, log, today));
  if (!checks.length && !items.length) return "";
  const done = items.filter((x) => x.done).length;
  const shown = weekAll ? items : items.slice(0, 5);
  return `<section class="card">
    <div class="sec">Esta semana en el jardín ${items.length ? `<span class="meta">${done} de ${items.length}</span>` : ""}</div>
    ${items.length ? `<div class="progress"><span style="width:${Math.round((done / items.length) * 100)}%"></span></div>` : ""}
    ${checks.map((c) => `<div class="wx-flag">${ICONS[WX_ICON[c.kind]]}<div><b>${esc(c.title)}</b><span>${esc(c.text)}</span></div></div>`).join("")}
    ${shown.map((x) => `<div class="yt-row ${x.done ? "done" : ""}">
      <button type="button" class="yt-box" data-action="task-toggle" data-refs="${x.members.map((m) => m.ref).join(",")}" aria-pressed="${x.done}" aria-label="${x.done ? "Desmarcar" : "Marcar como hecha"}: ${esc(x.title)}">${ICONS.check}</button>
      <div class="body"><b>${esc(x.title)}</b><div class="yt-how">${esc(x.how)}</div>
        <div class="yt-meta">${x.members.map((m) => `<button type="button" class="yt-plant" data-action="open-plant" data-id="${m.plant.id}">${ICONS.sprout}${esc(m.plant.name)}</button>`).join("")}${x.members.length > 1 ? `<span class="yt-when">${x.members.length} plantas</span>` : ""}${x.done ? "" : windowLabel(x.window)}</div></div>
    </div>`).join("")}
    ${items.length > 5 ? `<button type="button" class="link-btn" data-action="toggle-week-tasks">${weekAll ? "Ver menos" : `Ver las ${items.length}`}</button>` : ""}
  </section>`;
}

// Ficha: «Este mes» (this plant's tasks + weather checks that name it) and the 12-month calendar.
function plantMonthCard(p, today) {
  const items = monthTasks([p], state.data.log, today);
  const checks = weatherChecks(state.data.plants, state.weather, today).filter((c) => c.plantIds.includes(p.id));
  if (calendarPending.has(p.id)) {
    return `<section class="card"><div class="sec">Este mes</div><div class="ai-step"><span class="spinner" aria-hidden="true"></span>Preparando el calendario del año…</div></section>`;
  }
  if (!items.length && !checks.length) return "";
  const month = fmtDate(today, { month: "long" });
  return `<section class="card"><div class="sec">Este mes · ${month}${p.yearTasks?.length ? ` <span class="ai-mark">✦</span>` : ""}</div>
    ${items.map((x) => `<div class="yt-row right ${x.done ? "done" : ""}">
      <span class="yt-kind ${x.task.type}">${ICONS[YEAR_TYPE[x.task.type]?.[0] ?? "check"]}</span>
      <div class="body"><b>${esc(x.task.title)}</b><div class="yt-how">${esc(x.task.how)}</div>${x.done ? "" : `<div class="yt-meta">${windowLabel(x.window)}</div>`}</div>
      <button type="button" class="yt-box" data-action="task-toggle" data-id="${p.id}" data-i="${x.i}" data-reopen="1" aria-pressed="${x.done}" aria-label="${x.done ? "Desmarcar" : "Marcar como hecha"}: ${esc(x.task.title)}">${ICONS.check}</button>
    </div>`).join("")}
    ${checks.map((c) => `<div class="yt-row right"><span class="yt-kind weather">${ICONS[WX_ICON[c.kind]]}</span><div class="body"><b>${esc(c.title)}</b><div class="yt-how">${esc(c.text)}</div><div class="yt-meta"><span class="yt-when wx">${ICONS.cloud}Por el tiempo</span></div></div></div>`).join("")}
  </section>`;
}

function yearCalendarCard(p, today) {
  const rows = [];
  // Feeding comes from the season table; the rest from the AI's year tasks, one row per type.
  const feedMonths = p.seasons ? [...Array(12).keys()].map((i) => i + 1).filter((m) => intervalFor(p, "feed", seasonOf(`2026-${String(m).padStart(2, "0")}-15`, here().lat))) : [];
  if (feedMonths.length) rows.push(["flask", "Abonado", "feed", feedMonths]);
  const byType = {};
  for (const t of p.yearTasks ?? []) (byType[t.type] ??= new Set()), t.months.forEach((m) => byType[t.type].add(m));
  for (const [type, months] of Object.entries(byType)) rows.push([YEAR_TYPE[type]?.[0] ?? "check", YEAR_TYPE[type]?.[1] ?? "Otros", type, [...months]]);
  if (rows.length < 2) return "";
  const now = Number(today.slice(5, 7));
  return `<section class="card"><div class="sec">Calendario del año${p.yearTasks?.length ? ` <span class="ai-mark">✦</span>` : ""}</div>
    <div class="year"><span></span>${"EFMAMJJASOND".split("").map((m, i) => `<span class="ym ${i + 1 === now ? "now" : ""}">${m}</span>`).join("")}
    ${rows.map(([icon, label, cls, months]) => `<span class="yr">${ICONS[icon]}${label}</span>` +
      [...Array(12).keys()].map((i) => `<span class="yc ${months.includes(i + 1) ? `on ${cls}` : ""} ${i + 1 === now ? "now" : ""}"></span>`).join("")).join("")}
    </div></section>`;
}
const ALERT_ICON = { "🥶": "snow", "🔥": "flame", "💨": "wind" };
// "mañana", "el martes"
const dayPhrase = (iso, today) => daysBetween(today, iso) === 1 ? "mañana" : `el ${fmtDate(iso, { weekday: "long" })}`;

// «Hecho hoy»: what was logged today, folded into one line; each entry can be undone.
let doneOpen = false;
function doneTodayCard(today) {
  const done = state.data.log.filter((e) => e.date === today && e.type !== "note").reverse();
  if (!done.length) return "";
  const rows = done.map((e) => {
    const p = plantById(e.plantId);
    const what = e.type === "water" && e.note === "Lluvia" ? `${esc(p?.name ?? "")} · saltado por lluvia`
      : e.type === "task" ? `${esc(e.note)} · ${esc(p?.name ?? "")}`
        : `${CARE[e.type]?.label ?? e.type} ${esc(p?.name ?? "")}`;
    return `<div class="done-row"><span class="tick">${ICONS.check}</span><s>${what}</s>${e.time ? `<span class="time">${e.time}</span>` : ""}<button type="button" class="undo" data-action="undo-log" data-log="${e.id}">Deshacer</button></div>`;
  }).join("");
  return `<section class="card done-card ${doneOpen ? "open" : ""}">
    <button type="button" class="fold" data-action="toggle-done" aria-expanded="${doneOpen}"><span>Hecho hoy</span><span class="meta">${done.length} <span class="chev">›</span></span></button>
    ${doneOpen ? `<div class="done-list">${rows}</div>` : ""}</section>`;
}

// «Próximos días»: the next 7 days, 3 at first; rain or heat in the forecast is noted on its day.
let weekOpen = false;
function upcomingCard(today, days) {
  const forecast = Object.fromEntries((state.weather?.days ?? []).map((d) => [d.date, d]));
  const busy = days.filter((d) => d.items.length);
  const label = (iso) => daysBetween(today, iso) === 1 ? "Mañana" : fmtDate(iso, { weekday: "long" }).replace(/^./, (c) => c.toUpperCase());
  const shown = weekOpen ? busy : busy.slice(0, 3);
  const rows = shown.map(({ date, items }) => {
    const f = forecast[date];
    // Only the plants the rain reaches can skip their watering.
    const watering = items.filter((x) => x.type === "water");
    const rainy = watering.filter((x) => x.plant.rainReaches).map((x) => x.plant.name);
    const note = f && rainy.length && f.rain >= 5 && f.rainProb >= 60
      ? `<span class="day-wx">${ICONS["cloud-rain"]}${Math.round(f.rain)} mm previstos: ${rainy.length === watering.length ? "probablemente no haga falta regar" : `${esc(rainy.join(", "))} quizá no necesite${rainy.length > 1 ? "n" : ""} riego`}</span>`
      : f && watering.length && f.max >= 32 ? `<span class="day-wx hot">${ICONS.flame}${Math.round(f.max)}°: riega temprano</span>` : "";
    return `<div class="day-row"><div class="day-name">${label(date)}<small>${fmtDate(date)}</small></div><div class="day-items">
      ${items.map((x) => `<button type="button" class="day-chip ${x.type}" data-action="open-plant" data-id="${x.plant.id}">${ICONS[TASK_ICON[x.type]]}${esc(x.plant.name)}</button>`).join("")}
      ${note}</div></div>`;
  }).join("");
  const gap = busy.length && busy[0].date !== days[0].date ? `<div class="day-gap">Sin tareas hasta ${dayPhrase(busy[0].date, today).replace(/^el /, "el ")}</div>` : "";
  const body = busy.length ? gap + rows : `<div class="day-gap">Sin tareas en los próximos 7 días</div>`;
  return `<section class="card"><div class="sec">Próximos días <span class="meta">7 días</span></div>${body}
    ${busy.length > 3 ? `<button type="button" class="link-btn" data-action="toggle-week">${weekOpen ? "Ver menos" : "Ver la semana"}</button>` : ""}</section>`;
}

function plantsView() {
  const { plants, log } = state.data;
  if (!plants.length) return emptyGarden();
  const today = localToday();
  const zones = [...new Set(plants.map((p) => p.zone || "Sin zona"))].sort((a, b) => a.localeCompare(b, "es"));
  let html = "";
  for (const zone of zones) {
    const list = plants.filter((p) => (p.zone || "Sin zona") === zone).sort((a, b) => a.name.localeCompare(b.name, "es"));
    const autoZone = list.every((p) => p.autoWater);
    html += `<div class="zone-title">${esc(zone)} · ${list.length}${autoZone ? `<span class="zone-auto">${ICONS.drip}Riego automático</span>` : ""}</div><section class="card list-card">` + list.map((p) => {
      // Next watering, coloured: late (red), today (blue), later (grey).
      const due = nextDue(p, log, "water", today, here().lat);
      const n = due ? daysBetween(today, due) : null;
      const status = p.autoWater ? `<span class="p-status auto">${ICONS.drip}Riego automático</span>` : n === null ? "" : n < 0
        ? `<span class="p-status late">${ICONS.droplet}Regar · atrasado ${-n === 1 ? "1 día" : `${-n} días`}</span>`
        : n === 0 ? `<span class="p-status today">${ICONS.droplet}Regar hoy</span>`
          : `<span class="p-status">${ICONS.droplet}Regar ${n === 1 ? "mañana" : `en ${n} días`}</span>`;
      return `<button class="p-row" data-action="open-plant" data-id="${p.id}">${thumb(p, "thumb p-thumb")}<div class="body"><div class="p-name">${esc(p.name)}</div>${p.species ? `<div class="p-sp">${esc(p.species)}</div>` : ""}${status}</div>${traits(p)}<span class="chev">${ICONS.chevron}</span></button>`;
    }).join("") + `</section>`;
  }
  return html;
}

// Automatic irrigation: per plant (plant.autoWater) and per zone (state.data.autoZones). Turning a
// zone on/off sets every plant in it, and new plants added to that zone start with it on.
const autoZones = () => state.data.autoZones ?? [];
function zonesCard() {
  const zones = [...new Set(state.data.plants.map((p) => p.zone).filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));
  if (!zones.length) return "";
  return `<div class="group-title">Riego automático por zona</div>
    <section class="card list-card settings">${zones.map((z) => {
      const n = state.data.plants.filter((p) => p.zone === z).length;
      const on = autoZones().includes(z);
      return `<button type="button" class="l-row switch-row" role="switch" aria-checked="${on}" data-action="zone-auto" data-zone="${esc(z)}"><span class="l-ico" style="background:#1f8f86">${ICONS.drip}</span><span class="l-label">${esc(z)} <span class="muted">· ${n === 1 ? "1 planta" : `${n} plantas`}</span></span><span class="switch" aria-hidden="true"></span></button>`;
    }).join("")}</section>
    <p class="group-foot">Activar una zona lo activa en todas sus plantas y en las nuevas que pongas ahí; también se puede cambiar planta a planta en Editar. Esas plantas no te pedirán riego: te avisaremos si la lluvia o el calor piden tocar el programador.</p>`;
}
// The next season's interval, so the timer can be changed in time.
function autoHint(p, season) {
  const next = SEASONS[(SEASONS.indexOf(season) + 1) % 4];
  const every = intervalFor(p, "water", next);
  return every ? ` · en ${SEASON_LABEL[next].toLowerCase()}, cada ${every}` : "";
}

function moreView() {
  const loc = state.loc ?? DEFAULT_LOC;
  const aiOn = aiOpen === true || (aiCode() && codeStatus?.kind !== "warn");
  const pending = pendingUpgrades().length;
  const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const row = (action, icon, color, label, value = "", chevron = true, disabled = false) =>
    `<button type="button" class="l-row" data-action="${action}" ${disabled ? "disabled" : ""}><span class="l-ico" style="background:${color}">${ICONS[icon]}</span><span class="l-label">${label}</span><span class="l-value">${value}${chevron ? `<span class="chev">${ICONS.chevron}</span>` : ""}</span></button>`;
  return `
    <div class="group-title">General</div>
    <section class="card list-card settings">
      ${row("open-place", "pin", "#3b82f6", "Ubicación", esc(loc.name))}
      ${row("open-ai", "sparkle", "#7a56d6", "Asistente IA", aiOn ? `<span class="ok">${ICONS.circleCheck}Activado</span>` : "Sin activar")}
      ${pending || upgrade ? row("open-upgrades", "refresh", "#c7771a", "Fichas por actualizar", pending ? `<span class="dot"></span>${pending}` : "Al día") : ""}
    </section>
    ${zonesCard()}
    <div class="group-title">Avisos y calendario</div>
    <section class="card list-card settings">
      ${row("noop", "bell", "#c93b30", "Aviso diario", "Próximamente", false)}
      ${row("export-ics", "calendar", "#2f8f4e", "Exportar al calendario", "", true, !state.data.plants.length)}
    </section>
    <p class="group-foot">${isStandalone ? "" : "Para recibir avisos en el iPhone, instala la app: Compartir → «Añadir a pantalla de inicio». "}Los riegos y abonados se añaden a tu calendario como eventos que se repiten por estación; si cambias algo, vuelve a exportarlo.</p>
    ${aiCode() ? `<div class="group-title">Solo para ti</div>
    <section class="card list-card settings">${row("open-usage", "chart", "#2f8f4e", "Uso de la app")}</section>
    <p class="group-foot">Solo aparece en el móvil con tu código de acceso.</p>` : ""}
    <div class="group-title">Datos</div>
    <section class="card list-card settings">
      ${row("export-json", "download", "#6e6e73", "Exportar copia")}
      ${row("import-json", "upload", "#6e6e73", "Importar copia")}
    </section>
    <p class="group-foot">Tus plantas se guardan solo en este móvil. Exporta una copia de vez en cuando.</p>
    <input type="file" id="importFile" accept="application/json" hidden />`;
}

// Sheets opened from Ajustes. They redraw on render() while open (saving the code, upgrade progress).
function aiSheet() {
  openSheet(`
    <div class="sheet-head"><h2>Asistente IA</h2><button class="btn small secondary" data-action="close">Cerrar</button></div>
    <p class="muted">Al añadir una planta, la IA propone sola sus cuidados por estación para tu zona; también puedes pedírselo desde Editar.${aiOpen ? " Ahora mismo está abierta: no hace falta código." : " Necesita tu código de acceso."}</p>
    ${aiOpen ? "" : `<form id="aiCodeForm" class="row">
      <input type="text" name="code" class="code-input" placeholder="Código de acceso" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(store.get("mj_ai_code", ""))}" />
      <button class="btn small" type="submit">Guardar</button>
    </form>`}
    ${codeStatus ? `<p class="ai-status ${codeStatus.kind}">${esc(codeStatus.text)}</p>` : ""}`, "ai");
}
function upgradesSheet() {
  openSheet(`
    <div class="sheet-head"><h2>Fichas por actualizar</h2><button class="btn small secondary" data-action="close">Cerrar</button></div>
    ${upgradesCard() || `<p class="muted">Todas tus fichas están al día.</p>`}`, "upgrades");
}
// «Uso de la app»: 30 days of anonymous counts from the Worker (needs the access code).
let usage = null; // null = loading · { error } · { days }
async function loadUsage() {
  try {
    const res = await fetch(`${API}/stats?days=30`, { headers: aiHeaders() });
    usage = res.ok ? await res.json() : { error: res.status === 401 ? "code" : "ai" };
  } catch { usage = { error: "network" }; }
  if (sheet.open && sheet.dataset.view === "usage") usageSheet();
}
function usageSheet() {
  const head = `<div class="sheet-head"><h2>Uso de la app</h2><button class="btn small secondary" data-action="close">Cerrar</button></div>`;
  if (!usage) return openSheet(`${head}<div class="ai-step"><span class="spinner" aria-hidden="true"></span>Cargando…</div>`, "usage");
  if (usage.error) return openSheet(`${head}<p class="ai-status warn">${usage.error === "code" ? "El código guardado no es válido para ver el uso." : "No se ha podido cargar el uso. Prueba más tarde."}</p>`, "usage");
  const days = usage.days;
  const devicesIn = (n) => new Set(days.slice(-n).flatMap((d) => d.d)).size;
  const sum = (key, n = 30) => days.slice(-n).reduce((a, d) => a + (d.e[key] ?? 0), 0);
  const ai = days.reduce((a, d) => ({ calls: a.calls + d.ai.calls, cached: a.cached + d.ai.cached, errors: a.errors + d.ai.errors, notPlant: a.notPlant + d.ai.notPlant, ms: a.ms + d.ai.ms }), { calls: 0, cached: 0, errors: 0, notPlant: 0, ms: 0 });
  const opens = days.map((d) => d.e.app_open ?? 0);
  const max = Math.max(4, ...opens);
  const bars = days.map((d, i) => {
    const label = `${fmtDate(d.date, { weekday: "short", day: "numeric", month: "short" })} · ${opens[i]} ${opens[i] === 1 ? "apertura" : "aperturas"}`;
    return `<span class="u-bar ${opens[i] ? "" : "zero"}" style="height:${Math.max(3, (opens[i] / max) * 100)}%" tabindex="0" title="${esc(label)}" aria-label="${esc(label)}"></span>`;
  }).join("");
  const total = ai.calls + ai.cached;
  const row = (icon, label, n, small = "") => `<div class="u-row">${ICONS[icon]}<span>${label}</span><b>${n}${small ? `<small>${small}</small>` : ""}</b></div>`;
  openSheet(`${head}
    <section class="card"><div class="sec">Dispositivos activos</div>
      <div class="u-tiles"><div><span>Hoy</span><b>${devicesIn(1)}</b></div><div><span>7 días</span><b>${devicesIn(7)}</b></div><div><span>30 días</span><b>${devicesIn(30)}</b></div></div></section>
    <section class="card"><div class="sec">Aperturas por día <span class="meta">30 días · ${opens.reduce((a, b) => a + b, 0)}</span></div>
      <div class="u-chart" role="img" aria-label="Aperturas por día en los últimos 30 días">${bars}</div>
      <div class="u-axis"><span>${fmtDate(days[0].date)}</span><span>hoy</span></div>
      <div class="u-tip" id="usageTip" aria-live="polite"></div></section>
    <section class="card"><div class="sec">Qué se hace <span class="meta">30 días</span></div>
      ${row("sprout", "Plantas añadidas", sum("plant_add_ai") + sum("plant_add_manual"), `${sum("plant_add_ai")} con IA · ${sum("plant_add_manual")} a mano`)}
      ${row("droplet", "Riegos marcados", sum("water_done") + sum("water_skip_rain"), sum("water_skip_rain") ? `${sum("water_skip_rain")} saltados por lluvia` : "")}
      ${row("flask", "Abonos marcados", sum("feed_done"))}
      ${row("check", "Tareas del checklist", sum("task_done"))}
      ${row("refresh", "Fichas actualizadas", sum("upgrade_done"))}</section>
    <section class="card"><div class="sec">Inteligencia artificial <span class="meta ai-mark">✦ 30 días</span></div>
      ${row("sparkle", "Consultas", total)}
      ${row("database", "Desde la memoria (gratis)", ai.cached, total ? `${Math.round((ai.cached / total) * 100)} %` : "")}
      ${row("clock", "Tiempo medio de respuesta", ai.calls ? `${Math.round(ai.ms / ai.calls / 1000)} s` : "—")}
      ${row("alert", "Errores", ai.errors + ai.notPlant, ai.notPlant ? `${ai.notPlant} «no es una planta»` : "")}</section>
    <p class="group-foot">Recuentos anónimos: sin nombres de plantas, notas, ubicación ni datos personales. Cada instalación cuenta como un dispositivo. Los datos empiezan el 2 de octubre de 2026.</p>`, "usage");
}
// Tap or hover a bar to read its day.
document.addEventListener("pointerover", (e) => { const b = e.target.closest?.(".u-bar"); if (b && $("usageTip")) $("usageTip").textContent = b.getAttribute("aria-label"); });
document.addEventListener("focusin", (e) => { const b = e.target.closest?.(".u-bar"); if (b && $("usageTip")) $("usageTip").textContent = b.getAttribute("aria-label"); });

const SHEET_VIEWS = { ai: aiSheet, upgrades: upgradesSheet, usage: usageSheet };

// ---------- Care sheet upgrades ----------
// When an improvement needs new data from the AI, it gets a version and an entry here. Plants
// whose sheet is older are offered "Actualizar fichas" in Ajustes, which fills only the new parts.
const UPGRADES = [
  {
    version: 1,
    label: "pauta de riego y abono por estación",
    // Keeps a season table the user already shaped; replaces a missing or flat (all-year) one.
    apply: (plant, care) => { if (!hasSeasonalCare(plant)) plant.seasons = care.seasons; },
  },
  {
    version: 2,
    label: "marcas ✦ de lo que propuso la IA",
    // Only records the AI's proposal as a reference: no value changes. Fields that still match it get ✦.
    // `retro`: asked after the fact, so differences aren't necessarily the user's edits.
    apply: (plant, care) => { if (!plant.ai) plant.ai = { ...aiSnapshot(care), retro: true }; },
  },
  {
    version: 3,
    label: "consejos por estación y notas para todo el año",
    // Adds the four seasonal tips. The notes are renewed when they're the AI's or of unknown origin
    // (plants from before provenance); notes the user rewrote are kept. Replaced notes go to the
    // plant's history as a note, so nothing is lost.
    apply: (plant, care) => {
      plant.tips = care.tips;
      const old = (plant.notes ?? "").trim();
      const userWrote = plant.ai && !plant.ai.retro && !isAiValue(plant, "notes");
      if (old && old !== care.notes && !userWrote) {
        state.data.log.push({ id: uid(), plantId: plant.id, type: "note", date: localToday(), time: new Date().toTimeString().slice(0, 5), note: `Notas anteriores: ${old}` });
      }
      if (!old || !userWrote) {
        plant.notes = care.notes;
        if (plant.ai) plant.ai.values.notes = care.notes;
      }
    },
  },
  {
    version: 5,
    label: "tipo de abono según la estación",
    apply: (plant, care) => { plant.feedTypes = care.feedTypes; },
  },
  {
    version: 4,
    label: "calendario de cuidados del año",
    source: "calendar",
    apply: (plant, cal) => { plant.yearTasks = cal.tasks ?? []; plant.risks = cal.risks ?? []; },
  },
];
const CARE_VERSION = Math.max(...UPGRADES.map((u) => u.version));
const hasSeasonalCare = (p) => Boolean(p.seasons) && new Set(SEASONS.map((k) => `${p.seasons[k].water}/${p.seasons[k].feed}`)).size > 1;
// Plants from before versioning: a varied season table means version 1; a stored AI proposal, version 2.
const careVersionOf = (p) => Math.max(p.careVersion ?? (hasSeasonalCare(p) ? 1 : 0), p.ai ? 2 : 0);
const missingUpgrades = (p) => UPGRADES.filter((u) => u.version > careVersionOf(p));

let upgrade = null; // progress of the current "Actualizar fichas" run
const pendingUpgrades = () => state.data.plants.filter((p) => missingUpgrades(p).length);
const upgradeLabels = (pending) => [...new Set(pending.flatMap((p) => missingUpgrades(p).map((u) => u.label)))];

function upgradeStatus() {
  if (!upgrade) return "";
  if (upgrade.running) return `<p class="ai-status"><span class="spinner" aria-hidden="true"></span> Actualizando ${upgrade.done + 1} de ${upgrade.total}…</p>`;
  const ok = upgrade.done - upgrade.failed;
  return `<p class="ai-status ${upgrade.failed || upgrade.stopped ? "warn" : "ok"}">${esc(upgrade.stopped ?? `✅ ${ok} ${ok === 1 ? "ficha actualizada" : "fichas actualizadas"}. Revisa los datos de cada planta.${upgrade.failed ? ` ${upgrade.failed} no se pudieron actualizar; prueba más tarde.` : ""}`)}</p>`;
}

// Top of Hoy: the same offer, compact. «Más tarde» hides it until a newer improvement arrives;
// the Ajustes card and the dot on its tab stay meanwhile.
function upgradeBanner() {
  const pending = pendingUpgrades();
  const dismissed = store.get("mj_upgrade_later", 0) >= CARE_VERSION;
  if (upgrade && !upgrade.running && !upgrade.shownOnToday) return "";
  if (!upgrade && (!pending.length || dismissed)) return "";
  return `<section class="card upgrade-banner">
    ${pending.length && !upgrade?.running ? `<p><strong><span class="ai-mark">✦</span> ${pending.length === 1 ? "1 ficha tiene" : `${pending.length} fichas tienen`} mejoras nuevas</strong> <span class="muted">(${esc(upgradeLabels(pending).join(", "))})</span></p>
    <div class="row"><button class="btn small" data-action="upgrade-plants">Actualizar</button><button class="btn small secondary" data-action="upgrade-later">Más tarde</button></div>` : ""}
    ${upgradeStatus()}
    ${upgrade && !upgrade.running ? `<div class="row"><button class="btn small secondary" data-action="upgrade-close">Cerrar</button></div>` : ""}
  </section>`;
}

function upgradesCard() {
  const pending = pendingUpgrades();
  if (!pending.length && !upgrade) return "";
  const labels = upgradeLabels(pending);
  const result = upgradeStatus();
  return `<section class="card"><div class="sec">${pending.length ? `${pending.length === 1 ? "1 planta" : `${pending.length} plantas`}` : "Hecho"}</div>
    ${pending.length ? `<p class="muted">Hay mejoras que ${pending.length === 1 ? "esta planta aún no tiene" : "estas plantas aún no tienen"}: <strong>${esc(labels.join(", "))}</strong>. Pulsa una vez y la IA las completará. Lo que ya has puesto (nombre, zona, heladas y notas) no cambia.</p>
    <div class="row" style="margin-top:10px"><button class="btn small" data-action="upgrade-plants" ${upgrade?.running ? "disabled" : ""}>✦ Actualizar fichas</button></div>` : ""}
    ${result}</section>`;
}

async function upgradePlants() {
  const pending = pendingUpgrades();
  upgrade = { done: 0, total: pending.length, failed: 0, running: true, stopped: null, shownOnToday: state.tab === "today" };
  render();
  for (const plant of pending) {
    try {
      const missing = missingUpgrades(plant);
      const careUps = missing.filter((u) => u.source !== "calendar");
      if (careUps.length) {
        const care = await requestCare(plant.name);
        for (const u of careUps) u.apply(plant, care);
        if (!plant.species) plant.species = care.species;
        if (!plant.notes) plant.notes = care.notes;
        plant.careVersion = Math.max(...careUps.map((u) => u.version));
        withCurrentIntervals(plant);
        save();
      }
      const calUps = missing.filter((u) => u.source === "calendar");
      if (calUps.length) {
        const cal = await requestCalendar(plant.name, plant.species);
        for (const u of calUps) u.apply(plant, cal);
        plant.careVersion = CARE_VERSION;
        save();
      }
      track("upgrade_done");
    } catch (err) {
      if (err.message === "code" || err.message === "limit") { upgrade.stopped = aiErrorText(err.message); break; }
      upgrade.failed += 1;
    }
    upgrade.done += 1;
    render();
  }
  upgrade.running = false;
  render();
}

function render() {
  const loc = state.loc ?? DEFAULT_LOC;
  $("placeBtn").innerHTML = `${ICONS.pin}${esc(loc.name)}`;
  // Header: the tab's name, with today's date under «Hoy» and the count under «Plantas».
  const n = state.data.plants.length;
  $("title").textContent = { today: "Hoy", plants: "Plantas", more: "Ajustes" }[state.tab] ?? "Mi Jardín";
  $("subtitle").textContent = state.tab === "today"
    ? fmtDate(localToday(), { weekday: "long", day: "numeric", month: "long" }).replace(/^./, (c) => c.toUpperCase())
    : state.tab === "plants" ? (n === 1 ? "1 planta" : `${n} plantas`) : "Mi Jardín";
  document.querySelectorAll(".tabbar button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === state.tab)));
  $("fab").hidden = state.tab === "more";
  // Dot on Ajustes while some plant sheet has improvements to fetch.
  document.querySelector('.tabbar [data-tab="more"]').classList.toggle("has-dot", pendingUpgrades().length > 0);
  $("main").innerHTML = state.tab === "plants" ? plantsView() : state.tab === "more" ? moreView() : todayView();
  if (sheet.open && SHEET_VIEWS[sheet.dataset.view]) SHEET_VIEWS[sheet.dataset.view]();
}

// ---------- Sheets ----------
const sheet = $("sheet");
function openSheet(html, view = "") {
  sheet.dataset.view = view;
  delete sheet.dataset.plant; // plantSheet sets it again after opening
  sheet.innerHTML = `<div class="grabber" aria-hidden="true"></div><div class="sheet-in">${html}</div>`;
  if (!sheet.open) sheet.showModal();
}
function closeSheet() { sheet.close(); }

// Unsaved work in the open sheet: an edited plant form (typed or AI-filled), or a new plant
// whose name was already entered. Leaving asks first, so an AI fill isn't lost by accident.
let formDirty = false;
const hasUnsaved = () => formDirty || Boolean(wiz && ($("wizStep2") || $("wizName")?.elements.name.value.trim()));
function confirmDiscard() {
  if (hasUnsaved() && !confirm("Tienes cambios sin guardar. ¿Descartarlos?")) return false;
  formDirty = false;
  wiz = null;
  return true;
}
const leaveSheet = () => { if (confirmDiscard()) closeSheet(); };
sheet.addEventListener("click", (e) => { if (e.target === sheet) leaveSheet(); });

// Swipe down to close, as in iOS sheets: drag from the top of the sheet (or anywhere while it's
// scrolled to the top). Past 90 px it leaves (asking first if there are unsaved changes).
let drag = null;
sheet.addEventListener("touchstart", (e) => {
  if (sheet.scrollTop > 0 || e.target.closest("input, textarea, select")) return;
  drag = { y0: e.touches[0].clientY, dy: 0 };
}, { passive: true });
sheet.addEventListener("touchmove", (e) => {
  if (!drag) return;
  drag.dy = Math.max(0, e.touches[0].clientY - drag.y0);
  if (drag.dy > 0) { sheet.style.transition = "none"; sheet.style.transform = `translateY(${drag.dy}px)`; }
}, { passive: true });
sheet.addEventListener("touchend", () => {
  if (!drag) return;
  const far = drag.dy > 90;
  drag = null;
  sheet.style.transition = "transform 0.2s ease";
  if (far && confirmDiscard()) { sheet.style.transform = "translateY(100%)"; setTimeout(() => { closeSheet(); sheet.style.transform = ""; }, 180); }
  else sheet.style.transform = "";
});
sheet.addEventListener("cancel", (e) => { if (!confirmDiscard()) e.preventDefault(); }); // Esc / back gesture

function plantSheet(id) {
  const p = plantById(id);
  if (!p) return closeSheet();
  const today = localToday();
  const log = state.data.log.filter((e) => e.plantId === id).sort((a, b) => b.date.localeCompare(a.date));
  const lat = here().lat;
  const season = seasonOf(today, lat);
  const nexts = ["water", "feed"].map((type) => {
    const every = intervalFor(p, type, season);
    const due = nextDue(p, state.data.log, type, today, lat);
    const ico = `<span class="t-ico ${type}">${ICONS[TASK_ICON[type]]}</span>`;
    if (type === "water" && p.autoWater && every) {
      return `<div class="n-row">${ico}<div class="body"><b>Riego automático</b><span>Para el programador: cada ${every} días en ${SEASON_LABEL[season].toLowerCase()}${autoHint(p, season)}</span></div></div>`;
    }
    if (due) {
      const n = daysBetween(today, due);
      const kind = type === "feed" && p.feedTypes?.[season] ? `<span class="feed-type">${esc(p.feedTypes[season])} <span class="ai-mark">✦</span></span>` : "";
      return `<div class="n-row">${ico}<div class="body"><b class="${n < 0 ? "late" : ""}">${CARE[type].label} ${relDue(n).toLowerCase()}</b><span>${fmtDate(due, { weekday: "long", day: "numeric", month: "short" }).replace(/^./, (c) => c.toUpperCase())}</span>${kind}</div>` +
        `<span class="tag">cada ${every} d${aiMark(isAiValue(p, `${season}.${type}`))}</span></div>`;
    }
    if (type === "feed" && p.seasons) {
      const back = SEASONS.slice(SEASONS.indexOf(season) + 1).concat(SEASONS).find((k) => intervalFor(p, "feed", k));
      return `<div class="n-row">${ico}<div class="body"><b>Sin abonar en ${SEASON_LABEL[season].toLowerCase()}${aiMark(isAiValue(p, `${season}.feed`))}</b>${back ? `<span>Vuelve en ${SEASON_LABEL[back].toLowerCase()}</span>` : ""}</div></div>`;
    }
    return null;
  }).filter(Boolean);
  // Heads-up when the next season changes the watering.
  const changeOn = nextSeasonStart(today, lat);
  const nextSeason = seasonOf(changeOn, lat);
  const nextWater = intervalFor(p, "water", nextSeason);
  const nextLine = p.seasons && nextWater !== intervalFor(p, "water", season)
    ? `<div class="n-next">${ICONS.calendar}El ${fmtDate(changeOn, { day: "numeric", month: "long" })} pasa a ${SEASON_LABEL[nextSeason].toLowerCase()}: regar cada ${nextWater} días</div>` : "";
  let provenance = "";
  if (p.ai) {
    const changed = Object.keys(p.ai.values).filter((k) => !isAiValue(p, k)).length;
    const diff = p.ai.retro
      ? `${changed === 1 ? "1 dato distinto" : `${changed} datos distintos`} de su propuesta`
      : `${changed === 1 ? "1 dato cambiado" : `${changed} datos cambiados`} por ti`;
    provenance = `<p class="provenance"><span class="ai-mark">✦</span> ${p.ai.retro ? "Revisado con la IA" : "Propuesto por la IA"} el ${fmtDate(p.ai.at, { day: "numeric", month: "long" })}${changed ? ` · ${diff}` : ""}</p>`;
  }
  if (missingUpgrades(p).length) provenance += `<p class="provenance">Ficha por actualizar: Ajustes → Fichas por actualizar</p>`;
  const traits = [
    p.inPot ? ["pot", "Maceta"] : ["ground", "Suelo"],
    p.rainReaches ? ["rain", "Le llega la lluvia"] : ["umbrella", "A cubierto"],
    p.frostSensitive ? ["snow", "Sensible a heladas"] : null,
    p.autoWater ? ["drip", "Riego automático"] : null,
  ].filter(Boolean);
  const LOG_ICON = { water: "droplet", feed: "flask", prune: "scissors", treat: "bug", note: "notes", task: "check" };
  openSheet(`
    <div class="sheet-head"><h2>${esc(p.name)}</h2><div class="row"><button class="btn small secondary" data-action="edit-plant" data-id="${p.id}">Editar</button><button class="btn small secondary" data-action="close">Cerrar</button></div></div>
    ${p.photo ? `<img class="hero-photo" src="${p.photo}" alt="" />` : ""}
    ${p.species || p.zone ? `<p class="muted">${p.species ? `<em>${esc(p.species)}</em>${aiMark(isAiValue(p, "species"))}` : ""}${p.species && p.zone ? " · " : ""}${esc(p.zone)}</p>` : ""}
    <div class="traits">${traits.map(([icon, label]) => `<span class="trait">${ICONS[icon]}${label}</span>`).join("")}</div>
    ${nexts.length ? `<section class="card next-care"><div class="sec">${p.seasons ? `Ahora · ${SEASON_LABEL[season].toLowerCase()}` : "Ahora"}</div>${nexts.join("")}${p.tips?.[season] ? `<div class="n-tip">${ICONS[SEASON_ICON[season]]}<span>${esc(p.tips[season])} <span class="ai-mark">✦</span></span></div>` : ""}${nextLine}</section>` : ""}
    ${plantMonthCard(p, today)}
    <section class="card"><div class="sec">Registrar</div><div class="acts">
      ${Object.entries(CARE).filter(([type]) => type !== "task").map(([type, c]) => `<button type="button" class="act" data-action="log" data-type="${type}" data-id="${p.id}" data-reopen="1">${ICONS[LOG_ICON[type]]}${c.done}</button>`).join("")}
    </div></section>
    ${p.notes ? `<section class="card"><div class="sec start">Notas${aiMark(isAiValue(p, "notes"))}</div><p class="muted notes-text">${esc(p.notes).replace(/\n/g, "<br>")}</p></section>` : ""}
    ${yearCalendarCard(p, today)}
    <section class="card"><div class="sec">Historial</div>${log.length ? `<ul class="log">${log.map((e) => `
      <li><span class="log-ico ${e.type}">${ICONS[LOG_ICON[e.type]] ?? ""}</span><span class="log-what">${esc(CARE[e.type]?.done ?? e.type)}${e.note ? ` — ${esc(e.note)}` : ""}</span><span class="d">${fmtDate(e.date)}</span>
      <button class="x" data-action="del-log" data-log="${e.id}" data-id="${p.id}" aria-label="Borrar">${ICONS.x}</button></li>`).join("")}</ul>` : `<p class="muted">Sin registros todavía.</p>`}</section>
    ${provenance}
    `);
  sheet.dataset.plant = id;
}

let draftPhoto = null;
function plantForm(id) {
  formDirty = false;
  const p = id ? plantById(id) : { name: "", species: "", zone: "", seasons: DEFAULT_SEASONS, rainReaches: true, inPot: true, frostSensitive: false, notes: "" };
  draftPhoto = p.photo ?? null;
  const zones = [...new Set(state.data.plants.map((x) => x.zone).filter(Boolean))];
  openSheet(`
    <div class="sheet-head"><h2>${id ? "Editar planta" : "Nueva planta"}</h2><button class="btn small secondary" data-action="${id ? "open-plant" : "close"}" data-id="${id ?? ""}">Cancelar</button></div>
    <form id="plantForm" class="sheet-in" style="padding:0">
      <section class="card ai-card edit-card ${p.ai ? "ai-halo done" : ""}" id="editCard">
        <label class="thumb-pick" aria-label="Cambiar foto"><span class="cam">${ICONS.camera}</span><span id="photoPreview">${draftPhoto ? `<img class="thumb" src="${draftPhoto}" alt="" />` : `<span class="thumb placeholder">${ICONS.sprout}</span>`}</span><input type="file" id="photoInput" accept="image/*" hidden /></label>
        <div class="body">
          <input name="name" class="name-input" required placeholder="Nombre de la planta" value="${esc(p.name)}" aria-label="Nombre" />
          <input name="species" class="species-input" placeholder="Especie (opcional)" value="${esc(p.species)}" aria-label="Especie" />
          <span id="editAiLine">${p.ai ? `<span class="ai-pill">✦ ${p.ai.retro ? "Revisado con" : "Propuesto por"} la IA el ${fmtDate(p.ai.at)}</span>` : ""}</span>
        </div>
      </section>
      <button type="button" class="btn secondary ai-btn" data-action="ai-fill">${p.ai ? "✦ Volver a consultar a la IA" : "✦ Rellenar con IA"}</button>
      <p class="ai-status" id="aiStatus" hidden></p>
      <h3 class="q">¿Dónde está?</h3>
      <div class="chips" id="zoneChips">
        ${zones.map((z) => `<button type="button" class="chip ${z === p.zone ? "on" : ""}" data-action="edit-zone" data-zone="${esc(z)}">${esc(z)}</button>`).join("")}
        <button type="button" class="chip" data-action="edit-new-zone">+ Nueva zona</button>
      </div>
      <input name="zone" id="editZone" class="big-input" placeholder="Terraza sur, jardín delantero…" autocomplete="off" value="${esc(p.zone)}" hidden />
      ${radioSeg("inPot", "Plantada en", p.inPot, [[true, "pot", "Maceta"], [false, "ground", "Suelo"]])}
      ${radioSeg("rainReaches", "La lluvia", p.rainReaches, [[true, "rain", "Le llega"], [false, "umbrella", "A cubierto"]])}
      <label class="switch-row">
        <span>${ICONS.snow}Sensible a heladas</span>
        <input type="checkbox" role="switch" name="frostSensitive" class="switch-input" ${p.frostSensitive ? "checked" : ""} />
        <span class="switch" aria-hidden="true"></span>
      </label>
      <label class="switch-row">
        <span>${ICONS.drip}Riego automático</span>
        <input type="checkbox" role="switch" name="autoWater" class="switch-input" ${p.autoWater ? "checked" : ""} />
        <span class="switch" aria-hidden="true"></span>
      </label>
      <section class="card care-block">
        <h3>Cuidados${p.ai ? ` propuestos <span class="ai-mark">✦</span>` : ""}</h3>
        ${seasonTable(p.seasons ?? legacySeasons(p), { form: true, aiCells: aiCellsOf(p) })}
        <div id="tipsBox">${tipsList(p.tips)}</div>
        <label class="field">Notas${aiMark(isAiValue(p, "notes"))}<textarea name="notes" class="autogrow" rows="6" placeholder="Comprada en marzo, le gusta el sol de mañana…">${esc(p.notes)}</textarea></label>
      </section>
      ${id ? `<button type="button" class="btn danger block delete-plant" data-action="del-plant" data-id="${id}">Eliminar planta</button>` : ""}
      <div class="sheet-actions"><button class="btn block" type="submit">${id ? "Guardar cambios" : "Guardar"}</button></div>
    </form>`);
  $("plantForm").dataset.id = id ?? "";
  autogrow($("plantForm").elements.notes);
}

// Same segmented look as the new-plant step 2, but with real radio inputs so the edit form
// reads them through FormData without redrawing.
function radioSeg(name, label, current, options) {
  return `
    <div class="seg-label" id="eseg-${name}">${label}</div>
    <div class="seg" role="radiogroup" aria-labelledby="eseg-${name}">
      ${options.map(([value, icon, text]) => `<label><input type="radio" name="${name}" value="${value}" ${current === value ? "checked" : ""} />${ICONS[icon]}${text}</label>`).join("")}
    </div>`;
}

// waterEvery/feedEvery mirror today's season so exports and older readers stay meaningful.
function withCurrentIntervals(plant) {
  const now = seasonOf(localToday(), here().lat);
  plant.waterEvery = plant.seasons[now].water;
  plant.feedEvery = plant.seasons[now].feed;
  return plant;
}

// Water/feed interval for each season, today's highlighted. In the edit form the inputs are
// named s-<season>-<water|feed> (read through FormData); in the new-plant step they carry
// data-season/data-kind and update the draft as you type.
const DEFAULT_SEASONS = { spring: { water: 4, feed: 30 }, summer: { water: 2, feed: 30 }, autumn: { water: 5, feed: 0 }, winter: { water: 10, feed: 0 } };
const SEASON_ICON = { spring: "sprout", summer: "sun", autumn: "leaf", winter: "snow" };

// `aiCells` holds "season.kind" keys proposed by the AI and not changed since: they carry a ✦.
function seasonTable(seasons, { form = false, busy = false, aiCells = new Set() } = {}) {
  const now = seasonOf(localToday(), here().lat);
  const cell = (k, kind, value) => {
    const attrs = form ? `name="s-${k}-${kind}"` : `data-season="${k}" data-kind="${kind}"`;
    const shown = busy ? "" : kind === "feed" ? value || "" : value;
    const cls = [busy ? "skel" : "", aiCells.has(`${k}.${kind}`) ? "ai" : ""].join(" ");
    return `<label class="st-cell ${cls}"><input type="number" ${attrs} min="${kind === "water" ? 1 : 0}" max="${kind === "water" ? 60 : 365}" inputmode="numeric" value="${shown}" placeholder="${busy ? "" : kind === "feed" ? "No" : ""}" aria-label="${kind === "water" ? "Regar" : "Abonar"} en ${SEASON_LABEL[k].toLowerCase()}, días" ${busy ? "disabled" : ""} /><span>d</span></label>`;
  };
  return `
    <div class="season-table ${aiCells.size ? "has-ai" : ""}">
      <span></span><span class="st-h">Regar cada</span><span class="st-h">Abonar cada</span>
      ${SEASONS.map((k) => `
        <span class="st-name ${k === now ? "now" : ""}">${ICONS[SEASON_ICON[k]]}${SEASON_LABEL[k]}</span>
        ${cell(k, "water", seasons[k].water)}${cell(k, "feed", seasons[k].feed)}`).join("")}
    </div>
    <p class="st-legend"><span class="ai-mark">✦</span> Propuesto por la IA <span class="now-box"></span> Estación actual</p>
    <p class="muted small">Cambia solo con la estación (ahora, ${SEASON_LABEL[now].toLowerCase()}) en ${esc(here().name)}. Abono vacío = no abonar esa estación.</p>`;
}
const ALL_CELLS = SEASONS.flatMap((k) => [`${k}.water`, `${k}.feed`]);

// ---------- AI provenance ----------
// A plant keeps what the AI proposed: { at, from, values: { "spring.water": 4, …, species, notes, frostSensitive } }.
// A field counts as the AI's while its value is still the proposed one; once changed, it's the user's.
function aiSnapshot(care, from) {
  const values = { species: care.species, notes: care.notes, frostSensitive: care.frostSensitive };
  for (const k of SEASONS) { values[`${k}.water`] = care.seasons[k].water; values[`${k}.feed`] = care.seasons[k].feed; }
  return { at: localToday(), from: from ?? `${care.commonName} (${care.species})`, values };
}
function fieldValue(plant, key) {
  const [season, kind] = key.split(".");
  return kind ? plant.seasons?.[season]?.[kind] : plant[key];
}
const isAiValue = (plant, key) => Boolean(plant.ai) && key in plant.ai.values && plant.ai.values[key] === fieldValue(plant, key);
const aiCellsOf = (plant) => new Set(ALL_CELLS.filter((c) => isAiValue(plant, c)));
const aiMark = (on) => (on ? ` <span class="ai-mark" title="Propuesto por la IA">✦</span>` : "");

// The four seasonal tips from the AI, today's season first.
function tipsList(tips) {
  if (!tips) return "";
  const now = seasonOf(localToday(), here().lat);
  const order = SEASONS.slice(SEASONS.indexOf(now)).concat(SEASONS.slice(0, SEASONS.indexOf(now)));
  return `<div class="tips"><div class="tips-title">Consejos por estación <span class="ai-mark">✦</span></div>${order.filter((k) => tips[k]).map((k) =>
    `<div class="tip ${k === now ? "now" : ""}">${ICONS[SEASON_ICON[k]]}<div><b>${SEASON_LABEL[k]}</b>${esc(tips[k])}</div></div>`).join("")}</div>`;
}

const legacySeasons = (p) => Object.fromEntries(SEASONS.map((k) => [k, { water: p.waterEvery || 3, feed: p.feedEvery || 0 }]));
const readSeasonTable = (f) => Object.fromEntries(SEASONS.map((k) => [k, {
  water: Math.min(60, Math.max(1, parseInt(f.get(`s-${k}-water`), 10) || 1)),
  feed: Math.min(365, Math.max(0, parseInt(f.get(`s-${k}-feed`), 10) || 0)),
}]));

// Notes box grows with its text so a whole paragraph is readable without scrolling inside it.
function autogrow(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + 2}px`;
}

// Photos are shrunk to 640px JPEG so dozens of plants fit in localStorage.
function shrinkPhoto(file, max = 640) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL("image/jpeg", 0.72));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function placeSheet() {
  openSheet(`
    <div class="sheet-head"><h2>Ubicación</h2><button class="btn small secondary" data-action="close">Cerrar</button></div>
    <button class="btn block" data-action="locate">📍 Usar mi ubicación</button>
    <label class="field">O busca una ciudad<input id="placeQuery" type="search" placeholder="Valencia, Sevilla…" autocomplete="off" /></label>
    <div class="results" id="placeResults"></div>`);
  let timer;
  $("placeQuery").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const results = await searchCities(e.target.value).catch(() => []);
      $("placeResults").innerHTML = results.length
        ? results.map((r, i) => `<button data-action="pick-place" data-i="${i}">${esc(r.name)} <small>${esc([r.admin, r.country].filter(Boolean).join(", "))}</small></button>`).join("")
        : e.target.value.trim() ? `<p class="muted">Sin resultados</p>` : "";
      $("placeResults").dataset.results = JSON.stringify(results);
    }, 300);
  });
  $("placeQuery").focus();
}

function setLoc(loc) {
  state.loc = loc;
  store.set("mj_loc", loc);
  closeSheet();
  loadWeather();
}

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- AI fill ----------
// Asks the backend for this plant's care sheet (for the current place and month) and fills the
// form. Nothing is saved until the user reviews it and taps Guardar.
const AI_ERRORS = {
  code: "Código de acceso incorrecto o sin poner: revísalo en Ajustes.",
  limit: "Se ha alcanzado el límite de hoy. Rellénalo a mano o prueba mañana.",
  not_plant: "No parece el nombre de una planta. Si es un apodo, prueba con su nombre común (por ejemplo «poto»), o rellena los cuidados a mano.",
};

// "¿No es esta? También podría ser: …" — each button asks for that plant instead.
const altButtons = (alts, action) => alts?.length
  ? `<div class="ai-alts"><span>¿No es esta? También podría ser:</span>${alts.map((a, i) =>
      `<button type="button" class="chip" data-action="${action}" data-i="${i}">${esc(a.commonName)} <em>${esc(a.species)}</em></button>`).join("")}</div>`
  : "";
const altQuery = (a) => `${a.commonName} (${a.species})`;

// Whether the AI can be used: the Worker may run without the access code (REQUIRE_CODE = "off"),
// which /health reports; otherwise a saved code is needed. Unknown until /health answers.
let aiOpen = null;
const aiCode = () => store.get("mj_ai_code", "");
const hasAI = () => aiOpen === true || Boolean(aiCode());
const aiHeaders = () => ({ "Content-Type": "application/json", ...(aiCode() ? { "X-Access-Code": aiCode() } : {}) });
fetch(`${API}/health`).then((r) => r.json()).then((h) => { aiOpen = h.code === false; render(); }).catch(() => {});

// Resolves to the care sheet, or throws an Error whose message is a key of AI_ERRORS
// ("code", "limit") or "timeout" / "network" / "ai".
async function requestCare(name) {
  if (aiOpen === false && !aiCode()) throw new Error("code");
  const loc = state.loc ?? DEFAULT_LOC;
  let res;
  try {
    res = await fetch(`${API}/care`, {
      method: "POST",
      signal: AbortSignal.timeout(30000),
      headers: aiHeaders(),
      body: JSON.stringify({ name, lat: loc.lat, lon: loc.lon, place: loc.name }),
    });
  } catch (err) {
    throw new Error(err?.name === "TimeoutError" ? "timeout" : "network");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error in AI_ERRORS ? body.error : "ai");
  return body;
}

// The year calendar comes from its own endpoint and is slower: asked in the background.
async function requestCalendar(name, species) {
  if (aiOpen === false && !aiCode()) throw new Error("code");
  const loc = state.loc ?? DEFAULT_LOC;
  let res;
  try {
    res = await fetch(`${API}/calendar`, {
      method: "POST",
      signal: AbortSignal.timeout(90000),
      headers: aiHeaders(),
      body: JSON.stringify({ name, species, lat: loc.lat, lon: loc.lon, place: loc.name }),
    });
  } catch (err) {
    throw new Error(err?.name === "TimeoutError" ? "timeout" : "network");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error in AI_ERRORS ? body.error : "ai");
  return body;
}

// After a plant is saved with the AI, its calendar arrives a few seconds later. Until then the
// plant shows «Preparando el calendario…»; on failure it stays in «Fichas por actualizar».
const calendarPending = new Set();
async function fetchCalendarFor(plantId) {
  const p = plantById(plantId);
  if (!p || calendarPending.has(plantId)) return;
  calendarPending.add(plantId);
  render(); if (sheet.open && sheet.dataset.plant === plantId) plantSheet(plantId);
  try {
    const cal = await requestCalendar(p.name, p.species);
    const plant = plantById(plantId);
    if (plant) { plant.yearTasks = cal.tasks ?? []; plant.risks = cal.risks ?? []; plant.careVersion = CARE_VERSION; save(); }
  } catch { /* stays pending in «Fichas por actualizar» */ }
  calendarPending.delete(plantId);
  render(); if (sheet.open && sheet.dataset.plant === plantId) plantSheet(plantId);
}

const aiErrorText = (key) => AI_ERRORS[key] ?? {
  timeout: "El asistente está tardando demasiado. Vuelve a intentarlo en un rato o rellénalo a mano.",
  network: "Sin conexión con el asistente. Rellénalo a mano.",
}[key] ?? "El asistente no está disponible ahora. Rellénalo a mano.";

// `query` is set when the user picked one of the alternatives; otherwise the plant's name is asked.
async function aiFill(query) {
  const form = $("plantForm");
  const status = $("aiStatus");
  const show = (text, kind = "", extra = "") => { status.hidden = false; status.className = `ai-status ${kind}`; status.innerHTML = esc(text) + extra; };
  const name = form.elements.name.value.trim();
  if (!name) { form.elements.name.focus(); return show("Escribe primero el nombre de la planta.", "warn"); }
  if (!hasAI()) return show(AI_ERRORS.code, "warn");

  const btn = form.querySelector('[data-action="ai-fill"]');
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  btn.innerHTML = `<span class="spinner" aria-hidden="true"></span> Consultando a la IA…`;
  show(`Buscando los cuidados de «${name}». Tarda unos segundos.`, "ai");
  const loc = state.loc ?? DEFAULT_LOC;
  const cells = [...form.querySelectorAll(".st-cell")];
  cells.forEach((c) => { c.classList.add("skel"); c.classList.remove("ai"); });
  const card = $("editCard");
  const hadHalo = card.classList.contains("ai-halo");
  card.classList.remove("done");
  card.classList.add("ai-halo", "loading");
  try {
    const care = await requestCare(query ?? name);
    const f = form.elements;
    f.species.value = care.species;
    for (const k of SEASONS) {
      f[`s-${k}-water`].value = care.seasons[k].water;
      f[`s-${k}-feed`].value = care.seasons[k].feed || "";
    }
    f.frostSensitive.checked = care.frostSensitive;
    // Replace the notes if they're empty or still the AI's previous text (e.g. for another plant).
    if (!f.notes.value.trim() || f.notes.value === form.dataset.aiNotes) f.notes.value = care.notes;
    form.dataset.aiNotes = care.notes;
    form.dataset.aiSnapshot = JSON.stringify(aiSnapshot(care));
    form.dataset.tips = JSON.stringify(care.tips ?? null);
    form.dataset.feedTypes = JSON.stringify(care.feedTypes ?? null);
    $("tipsBox").innerHTML = tipsList(care.tips);
    form.dataset.alternatives = JSON.stringify(care.alternatives ?? []);
    formDirty = true;
    form.dataset.aiFilled = "1";
    track("ai_fill_edit");
    cells.forEach((c) => c.classList.add("ai"));
    form.querySelector(".season-table").classList.add("has-ai");
    card.classList.add("done");
    $("editAiLine").innerHTML = `<span class="ai-pill">✦ Rellenado con IA · revisa los datos</span>`;
    autogrow(f.notes);
    show(care.confidence === "baja"
      ? `⚠️ No está seguro de qué planta es «${name}». Revisa los datos o prueba con otro nombre.`
      : `✦ Rellenado con IA para ${care.commonName} (${care.species}) en ${loc.name}. Revisa los datos y guarda.`, care.confidence === "baja" ? "warn" : "ai",
      altButtons(care.alternatives, "edit-alt"));
  } catch (err) {
    show(aiErrorText(err.message), "warn");
  } finally {
    card.classList.remove("loading");
    if (!card.classList.contains("done") && !hadHalo) card.classList.remove("ai-halo");
    if (hadHalo) card.classList.add("done");
    cells.forEach((c) => c.classList.remove("skel"));
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    btn.innerHTML = label;
  }
}

// Line icons for controls: they take the text colour, so the selected state can tint them.
// (Emoji stay for content: forecast, task rows, plant placeholders.)
const svg = (d) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICONS = {
  droplet: svg('<path d="M7.5 19.4a7.2 7.2 0 0 0 9 0 6.5 6.5 0 0 0 1.6-8.5l-4.9-7.3a1.4 1.4 0 0 0-2.4 0l-4.9 7.3a6.5 6.5 0 0 0 1.6 8.5z"/>'),
  flask: svg('<path d="M9 3h6M10 9h4M10 3v6l-4 11a.7.7 0 0 0 .5 1h11a.7.7 0 0 0 .5-1l-4-11V3"/>'),
  check: svg('<path d="M5 12l5 5L20 7"/>'),
  circleCheck: svg('<circle cx="12" cy="12" r="9"/><path d="M9 12l2 2 4-4"/>'),
  pin: svg('<circle cx="12" cy="11" r="3"/><path d="M17.7 16.7l-4.3 4.2a2 2 0 0 1-2.8 0l-4.3-4.2a8 8 0 1 1 11.4 0z"/>'),
  cloud: svg('<path d="M7 18a4.6 4.4 0 0 1 0-9 5 4.5 0 0 1 11 2h1a3.5 3.5 0 0 1 0 7H7z"/>'),
  "cloud-rain": svg('<path d="M7 18a4.6 4.4 0 0 1 0-9 5 4.5 0 0 1 11 2h1a3.5 3.5 0 0 1 0 7"/><path d="M11 13v2m0 3v2m4-5v2m0 3v2"/>'),
  "cloud-storm": svg('<path d="M7 18a4.6 4.4 0 0 1 0-9 5 4.5 0 0 1 11 2h1a3.5 3.5 0 0 1 0 7h-1"/><path d="M13 14l-2 4h3l-2 4"/>'),
  "cloud-sun": svg('<path d="M9 3.5v1M4.3 5.3l.7.7M3 10h1M13.7 5.3l-.7.7"/><path d="M6 12.5a3.5 3.5 0 1 1 6.6-2"/><path d="M9.5 20a3.4 3.4 0 0 1 0-6.8 4 4 0 0 1 7.7 1.3h.6a2.8 2.8 0 0 1 0 5.5z"/>'),
  fog: svg('<path d="M5 5h3m4 0h9M3 10h11m4 0h1M5 15h5m4 0h7M3 20h9m4 0h3"/>'),
  wind: svg('<path d="M5 8h8.5a2.5 2.5 0 1 0-2.3-3.2M3 12h15.5a2.5 2.5 0 1 1-2.3 3.2M4 16h5.5a2.5 2.5 0 1 1-2.3 3.2"/>'),
  flame: svg('<path d="M12 11c2.3-3.3.2-7.8-1-9 0 3.4-2.2 5.3-3.7 6.7C5.9 10.1 5 12.3 5 14.3 5 18 8.1 21 12 21s7-3 7-6.7c0-1.7-1.2-4.4-2.3-5.6-2.1 3.4-3.3 3.4-4.7 2.3z"/>'),
  chart: svg('<path d="M3 3v18h18"/><path d="M7 16v-4M11 16V8M15 16v-6M19 16V5"/>'),
  database: svg('<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>'),
  shovel: svg('<path d="M17 4l3 3M18.5 5.5L11 13M8.5 10.5l5 5-2.5 2.5a3.5 3.5 0 0 1-5 0l0 0a3.5 3.5 0 0 1 0-5z"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>'),
  chevron: svg('<path d="M9 6l6 6-6 6"/>'),
  x: svg('<path d="M18 6L6 18M6 6l12 12"/>'),
  scissors: svg('<circle cx="6" cy="7" r="3"/><circle cx="6" cy="17" r="3"/><path d="M8.6 8.6L19 19M8.6 15.4L19 5"/>'),
  bug: svg('<path d="M9 9V8a3 3 0 0 1 6 0v1"/><path d="M8 9h8a6 6 0 0 1 1 3v3a5 5 0 0 1-10 0v-3a6 6 0 0 1 1-3"/><path d="M3 13h4M17 13h4M12 20v-6M4 19l3.4-2M20 19l-3.4-2M4 7l3.8 2.8M20 7l-3.8 2.8"/>'),
  notes: svg('<path d="M5 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z"/><path d="M9 7h6M9 11h6M9 15h4"/>'),
  calendar: svg('<path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M16 3v4M8 3v4M4 11h16"/>'),
  camera: svg('<path d="M5 7h1a2 2 0 0 0 2-2 1 1 0 0 1 1-1h6a1 1 0 0 1 1 1 2 2 0 0 0 2 2h1a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2"/><circle cx="12" cy="13" r="3"/>'),
  bell: svg('<path d="M10 5a2 2 0 1 1 4 0 7 7 0 0 1 4 6v3a4 4 0 0 0 2 3H4a4 4 0 0 0 2-3v-3a7 7 0 0 1 4-6"/><path d="M9 17v1a3 3 0 0 0 6 0v-1"/>'),
  download: svg('<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M7 11l5 5 5-5M12 4v12"/>'),
  upload: svg('<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M7 9l5-5 5 5M12 4v12"/>'),
  refresh: svg('<path d="M20 11A8.1 8.1 0 0 0 4.5 9M4 5v4h4M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/>'),
  alert: svg('<path d="M12 9v4M12 17h.01"/><path d="M10.4 3.9L2.6 17.5A1.8 1.8 0 0 0 4.1 20h15.8a1.8 1.8 0 0 0 1.5-2.5L13.6 3.9a1.8 1.8 0 0 0-3.2 0z"/>'),
  pot: svg('<path d="M5 10h14l-1.6 9.1a1 1 0 0 1-1 .9H7.6a1 1 0 0 1-1-.9z"/><path d="M12 10V6"/><path d="M12 6c0-2 1.5-3 3.5-3 0 2-1.5 3-3.5 3zM12 7.5C12 6 10.8 5 9 5c0 1.5 1.2 2.5 3 2.5z"/>'),
  ground: svg('<path d="M3 19h18M7 22h10"/><path d="M12 19v-8"/><path d="M12 11c0-3 2-5 5.5-5 0 3-2 5-5.5 5zM12 14c0-2.5-1.8-4-4.5-4 0 2.5 1.8 4 4.5 4z"/>'),
  rain: svg('<path d="M7 14.5A4 4 0 0 1 7.6 6.6 5.5 5.5 0 0 1 18 8.5a3 3 0 0 1-.5 6z"/><path d="M8 18l-1 2.5M12 18l-1 2.5M16 18l-1 2.5"/>'),
  umbrella: svg('<path d="M3 12a9 9 0 0 1 18 0z"/><path d="M12 12v6.5a2 2 0 0 0 4 0"/><path d="M12 3v.01"/>'),
  "snow": svg('<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/><path d="M9.5 4.5 12 6l2.5-1.5M9.5 19.5 12 18l2.5 1.5"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  leaf: svg('<path d="M5 19c0-8 5-14 15-14 0 10-6 15-14 15"/><path d="M5 19l7-7"/>'),
  drip: svg('<path d="M4 20h16M12 20v-5"/><path d="M12 15s-4-2.2-4-5a4 4 0 0 1 8 0c0 2.8-4 5-4 5z"/>'),
  sprout: svg('<path d="M12 20v-8"/><path d="M12 12c0-3 2-5 5.5-5 0 3-2 5-5.5 5zM12 14c0-2.5-1.8-4-4.5-4 0 2.5 1.8 4 4.5 4z"/>'),
  sparkle: svg('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 16v4M17 18h4"/>'),
};

// ---------- New plant: two steps ----------
// Step 1 asks what the plant is (and starts the AI lookup); step 2 asks where it lives, with big
// toggles pre-set from the last plant added. Editing an existing plant keeps the full form.
let wiz = null;
const PLACE_DEFAULTS = { zone: "", inPot: true, rainReaches: true };

function newPlantWizard() {
  draftPhoto = null;
  wiz = {
    step: 1, name: "", ai: "idle", aiError: "", care: null, touched: {},
    ...PLACE_DEFAULTS, ...store.get("mj_last_place", {}),
    species: "", seasons: structuredClone(DEFAULT_SEASONS), frostSensitive: false, notes: "", newZone: false,
  };
  wiz.autoWater = autoZones().includes(wiz.zone);
  renderWizard();
}

function renderWizard() {
  if (!wiz) return;
  const head = (right) => `<div class="sheet-head"><h2>Nueva planta</h2><div class="row"><span class="muted">${wiz.step} de 2</span>${right}</div></div>`;
  if (wiz.step === 1) {
    const hasCode = hasAI() || aiOpen === null;
    openSheet(`
      ${head(`<button class="btn small secondary" data-action="close">Cancelar</button>`)}
      <form id="wizName" class="sheet-in" style="padding:0">
        <h3 class="q">¿Qué planta es?</h3>
        <input name="name" class="big-input" required placeholder="Olivo, limonero, geranio…" autocomplete="off" value="${esc(wiz.name)}" />
        <div class="photo-pick"><span id="photoPreview">${draftPhoto ? `<img src="${draftPhoto}" alt="" />` : `<span class="thumb placeholder">${ICONS.camera}</span>`}</span>
          <label class="btn small secondary">Añadir foto<input type="file" id="photoInput" accept="image/*" hidden /></label></div>
        <p class="muted">${hasCode ? `<span class="ai-mark">✦</span> Con el nombre, la IA propondrá sus cuidados por estación para tu zona.` : "Activa el asistente IA en Ajustes para que proponga los cuidados."}</p>
        <button class="btn block" type="submit">Siguiente</button>
      </form>`);
    setTimeout(() => $("wizName")?.elements.name.focus(), 50);
    return;
  }
  const zones = [...new Set([...state.data.plants.map((p) => p.zone), wiz.zone].filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));
  // While the AI is answering, the fields it fills (and Guardar) wait; the place choices stay free.
  const busy = wiz.ai === "loading";
  const lock = busy ? "disabled" : "";
  // Two mutually exclusive options → one segmented control per question.
  const segmented = (key, label, options) => `
    <div class="seg-label" id="seg-${key}">${label}</div>
    <div class="seg" role="radiogroup" aria-labelledby="seg-${key}">
      ${options.map(([value, icon, text]) => `<button type="button" role="radio" aria-checked="${wiz[key] === value}" data-action="wiz-set" data-key="${key}" data-value="${value}">${ICONS[icon]}${text}</button>`).join("")}
    </div>`;
  const aiLine = {
    loading: `<span class="ai-step"><span class="spinner" aria-hidden="true"></span><span id="wizAiStep">${AI_STEPS[wiz.aiStep ?? 0]}</span>…</span>`,
    done: `<span class="muted">${esc(wiz.species || "Especie sin identificar")}</span><span class="ai-pill">✦ Rellenado con IA · revisa los datos</span>`,
    error: `<span class="muted">${esc(wiz.aiError)}</span>`,
    notplant: `<span class="ai-warn">«${esc(wiz.name)}» no parece una planta.</span><span class="muted small">${esc(wiz.aiError.replace(/^No parece el nombre de una planta\. /, ""))}</span>
      <button type="button" class="btn small secondary" data-action="wiz-back" style="align-self:flex-start;margin-top:6px">Cambiar el nombre</button>`,
    idle: `<span class="muted">Cuidados a mano: ajústalos abajo.</span>`,
  }[wiz.ai];
  openSheet(`
    ${head(`<button class="btn small secondary" data-action="wiz-back">Atrás</button>`)}
    <section class="card ai-card ${wiz.ai} ${wiz.ai === "loading" || wiz.ai === "done" ? "ai-halo" : ""}" id="wizStep2">
      ${draftPhoto ? `<img class="thumb" src="${draftPhoto}" alt="" />` : `<span class="thumb placeholder">${ICONS.sprout}</span>`}
      <div class="body"><div class="name">${esc(wiz.name)}</div>${aiLine}</div>
    </section>
    ${wiz.ai === "done" ? altButtons(wiz.care?.alternatives, "wiz-alt") : ""}
    ${wiz.care?.confidence === "baja" ? `<p class="ai-status warn">⚠️ La IA no está segura de qué planta es. Revisa los días o vuelve atrás y prueba con otro nombre.</p>` : ""}
    <h3 class="q">¿Dónde está?</h3>
    <div class="chips">
      ${zones.map((z) => `<button type="button" class="chip ${!wiz.newZone && wiz.zone === z ? "on" : ""}" data-action="wiz-zone" data-zone="${esc(z)}">${esc(z)}</button>`).join("")}
      <button type="button" class="chip ${wiz.newZone ? "on" : ""}" data-action="wiz-new-zone">+ Nueva zona</button>
    </div>
    ${wiz.newZone ? `<input id="wizZone" class="big-input" placeholder="Terraza sur, jardín delantero…" autocomplete="off" value="${esc(wiz.zone)}" />` : ""}
    ${segmented("inPot", "Plantada en", [[true, "pot", "Maceta"], [false, "ground", "Suelo"]])}
    ${segmented("rainReaches", "La lluvia", [[true, "rain", "Le llega"], [false, "umbrella", "A cubierto"]])}
    <button type="button" class="switch-row" role="switch" aria-checked="${wiz.frostSensitive && !busy}" data-action="wiz-set" data-key="frostSensitive" ${lock}>
      <span>${ICONS.snow}Sensible a heladas</span><span class="switch" aria-hidden="true"></span>
    </button>
    <button type="button" class="switch-row" role="switch" aria-checked="${wiz.autoWater}" data-action="wiz-set" data-key="autoWater">
      <span>${ICONS.drip}Riego automático</span><span class="switch" aria-hidden="true"></span>
    </button>
    <section class="card care-block">
      <h3>Cuidados${wiz.ai === "done" ? ` propuestos <span class="ai-mark">✦</span>` : ""}</h3>
      ${seasonTable(wiz.seasons, { busy, aiCells: wiz.ai === "done" ? new Set(ALL_CELLS.filter((c) => !wiz.touched[c])) : undefined })}
      ${wiz.ai === "done" ? tipsList(wiz.tips) : ""}
      ${wiz.ai === "done" && wiz.notes ? `
      <div class="ai-notes ${wiz.notesOpen ? "open" : ""}">
        <p>${esc(wiz.notes)}</p>
        <button type="button" class="more" data-action="wiz-notes" aria-expanded="${Boolean(wiz.notesOpen)}">${wiz.notesOpen ? "Ver menos" : "Ver más"}</button>
      </div>` : ""}
    </section>
    ${store.get("mj_last_place", null) ? `<p class="muted small">Zona y opciones como en la última planta que añadiste.</p>` : ""}
    <div class="sheet-actions">${busy
      ? `<button class="btn block" data-action="wiz-save" disabled aria-busy="true"><span class="spinner" aria-hidden="true"></span> Esperando a la IA…</button>`
      : `<button class="btn block" data-action="wiz-save">Guardar planta</button>`}</div>`);
  if (wiz.newZone) setTimeout(() => $("wizZone")?.focus(), 50);
}

// What the AI card says while waiting: it advances every couple of seconds.
const AI_STEPS = ["Identificando la planta", "Calculando el riego por estación", "Revisando el abonado", "Escribiendo consejos"];

async function wizLookup() {
  const current = wiz;
  current.ai = "loading";
  current.aiStep = 0;
  renderWizard();
  const ticker = setInterval(() => {
    current.aiStep = Math.min(current.aiStep + 1, AI_STEPS.length - 1);
    const el = $("wizAiStep");
    if (el && wiz === current) el.textContent = AI_STEPS[current.aiStep];
  }, 2200);
  try {
    const care = await requestCare(current.query ?? current.name);
    current.care = care;
    current.ai = "done";
    current.species = care.species;
    for (const k of SEASONS) for (const kind of ["water", "feed"]) {
      if (!current.touched[`${k}.${kind}`]) current.seasons[k][kind] = care.seasons[k][kind];
    }
    if (!current.touched.frostSensitive) current.frostSensitive = care.frostSensitive;
    current.notes = care.notes;
    current.tips = care.tips;
    current.feedTypes = care.feedTypes;

  } catch (err) {
    current.ai = err.message === "not_plant" ? "notplant" : "error";
    current.aiError = aiErrorText(err.message);
  }
  clearInterval(ticker);
  // Redraw only if this draft's step 2 is still what the sheet shows.
  if (wiz === current && $("wizStep2")) renderWizard();
}

function wizSave() {
  if (wiz.ai === "loading") return;
  track(wiz.ai === "done" ? "plant_add_ai" : "plant_add_manual");
  const zone = wiz.zone.trim();
  const plant = {
    id: uid(), created: localToday(), name: wiz.name, species: wiz.species, zone,
    seasons: wiz.seasons, rainReaches: wiz.rainReaches, inPot: wiz.inPot,
    frostSensitive: wiz.frostSensitive, autoWater: wiz.autoWater, notes: wiz.notes, tips: wiz.tips, feedTypes: wiz.feedTypes, photo: draftPhoto,
  };
  if (wiz.ai === "done" && wiz.care) plant.ai = aiSnapshot(wiz.care);
  // With the AI, the calendar (version 4) arrives in the background; by hand, nothing to fetch.
  plant.careVersion = wiz.ai === "done" ? 3 : CARE_VERSION;
  withCurrentIntervals(plant);
  store.set("mj_last_place", { zone, inPot: wiz.inPot, rainReaches: wiz.rainReaches });
  state.data.plants.push(plant);
  save();
  render();
  const askCalendar = wiz.ai === "done";
  wiz = null;
  plantSheet(plant.id);
  if (askCalendar) fetchCalendarFor(plant.id);
}

// Saving the access code checks it against the backend so the user sees at once whether it works.
let codeStatus = null;
async function saveCode(code) {
  store.set("mj_ai_code", code);
  if (!code) { codeStatus = { kind: "warn", text: "Escribe o pega el código antes de guardar." }; return render(); }
  codeStatus = { kind: "", text: "Comprobando…" };
  render();
  try {
    const res = await fetch(`${API}/check`, { headers: { "X-Access-Code": code } });
    codeStatus = res.ok
      ? { kind: "ok", text: "Código correcto. La IA ya puede proponer los cuidados de tus plantas." }
      : { kind: "warn", text: "Código incorrecto. Revisa que esté completo, sin espacios." };
  } catch {
    codeStatus = { kind: "warn", text: "Guardado, pero no se ha podido comprobar: sin conexión." };
  }
  render();
}

// ---------- Actions ----------
function addLog(plantId, type, note = "") {
  state.data.log.push({ id: uid(), plantId, type, date: localToday(), time: new Date().toTimeString().slice(0, 5), note });
  save();
}

const actions = {
  "new-plant": newPlantWizard,
  "wiz-back": () => { wiz.step = 1; renderWizard(); },
  "wiz-alt": (d) => { wiz.query = altQuery(wiz.care.alternatives[+d.i]); wizLookup(); },
  "wiz-zone": (d) => { wiz.zone = d.zone; wiz.newZone = false; if (!wiz.touched.autoWater) wiz.autoWater = autoZones().includes(d.zone); renderWizard(); },
  "wiz-new-zone": () => { wiz.newZone = true; wiz.zone = ""; renderWizard(); },
  "wiz-set": (d) => {
    wiz[d.key] = d.key === "frostSensitive" || d.key === "autoWater" ? !wiz[d.key] : d.value === "true";
    wiz.touched[d.key] = true;
    renderWizard();
  },
  "wiz-save": wizSave,
  "wiz-notes": () => { wiz.notesOpen = !wiz.notesOpen; renderWizard(); },
  "edit-plant": (d) => plantForm(d.id),
  "open-plant": (d) => { if (confirmDiscard()) plantSheet(d.id); },
  close: leaveSheet,
  "retry-weather": loadWeather,
  "open-place": placeSheet,
  "open-ai": () => aiSheet(),
  "open-upgrades": () => upgradesSheet(),
  "open-usage": () => { usage = null; usageSheet(); loadUsage(); },
  noop: () => {},
  log: (d) => {
    let note = "";
    if (d.type === "note" || d.type === "treat") {
      note = prompt(d.type === "note" ? "Nota" : "¿Qué tratamiento? (opcional)") ?? null;
      if (note === null || (d.type === "note" && !note.trim())) return;
    }
    addLog(d.id, d.type, note.trim());
    if (d.type === "water") track("water_done");
    if (d.type === "feed") track("feed_done");
    render();
    if (d.reopen) plantSheet(d.id);
  },
  "skip-rain": (d) => { addLog(d.id, "water", "Lluvia"); track("water_skip_rain"); render(); },
  "undo-log": (d) => { state.data.log = state.data.log.filter((e) => e.id !== d.log); save(); render(); },
  "task-toggle": (d) => {
    if (d.refs) return toggleTasks(d.refs.split(","));
    const p = plantById(d.id);
    const task = p?.yearTasks?.[+d.i];
    if (!task) return;
    const ref = `${p.id}:${d.i}`;
    const w = taskWindow(task.months, localToday());
    const doneLogs = state.data.log.filter((e) => e.type === "task" && e.ref === ref && w && e.date >= w.start);
    if (doneLogs.length) state.data.log = state.data.log.filter((e) => !doneLogs.includes(e));
    else { state.data.log.push({ id: uid(), plantId: p.id, type: "task", ref, date: localToday(), time: new Date().toTimeString().slice(0, 5), note: task.title }); track("task_done"); }
    save();
    render();
    if (d.reopen) plantSheet(p.id);
  },
  "zone-auto": (d) => {
    const on = !autoZones().includes(d.zone);
    state.data.autoZones = on ? [...autoZones(), d.zone] : autoZones().filter((z) => z !== d.zone);
    for (const p of state.data.plants) if ((p.zone || "") === d.zone) p.autoWater = on;
    save();
    render();
  },
  "toggle-week-tasks": () => { weekAll = !weekAll; render(); },
  "toggle-done": () => { doneOpen = !doneOpen; render(); },
  "toggle-week": () => { weekOpen = !weekOpen; render(); },
  "del-log": (d) => {
    state.data.log = state.data.log.filter((e) => e.id !== d.log);
    save(); render(); plantSheet(d.id);
  },
  "del-plant": (d) => {
    const p = plantById(d.id);
    if (!confirm(`¿Eliminar «${p.name}» y todo su historial?`)) return;
    formDirty = false;
    state.data.plants = state.data.plants.filter((x) => x.id !== d.id);
    state.data.log = state.data.log.filter((e) => e.plantId !== d.id);
    save(); closeSheet(); render();
  },
  locate: () => {
    if (!navigator.geolocation) return alert("Este navegador no permite obtener la ubicación.");
    navigator.geolocation.getCurrentPosition(
      (pos) => setLoc({ name: "Mi ubicación", lat: +pos.coords.latitude.toFixed(3), lon: +pos.coords.longitude.toFixed(3) }),
      () => alert("No se ha podido obtener tu ubicación. Busca tu ciudad."),
      { timeout: 10000, maximumAge: 3600000 },
    );
  },
  "pick-place": (d) => {
    const r = JSON.parse($("placeResults").dataset.results)[+d.i];
    setLoc({ name: r.name, lat: r.lat, lon: r.lon });
  },
  "export-ics": () => download("mi-jardin.ics", buildICS(state.data.plants, state.data.log, localToday(), here().lat), "text/calendar"),
  "export-json": () => download(`mi-jardin-${localToday()}.json`, JSON.stringify(state.data), "application/json"),
  "import-json": () => $("importFile").click(),
  "ai-fill": () => aiFill(),
  "edit-zone": (d, el) => {
    $("editZone").value = d.zone;
    $("editZone").hidden = true;
    $("zoneChips").querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === el));
    formDirty = true;
  },
  "edit-new-zone": (d, el) => {
    $("editZone").value = "";
    $("editZone").hidden = false;
    $("zoneChips").querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === el));
    $("editZone").focus();
    formDirty = true;
  },
  "edit-alt": (d) => aiFill(altQuery(JSON.parse($("plantForm").dataset.alternatives)[+d.i])),
  "upgrade-plants": () => { if (!upgrade?.running) upgradePlants(); },
  "upgrade-later": () => { store.set("mj_upgrade_later", CARE_VERSION); render(); },
  "upgrade-close": () => { upgrade = null; render(); },
};

document.addEventListener("click", (e) => {
  const tab = e.target.closest(".tabbar button");
  if (tab) { state.tab = tab.dataset.tab; store.set("mj_tab", state.tab); render(); return; }
  if (e.target.closest("#placeBtn")) return placeSheet();
  const el = e.target.closest("[data-action]");
  if (el && actions[el.dataset.action]) { e.preventDefault(); actions[el.dataset.action](el.dataset, el); }
});

document.addEventListener("input", (e) => {
  if (e.target.classList?.contains("autogrow")) autogrow(e.target);
  if (e.target.closest("#plantForm")) formDirty = true;
  e.target.closest(".st-cell")?.classList.remove("ai");
  if (!wiz) return;
  if (e.target.id === "wizZone") wiz.zone = e.target.value;
  const { season, kind } = e.target.dataset ?? {};
  if (season && kind) {
    wiz.seasons[season][kind] = Math.max(kind === "water" ? 1 : 0, parseInt(e.target.value, 10) || 0);
    wiz.touched[`${season}.${kind}`] = true;
  }
});

document.addEventListener("change", async (e) => {
  if (e.target.closest("#plantForm")) formDirty = true;
  if (e.target.id === "photoInput" && e.target.files[0]) {
    draftPhoto = await shrinkPhoto(e.target.files[0]).catch(() => null);
    if (draftPhoto) $("photoPreview").innerHTML = `<img class="thumb" src="${draftPhoto}" alt="" />`;
  }
  if (e.target.id === "importFile" && e.target.files[0]) {
    try {
      const data = JSON.parse(await e.target.files[0].text());
      if (!Array.isArray(data.plants) || !Array.isArray(data.log)) throw new Error("formato");
      if (!confirm(`Importar ${data.plants.length} plantas? Sustituye lo que hay ahora en este dispositivo.`)) return;
      state.data = data; save(); render();
    } catch { alert("Ese archivo no es una copia de Mi Jardín."); }
    e.target.value = "";
  }
});

document.addEventListener("submit", (e) => {
  if (e.target.id === "aiCodeForm") {
    e.preventDefault();
    saveCode(new FormData(e.target).get("code").trim());
    return;
  }
  if (e.target.id === "wizName") {
    e.preventDefault();
    const name = new FormData(e.target).get("name").trim();
    if (!name) return;
    const changed = name !== wiz.name;
    wiz.name = name;
    if (changed) wiz.query = null;
    wiz.step = 2;
    if (changed || wiz.ai === "error" || wiz.ai === "notplant") {
      wiz.care = null;
      if (hasAI() || aiOpen === null) return wizLookup();
      wiz.ai = "idle";
    }
    renderWizard();
    return;
  }
  if (e.target.id !== "plantForm") return;
  formDirty = false;
  e.preventDefault();
  const f = new FormData(e.target);
  const id = e.target.dataset.id;
  const fields = {
    name: f.get("name").trim(),
    species: f.get("species").trim(),
    zone: f.get("zone").trim(),
    seasons: readSeasonTable(f),
    rainReaches: f.get("rainReaches") === "true",
    inPot: f.get("inPot") === "true",
    frostSensitive: f.has("frostSensitive"),
    autoWater: f.has("autoWater"),
    notes: f.get("notes").trim(),
    photo: draftPhoto,
  };
  withCurrentIntervals(fields);
  if (e.target.dataset.aiFilled) fields.careVersion = Math.max(3, Math.min(careVersionOf(plantById(id) ?? {}), CARE_VERSION));
  if (e.target.dataset.aiSnapshot) fields.ai = JSON.parse(e.target.dataset.aiSnapshot);
  if (e.target.dataset.tips && e.target.dataset.tips !== "null") fields.tips = JSON.parse(e.target.dataset.tips);
  if (e.target.dataset.feedTypes && e.target.dataset.feedTypes !== "null") fields.feedTypes = JSON.parse(e.target.dataset.feedTypes);
  if (id) Object.assign(plantById(id), fields);
  else state.data.plants.push({ id: uid(), created: localToday(), ...fields });
  save();
  render();
  const savedId = id || state.data.plants.at(-1).id;
  plantSheet(savedId);
  if (e.target.dataset.aiFilled) fetchCalendarFor(savedId);
});

// ---------- Usage (anonymous counts) ----------
// Event names only (no plant names, notes or location) plus a random id per install, batched and
// sent to the Worker on start, after a few seconds of activity and when the app goes to the
// background. See «Uso de la app» in Ajustes (only with the access code).
const deviceId = store.get("mj_device", null) ?? (() => { const id = crypto.randomUUID(); store.set("mj_device", id); return id; })();
let eventQueue = store.get("mj_events", []);
let flushTimer = null;
function track(name) {
  if (aiCode()) return; // Noza's own device (has the access code): not counted
  eventQueue.push(name);
  store.set("mj_events", eventQueue);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushEvents, 5000);
}
function flushEvents() {
  if (!eventQueue.length) return;
  const batch = eventQueue.splice(0, 50);
  store.set("mj_events", eventQueue);
  // text/plain keeps it a "simple" request (no CORS preflight); keepalive lets it finish on close.
  fetch(`${API}/event`, { method: "POST", keepalive: true, headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ device: deviceId, events: batch }) })
    .catch(() => { eventQueue = batch.concat(eventQueue); store.set("mj_events", eventQueue); });
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushEvents(); });

// ---------- Start ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
render();
loadWeather();
// One «open» per half hour at most, so switching apps back and forth doesn't inflate it.
if (Date.now() - store.get("mj_last_open", 0) > 30 * 60000) { store.set("mj_last_open", Date.now()); track("app_open"); }
setTimeout(flushEvents, 1500);
