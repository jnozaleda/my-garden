// Mi Jardín — plant inventory, care log and weather-aware reminders. Plain template strings,
// data in localStorage (phase 1: this device only). Actions are wired by data-action attributes.

import { fetchWeather, searchCities, weatherIcon } from "./weather.js";
import { CARE, dueTasks, weatherAlerts, nextDue, daysBetween } from "./rules.js";
import { buildICS } from "./calendar.js";

const DEFAULT_LOC = { name: "Madrid", lat: 40.4168, lon: -3.7038 };
// Backend (MiJardin/worker): fills a plant's care sheet with AI. Needs the access code from Ajustes.
const API = "https://my-garden-api.tempcheck-app.workers.dev";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
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

function forecastCard() {
  if (state.weatherError) return `<section class="card"><h2>El tiempo</h2><p class="muted">No se ha podido cargar la previsión.</p><div class="row" style="margin-top:10px"><button class="btn small secondary" data-action="retry-weather">Reintentar</button></div></section>`;
  if (!state.weather) return `<section class="card"><h2>El tiempo</h2><p class="muted">Cargando previsión…</p></section>`;
  const { days, today } = state.weather;
  const cells = days.slice(today, today + 7).map((d, i) => `
    <div class="${i === 0 ? "today" : ""}">
      <span>${i === 0 ? "Hoy" : fmtDate(d.date, { weekday: "short" }).replace(".", "")}</span>
      <span class="ico">${weatherIcon(d.code)}</span>
      <span class="hi">${Math.round(d.max)}°</span>
      <span>${Math.round(d.min)}°</span>
      <span class="rain">${d.rain >= 1 ? `${Math.round(d.rain)}mm` : ""}</span>
    </div>`).join("");
  return `<section class="card"><h2>El tiempo · 7 días</h2><div class="forecast">${cells}</div></section>`;
}

// ---------- Views ----------
function thumb(plant, cls = "thumb") {
  return plant.photo ? `<img class="${cls}" src="${plant.photo}" alt="" />` : `<span class="${cls}">🪴</span>`;
}

function emptyGarden() {
  return `<section class="card empty"><div class="big">🌱</div><p class="muted">Aún no tienes plantas. Añade la primera y te diremos cuándo regarla, abonarla y cuándo el tiempo cambia el plan.</p><button class="btn" data-action="new-plant">Añadir planta</button></section>`;
}

function todayView() {
  const today = localToday();
  const { plants, log } = state.data;
  let html = forecastCard();
  if (state.weather) {
    const alerts = weatherAlerts(plants, state.weather, today);
    html += alerts.length
      ? alerts.map((a) => `<div class="alert ${a.level}"><span class="ico">${a.icon}</span><div><strong>${esc(a.title)}</strong><span class="muted">${esc(a.text)}</span></div></div>`).join("")
      : `<div class="alert ok"><span class="ico">✅</span><div><strong>Sin avisos del tiempo</strong><span class="muted">Ni heladas, ni calor extremo, ni viento fuerte en los próximos días.</span></div></div>`;
  }
  if (!plants.length) return html + emptyGarden();

  const tasks = dueTasks(plants, log, state.weather, today);
  const rows = tasks.map((t) => `
    <div class="task">
      ${thumb(t.plant)}
      <div class="body">
        <div class="title">${CARE[t.type].icon} ${CARE[t.type].label} ${esc(t.plant.name)}</div>
        <div class="when ${t.days < 0 ? "late" : ""}">${relDue(t.days)}${t.plant.zone ? ` · ${esc(t.plant.zone)}` : ""}</div>
        ${t.advice ? `<div class="advice ${t.advice.kind}">${esc(t.advice.text)}</div>` : ""}
      </div>
      ${t.advice?.kind === "skip"
        ? `<button class="btn small secondary" data-action="skip-rain" data-id="${t.plant.id}">Saltar</button>`
        : `<button class="btn small" data-action="log" data-type="${t.type}" data-id="${t.plant.id}">Hecho</button>`}
    </div>`).join("");
  html += `<section class="card"><h2>Tareas</h2>${rows || `<p class="muted">Nada pendiente para hoy ni mañana. 🌿</p>`}</section>`;
  return html;
}

