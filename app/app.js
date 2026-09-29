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
  let html = `<div class="row"><button class="btn" data-action="new-plant">+ Añadir planta</button></div>`;
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
      <p class="muted">${store.get("mj_ai_code", "")
        ? "Activado: al añadir una planta, pulsa ✨ Rellenar con IA y propondrá sus cuidados."
        : "Escribe tu código de acceso para que ✨ Rellenar con IA proponga los cuidados de cada planta."}</p>
      <form id="aiCodeForm" class="row" style="margin-top:10px">
        <input type="password" name="code" class="code-input" placeholder="Código de acceso" autocomplete="off" value="${esc(store.get("mj_ai_code", ""))}" />
        <button class="btn small" type="submit">Guardar</button>
      </form>
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
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === state.tab)));
  $("main").innerHTML = state.tab === "plants" ? plantsView() : state.tab === "more" ? moreView() : todayView();
}

// ---------- Sheets ----------
const sheet = $("sheet");
function openSheet(html) { sheet.innerHTML = `<div class="sheet-in">${html}</div>`; if (!sheet.open) sheet.showModal(); }
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
      <label class="field">Notas<textarea name="notes" rows="3" placeholder="Comprada en marzo, le gusta el sol de mañana…">${esc(p.notes)}</textarea></label>
      <button class="btn block" type="submit">Guardar</button>
    </form>`);
  $("plantForm").dataset.id = id ?? "";
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

async function aiFill() {
  const form = $("plantForm");
  const status = $("aiStatus");
  const show = (text, kind = "") => { status.hidden = false; status.className = `ai-status ${kind}`; status.textContent = text; };
  const name = form.elements.name.value.trim();
  if (!name) { form.elements.name.focus(); return show("Escribe primero el nombre de la planta.", "warn"); }
  const code = store.get("mj_ai_code", "");
  if (!code) return show(AI_ERRORS.code, "warn");

  const btn = form.querySelector('[data-action="ai-fill"]');
  btn.disabled = true;
  show("Consultando…");
  const loc = state.loc ?? DEFAULT_LOC;
  try {
    const res = await fetch(`${API}/care`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Access-Code": code },
      body: JSON.stringify({ name, lat: loc.lat, lon: loc.lon, place: loc.name, month: new Date().getMonth() + 1 }),
    });
    const care = await res.json();
    if (!res.ok) return show(AI_ERRORS[care.error] ?? "El asistente no está disponible ahora. Rellénalo a mano.", "warn");
    const f = form.elements;
    f.species.value = care.species;
    f.waterEvery.value = care.waterEvery;
    f.feedEvery.value = care.feedEvery || "";
    f.frostSensitive.checked = care.frostSensitive;
    if (!f.notes.value.trim()) f.notes.value = care.notes;
    show(care.confidence === "baja"
      ? `⚠️ No está seguro de qué planta es «${name}». Revisa los datos o prueba con otro nombre.`
      : `✨ Propuesta para ${care.commonName} en ${loc.name} este mes. Revisa y guarda.`, care.confidence === "baja" ? "warn" : "ok");
  } catch {
    show("Sin conexión con el asistente. Rellénalo a mano.", "warn");
  } finally {
    btn.disabled = false;
  }
}

// ---------- Actions ----------
function addLog(plantId, type, note = "") {
  state.data.log.push({ id: uid(), plantId, type, date: localToday(), note });
  save();
}

const actions = {
  "new-plant": () => plantForm(null),
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
  const tab = e.target.closest(".tabs button");
  if (tab) { state.tab = tab.dataset.tab; store.set("mj_tab", state.tab); render(); return; }
  if (e.target.closest("#placeBtn")) return placeSheet();
  const el = e.target.closest("[data-action]");
  if (el && actions[el.dataset.action]) { e.preventDefault(); actions[el.dataset.action](el.dataset); }
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
    store.set("mj_ai_code", new FormData(e.target).get("code").trim());
    render();
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