function plantsView() {
  const { plants, log } = state.data;
  if (!plants.length) return emptyGarden();
  const today = localToday();
  const zones = [...new Set(plants.map((p) => p.zone || "Sin zona"))].sort((a, b) => a.localeCompare(b, "es"));
  let html = "";
  for (const zone of zones) {
    const list = plants.filter((p) => (p.zone || "Sin zona") === zone).sort((a, b) => a.name.localeCompare(b.name, "es"));
    html += `<div class="zone-title">${esc(zone)} · ${list.length}</div><section class="card">` + list.map((p) => {
      const due = nextDue(p, log, "water");
      const meta = [p.species, due ? `regar: ${relDue(daysBetween(today, due)).toLowerCase()}` : null].filter(Boolean).join(" · ");
      return `<button class="plant" data-action="open-plant" data-id="${p.id}">${thumb(p)}<div class="body"><div class="name">${esc(p.name)}</div><div class="meta">${esc(meta)}</div></div><span class="muted">›</span></button>`;
    }).join("") + `</section>`;
  }
  return html;
}

function moreView() {
  const loc = state.loc ?? DEFAULT_LOC;
  const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  return `
    <section class="card"><h2>Ubicación</h2>
      <p class="muted">La previsión y los avisos son para <strong>${esc(loc.name)}</strong>.</p>
      <div class="row" style="margin-top:10px"><button class="btn small" data-action="locate">📍 Usar mi ubicación</button><button class="btn small secondary" data-action="open-place">Buscar ciudad</button></div>
    </section>
    <section class="card"><h2>Asistente IA</h2>
      <p class="muted">${store.get("mj_ai_code", "") && codeStatus?.kind !== "warn"
        ? "Activado: al añadir una planta, pulsa ✨ Rellenar con IA y propondrá sus cuidados."
        : "Escribe tu código de acceso para que ✨ Rellenar con IA proponga los cuidados de cada planta."}</p>
      <form id="aiCodeForm" class="row" style="margin-top:10px">
        <input type="text" name="code" class="code-input" placeholder="Código de acceso" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(store.get("mj_ai_code", ""))}" />
        <button class="btn small" type="submit">Guardar</button>
      </form>
      ${codeStatus ? `<p class="ai-status ${codeStatus.kind}" style="margin-top:10px">${esc(codeStatus.text)}</p>` : ""}
    </section>
    <section class="card"><h2>Calendario</h2>
      <p class="muted">Añade los riegos y abonados a tu calendario (Apple, Google u Outlook) como eventos que se repiten. Si cambias los intervalos o registras cuidados, vuelve a exportarlo.</p>
      <div class="row" style="margin-top:10px"><button class="btn small" data-action="export-ics" ${state.data.plants.length ? "" : "disabled"}>📅 Exportar al calendario</button></div>
    </section>
    <section class="card"><h2>Notificaciones</h2>
      <p class="muted">${isStandalone
        ? "El aviso diario de las 8:00 (heladas, lluvia, calor, viento y tareas) llega en la próxima fase."
        : "Para recibir avisos en el iPhone, instala la app: pulsa Compartir → «Añadir a pantalla de inicio». El aviso diario llega en la próxima fase."}</p>
    </section>
    <section class="card"><h2>Copia de seguridad</h2>
      <p class="muted">Tus plantas se guardan solo en este dispositivo. Exporta una copia de vez en cuando.</p>
      <div class="row" style="margin-top:10px"><button class="btn small secondary" data-action="export-json">Exportar copia</button><button class="btn small secondary" data-action="import-json">Importar copia</button></div>
      <input type="file" id="importFile" accept="application/json" hidden />
    </section>`;
}

function render() {
  const loc = state.loc ?? DEFAULT_LOC;
  $("placeBtn").textContent = `📍 ${loc.name}`;
  document.querySelectorAll(".tabbar button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === state.tab)));
  $("fab").hidden = state.tab === "more";
  $("main").innerHTML = state.tab === "plants" ? plantsView() : state.tab === "more" ? moreView() : todayView();
}

// ---------- Sheets ----------
const sheet = $("sheet");
function openSheet(html) {
  sheet.innerHTML = `<div class="sheet-in">${html}</div>`;
  if (!sheet.open) sheet.showModal();
}
function closeSheet() { sheet.close(); }
sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); });

function plantSheet(id) {
  const p = plantById(id);
  if (!p) return closeSheet();
  const today = localToday();
  const log = state.data.log.filter((e) => e.plantId === id).sort((a, b) => b.date.localeCompare(a.date));
  const nexts = ["water", "feed"].map((type) => {
    const due = nextDue(p, state.data.log, type);
    return due ? `${CARE[type].icon} ${CARE[type].label}: <strong>${relDue(daysBetween(today, due)).toLowerCase()}</strong> (${fmtDate(due)})` : null;
  }).filter(Boolean);
  const traits = [
    p.inPot ? "En maceta" : "En suelo",
    p.rainReaches ? "le llega la lluvia" : "a cubierto",
    p.frostSensitive ? "sensible a heladas" : null,
  ].filter(Boolean).join(" · ");
  openSheet(`
    <div class="sheet-head"><h2>${esc(p.name)}</h2><button class="btn small secondary" data-action="close">Cerrar</button></div>
    ${p.photo ? `<img class="hero-photo" src="${p.photo}" alt="" />` : ""}
    <p class="muted">${esc([p.species, p.zone].filter(Boolean).join(" · "))}${p.species || p.zone ? "<br>" : ""}${esc(traits)}</p>
    ${nexts.length ? `<section class="card"><p class="muted" style="line-height:1.8">${nexts.join("<br>")}</p></section>` : ""}
    <section class="card"><h2>Registrar</h2><div class="chips">
      ${Object.entries(CARE).map(([type, c]) => `<button class="chip" data-action="log" data-type="${type}" data-id="${p.id}" data-reopen="1">${c.icon} ${c.done}</button>`).join("")}
    </div></section>
    ${p.notes ? `<section class="card"><h2>Notas</h2><p class="muted">${esc(p.notes).replace(/\n/g, "<br>")}</p></section>` : ""}
    <section class="card"><h2>Historial</h2>${log.length ? `<ul class="log">${log.map((e) => `
      <li><span class="d">${fmtDate(e.date)}</span><span>${CARE[e.type]?.icon ?? ""} ${esc(CARE[e.type]?.done ?? e.type)}${e.note ? ` — ${esc(e.note)}` : ""}</span>
      <button class="x" data-action="del-log" data-log="${e.id}" data-id="${p.id}" aria-label="Borrar">✕</button></li>`).join("")}</ul>` : `<p class="muted">Sin registros todavía.</p>`}</section>
    <div class="row"><button class="btn secondary" data-action="edit-plant" data-id="${p.id}">Editar</button><button class="btn danger" data-action="del-plant" data-id="${p.id}">Eliminar</button></div>`);
}

let draftPhoto = null;
function plantForm(id) {
  const p = id ? plantById(id) : { name: "", species: "", zone: "", waterEvery: 3, feedEvery: 30, rainReaches: true, inPot: true, frostSensitive: false, notes: "" };
  draftPhoto = p.photo ?? null;
  const zones = [...new Set(state.data.plants.map((x) => x.zone).filter(Boolean))];
  openSheet(`
    <div class="sheet-head"><h2>${id ? "Editar planta" : "Nueva planta"}</h2><button class="btn small secondary" data-action="${id ? "open-plant" : "close"}" data-id="${id ?? ""}">Cancelar</button></div>
    <form id="plantForm" class="sheet-in" style="padding:0">
      <div class="photo-pick"><span id="photoPreview">${draftPhoto ? `<img src="${draftPhoto}" alt="" />` : `<span class="thumb">📷</span>`}</span>
        <label class="btn small secondary">Foto<input type="file" id="photoInput" accept="image/*" hidden /></label></div>
      <label class="field">Nombre<input name="name" required placeholder="Limonero del patio" value="${esc(p.name)}" /></label>
      <button type="button" class="btn secondary" data-action="ai-fill">✨ Rellenar con IA</button>
      <p class="ai-status" id="aiStatus" hidden></p>
      <label class="field">Especie (opcional)<input name="species" placeholder="Citrus limon" value="${esc(p.species)}" /></label>
      <label class="field">Zona<input name="zone" list="zoneList" placeholder="Terraza sur" value="${esc(p.zone)}" /><datalist id="zoneList">${zones.map((z) => `<option value="${esc(z)}">`).join("")}</datalist></label>
      <div class="two">
        <label class="field">Regar cada (días)<input name="waterEvery" type="number" min="0" max="90" inputmode="numeric" value="${p.waterEvery || ""}" /></label>
        <label class="field">Abonar cada (días)<input name="feedEvery" type="number" min="0" max="365" inputmode="numeric" value="${p.feedEvery || ""}" /></label>
      </div>
      <label class="check"><input type="checkbox" name="rainReaches" ${p.rainReaches ? "checked" : ""} /><span>Le llega la lluvia<small>Si llueve, te diremos que no hace falta regar.</small></span></label>
      <label class="check"><input type="checkbox" name="inPot" ${p.inPot ? "checked" : ""} /><span>Está en maceta<small>Se seca antes con calor y sufre con el viento.</small></span></label>
      <label class="check"><input type="checkbox" name="frostSensitive" ${p.frostSensitive ? "checked" : ""} /><span>Sensible a heladas<small>Te avisaremos para protegerla.</small></span></label>
      <label class="field">Notas<textarea name="notes" class="autogrow" rows="6" placeholder="Comprada en marzo, le gusta el sol de mañana…">${esc(p.notes)}</textarea></label>
      <button class="btn block" type="submit">Guardar</button>
    </form>`);
  $("plantForm").dataset.id = id ?? "";
  autogrow($("plantForm").elements.notes);
}

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
};

// Resolves to the care sheet, or throws an Error whose message is a key of AI_ERRORS
// ("code", "limit") or "timeout" / "network" / "ai".
async function requestCare(name) {
  const code = store.get("mj_ai_code", "");
  if (!code) throw new Error("code");
  const loc = state.loc ?? DEFAULT_LOC;
  let res;
  try {
    res = await fetch(`${API}/care`, {
      method: "POST",
      signal: AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/json", "X-Access-Code": code },
      body: JSON.stringify({ name, lat: loc.lat, lon: loc.lon, place: loc.name, month: new Date().getMonth() + 1 }),
    });
  } catch (err) {
    throw new Error(err?.name === "TimeoutError" ? "timeout" : "network");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error in AI_ERRORS ? body.error : "ai");
  return body;
}

const aiErrorText = (key) => AI_ERRORS[key] ?? {
  timeout: "El asistente está tardando demasiado. Vuelve a intentarlo en un rato o rellénalo a mano.",
  network: "Sin conexión con el asistente. Rellénalo a mano.",
}[key] ?? "El asistente no está disponible ahora. Rellénalo a mano.";

async function aiFill() {
  const form = $("plantForm");
  const status = $("aiStatus");
  const show = (text, kind = "") => { status.hidden = false; status.className = `ai-status ${kind}`; status.textContent = text; };
  const name = form.elements.name.value.trim();
  if (!name) { form.elements.name.focus(); return show("Escribe primero el nombre de la planta.", "warn"); }
  if (!store.get("mj_ai_code", "")) return show(AI_ERRORS.code, "warn");

  const btn = form.querySelector('[data-action="ai-fill"]');
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  btn.innerHTML = `<span class="spinner" aria-hidden="true"></span> Preparando la ficha…`;
  show(`Buscando los cuidados de «${name}». Tarda unos segundos.`);
  const loc = state.loc ?? DEFAULT_LOC;
  try {
    const care = await requestCare(name);
    const f = form.elements;
    f.species.value = care.species;
    f.waterEvery.value = care.waterEvery;
    f.feedEvery.value = care.feedEvery || "";
    f.frostSensitive.checked = care.frostSensitive;
    if (!f.notes.value.trim()) f.notes.value = care.notes;
    autogrow(f.notes);
    show(care.confidence === "baja"
      ? `⚠️ No está seguro de qué planta es «${name}». Revisa los datos o prueba con otro nombre.`
      : `✨ Propuesta para ${care.commonName} en ${loc.name} este mes. Revisa y guarda.`, care.confidence === "baja" ? "warn" : "ok");
  } catch (err) {
    show(aiErrorText(err.message), "warn");
  } finally {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    btn.innerHTML = label;
  }
}

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
    species: "", waterEvery: 3, feedEvery: 30, frostSensitive: false, notes: "", newZone: false,
  };
  renderWizard();
}

function renderWizard() {
  if (!wiz) return;
  const head = (right) => `<div class="sheet-head"><h2>Nueva planta</h2><div class="row"><span class="muted">${wiz.step} de 2</span>${right}</div></div>`;
  if (wiz.step === 1) {
    const hasCode = Boolean(store.get("mj_ai_code", ""));
    openSheet(`
      ${head(`<button class="btn small secondary" data-action="close">Cancelar</button>`)}
      <form id="wizName" class="sheet-in" style="padding:0">
        <h3 class="q">¿Qué planta es?</h3>
        <input name="name" class="big-input" required placeholder="Olivo, limonero, geranio…" autocomplete="off" value="${esc(wiz.name)}" />
        <div class="photo-pick"><span id="photoPreview">${draftPhoto ? `<img src="${draftPhoto}" alt="" />` : `<span class="thumb">📷</span>`}</span>
          <label class="btn small secondary">Añadir foto<input type="file" id="photoInput" accept="image/*" hidden /></label></div>
        <p class="muted">${hasCode ? "✨ Con el nombre, la IA propondrá sus cuidados para tu zona y este mes." : "Activa el asistente IA en Ajustes para que proponga los cuidados."}</p>
        <button class="btn block" type="submit">Siguiente</button>
      </form>`);
    setTimeout(() => $("wizName")?.elements.name.focus(), 50);
    return;
  }
  const zones = [...new Set([...state.data.plants.map((p) => p.zone), wiz.zone].filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));
  // While the AI is answering, the fields it fills (and Guardar) wait; the place choices stay free.
  const busy = wiz.ai === "loading";
  const lock = busy ? "disabled" : "";
  const choice = (key, value, icon, label, locked = "") =>
    `<button type="button" class="choice ${wiz[key] === value ? "on" : ""}" data-action="wiz-set" data-key="${key}" data-value="${value}" aria-pressed="${wiz[key] === value}" ${locked}><span class="ico">${icon}</span>${label}</button>`;
  const aiCard = {
    loading: `<span class="spinner" aria-hidden="true"></span><span class="muted">Buscando los cuidados de «${esc(wiz.name)}»…</span>`,
    done: `<span class="muted">${esc([wiz.species, `regar cada ${wiz.waterEvery} d`, wiz.feedEvery ? `abonar cada ${wiz.feedEvery} d` : "sin abonar ahora"].filter(Boolean).join(" · "))}</span>`,
    error: `<span class="muted">${esc(wiz.aiError)}</span>`,
    idle: `<span class="muted">Cuidados a mano: ajústalos abajo.</span>`,
  }[wiz.ai];
  openSheet(`
    ${head(`<button class="btn small secondary" data-action="wiz-back">Atrás</button>`)}
    <section class="card ai-card ${wiz.ai}" id="wizStep2">
      ${draftPhoto ? `<img class="thumb" src="${draftPhoto}" alt="" />` : `<span class="thumb">🪴</span>`}
      <div class="body"><div class="name">${esc(wiz.name)} ${wiz.ai === "done" ? "✨" : ""}</div>${aiCard}</div>
    </section>
    ${wiz.care?.confidence === "baja" ? `<p class="ai-status warn">⚠️ La IA no está segura de qué planta es. Revisa los días o vuelve atrás y prueba con otro nombre.</p>` : ""}
    <h3 class="q">¿Dónde está?</h3>
    <div class="chips">
      ${zones.map((z) => `<button type="button" class="chip ${!wiz.newZone && wiz.zone === z ? "on" : ""}" data-action="wiz-zone" data-zone="${esc(z)}">${esc(z)}</button>`).join("")}
      <button type="button" class="chip ${wiz.newZone ? "on" : ""}" data-action="wiz-new-zone">+ Nueva zona</button>
    </div>
    ${wiz.newZone ? `<input id="wizZone" class="big-input" placeholder="Terraza sur, jardín delantero…" autocomplete="off" value="${esc(wiz.zone)}" />` : ""}
    <div class="choices">${choice("inPot", true, "🪴", "Maceta")}${choice("inPot", false, "🌱", "Suelo")}</div>
    <div class="choices">${choice("rainReaches", true, "🌧️", "Le llueve")}${choice("rainReaches", false, "☂️", "A cubierto")}</div>
    <div class="choices one">${choice("frostSensitive", true, "❄️", `Sensible a heladas: ${busy ? "…" : wiz.frostSensitive ? "sí" : "no"}`, lock)}</div>
    <div class="two">
      <label class="field">Regar cada (días)<input id="wizWater" type="number" min="0" max="90" inputmode="numeric" value="${busy ? "" : wiz.waterEvery || ""}" placeholder="${busy ? "…" : ""}" ${lock} /></label>
      <label class="field">Abonar cada (días)<input id="wizFeed" type="number" min="0" max="365" inputmode="numeric" value="${busy ? "" : wiz.feedEvery || ""}" placeholder="${busy ? "…" : ""}" ${lock} /></label>
    </div>
    ${store.get("mj_last_place", null) ? `<p class="muted small">Zona y opciones como en la última planta que añadiste.</p>` : ""}
    ${busy
      ? `<button class="btn block" data-action="wiz-save" disabled aria-busy="true"><span class="spinner" aria-hidden="true"></span> Esperando a la IA…</button>`
      : `<button class="btn block" data-action="wiz-save">Guardar planta</button>`}`);
  if (wiz.newZone) setTimeout(() => $("wizZone")?.focus(), 50);
}

async function wizLookup() {
  const current = wiz;
  current.ai = "loading";
  renderWizard();
  try {
    const care = await requestCare(current.name);
    current.care = care;
    current.ai = "done";
    current.species = care.species;
    if (!current.touched.waterEvery) current.waterEvery = care.waterEvery;
    if (!current.touched.feedEvery) current.feedEvery = care.feedEvery;
    if (!current.touched.frostSensitive) current.frostSensitive = care.frostSensitive;
    current.notes = care.notes;
  } catch (err) {
    current.ai = "error";
    current.aiError = aiErrorText(err.message);
  }
  // Redraw only if this draft's step 2 is still what the sheet shows.
  if (wiz === current && $("wizStep2")) renderWizard();
}

function wizSave() {
  if (wiz.ai === "loading") return;
  const zone = wiz.zone.trim();
  const plant = {
    id: uid(), created: localToday(), name: wiz.name, species: wiz.species, zone,
    waterEvery: wiz.waterEvery, feedEvery: wiz.feedEvery, rainReaches: wiz.rainReaches, inPot: wiz.inPot,
    frostSensitive: wiz.frostSensitive, notes: wiz.notes, photo: draftPhoto,
  };
  store.set("mj_last_place", { zone, inPot: wiz.inPot, rainReaches: wiz.rainReaches });
  state.data.plants.push(plant);
  save();
  render();
  plantSheet(plant.id);
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
      ? { kind: "ok", text: "✅ Código correcto. Ya puedes usar ✨ Rellenar con IA." }
      : { kind: "warn", text: "❌ Código incorrecto. Revisa que esté completo, sin espacios." };
  } catch {
    codeStatus = { kind: "warn", text: "Guardado, pero no se ha podido comprobar: sin conexión." };
  }
  render();
}

// ---------- Actions ----------
function addLog(plantId, type, note = "") {
  state.data.log.push({ id: uid(), plantId, type, date: localToday(), note });
  save();
}

const actions = {
  "new-plant": newPlantWizard,
  "wiz-back": () => { wiz.step = 1; renderWizard(); },
  "wiz-zone": (d) => { wiz.zone = d.zone; wiz.newZone = false; renderWizard(); },
  "wiz-new-zone": () => { wiz.newZone = true; wiz.zone = ""; renderWizard(); },
  "wiz-set": (d) => {
    wiz[d.key] = d.key === "frostSensitive" ? !wiz.frostSensitive : d.value === "true";
    wiz.touched[d.key] = true;
    renderWizard();
  },
  "wiz-save": wizSave,
  "edit-plant": (d) => plantForm(d.id),
  "open-plant": (d) => plantSheet(d.id),
  close: closeSheet,
  "retry-weather": loadWeather,
  "open-place": placeSheet,
  log: (d) => {
    let note = "";
    if (d.type === "note" || d.type === "treat") {
      note = prompt(d.type === "note" ? "Nota" : "¿Qué tratamiento? (opcional)") ?? null;
      if (note === null || (d.type === "note" && !note.trim())) return;
    }
    addLog(d.id, d.type, note.trim());
    render();
    if (d.reopen) plantSheet(d.id);
  },
  "skip-rain": (d) => { addLog(d.id, "water", "Lluvia"); render(); },
  "del-log": (d) => {
    state.data.log = state.data.log.filter((e) => e.id !== d.log);
    save(); render(); plantSheet(d.id);
  },
  "del-plant": (d) => {
    const p = plantById(d.id);
    if (!confirm(`¿Eliminar «${p.name}» y todo su historial?`)) return;
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
  "export-ics": () => download("mi-jardin.ics", buildICS(state.data.plants, state.data.log, localToday()), "text/calendar"),
  "export-json": () => download(`mi-jardin-${localToday()}.json`, JSON.stringify(state.data), "application/json"),
  "import-json": () => $("importFile").click(),
  "ai-fill": aiFill,
};

document.addEventListener("click", (e) => {
  const tab = e.target.closest(".tabbar button");
  if (tab) { state.tab = tab.dataset.tab; store.set("mj_tab", state.tab); render(); return; }
  if (e.target.closest("#placeBtn")) return placeSheet();
  const el = e.target.closest("[data-action]");
  if (el && actions[el.dataset.action]) { e.preventDefault(); actions[el.dataset.action](el.dataset); }
});

document.addEventListener("input", (e) => {
  if (e.target.classList?.contains("autogrow")) autogrow(e.target);
  if (!wiz) return;
  if (e.target.id === "wizZone") wiz.zone = e.target.value;
  if (e.target.id === "wizWater") { wiz.waterEvery = Math.max(0, parseInt(e.target.value, 10) || 0); wiz.touched.waterEvery = true; }
  if (e.target.id === "wizFeed") { wiz.feedEvery = Math.max(0, parseInt(e.target.value, 10) || 0); wiz.touched.feedEvery = true; }
});

document.addEventListener("change", async (e) => {
  if (e.target.id === "photoInput" && e.target.files[0]) {
    draftPhoto = await shrinkPhoto(e.target.files[0]).catch(() => null);
    if (draftPhoto) $("photoPreview").innerHTML = `<img src="${draftPhoto}" alt="" />`;
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
    wiz.step = 2;
    if (changed || wiz.ai === "error") {
      wiz.care = null;
      if (store.get("mj_ai_code", "")) return wizLookup();
      wiz.ai = "idle";
    }
    renderWizard();
    return;
  }
  if (e.target.id !== "plantForm") return;
  e.preventDefault();
  const f = new FormData(e.target);
  const id = e.target.dataset.id;
  const fields = {
    name: f.get("name").trim(),
    species: f.get("species").trim(),
    zone: f.get("zone").trim(),
    waterEvery: Math.max(0, parseInt(f.get("waterEvery"), 10) || 0),
    feedEvery: Math.max(0, parseInt(f.get("feedEvery"), 10) || 0),
    rainReaches: f.has("rainReaches"),
    inPot: f.has("inPot"),
    frostSensitive: f.has("frostSensitive"),
    notes: f.get("notes").trim(),
    photo: draftPhoto,
  };
  if (id) Object.assign(plantById(id), fields);
  else state.data.plants.push({ id: uid(), created: localToday(), ...fields });
  save();
  render();
  plantSheet(id || state.data.plants.at(-1).id);
});

// ---------- Start ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
render();
loadWeather();
