// my-garden-api — the app's small backend. For now one job: fill in a plant's care sheet from
// its name ("✨ Rellenar con IA"). The AI provider is a setting (PROVIDER) so moving from the free
// Cloudflare model to a paid one later only touches this file, never the app.
//
// Guards, in order: allowed origin (CORS), access code, per-species cache (a repeat costs nothing),
// daily call limit. Every failure answers JSON { error } and the app falls back to manual entry.

const TASK_TYPES = ["prune", "repot", "treat", "mulch", "protect", "clean", "harvest", "other"];
const RISKS = ["fungus", "snails", "sunburn", "wind"];
const CACHE_TTL = 180 * 86400; // the answer covers the whole year; refresh twice a year
const SEASONS = ["spring", "summer", "autumn", "winter"];
const SEASON_ES = { spring: "primavera", summer: "verano", autumn: "otoño", winter: "invierno" };

// The shape the app's form expects. Kept flat and small so modest models fill it reliably.
// No maxLength on notes: constrained decoding would cut the text mid-sentence (clipSentences trims instead).
const CARE_SCHEMA = {
  type: "object",
  properties: {
    isPlant: { type: "boolean", description: "false si el nombre no corresponde a ninguna planta (una palabra al azar, un objeto, un animal…)" },
    commonName: { type: "string", description: "Nombre común en español" },
    species: { type: "string", description: "Nombre científico (género y especie)" },
    ...Object.fromEntries(SEASONS.flatMap((k) => [
      [`water_${k}`, { type: "integer", minimum: 1, maximum: 60, description: `Días entre riegos en ${SEASON_ES[k]}, en exterior y maceta mediana, en ese clima` }],
      [`feed_${k}`, { type: "integer", minimum: 0, maximum: 365, description: `Días entre abonados en ${SEASON_ES[k]}; 0 si en esa estación no se abona` }],
      [`tip_${k}`, { type: "string", description: `Una frase corta (menos de 140 caracteres) con lo más importante en ${SEASON_ES[k]} para esta planta en ese clima` }],
    ])),
    frostSensitive: { type: "boolean", description: "Si sufre con temperaturas bajo 0 °C" },
    notes: { type: "string", description: "Entre 2 y 4 frases cortas (menos de 350 caracteres) sobre ESTA planta válidas todo el año: luz, cuándo podar, plagas habituales. Sin meses concretos ni frecuencias de riego" },
    confidence: { type: "string", enum: ["alta", "media", "baja"], description: "baja si no reconoces bien la planta" },
    alternatives: {
      type: "array", maxItems: 3,
      description: "Si el nombre común se usa para varias plantas distintas, las otras posibles (no la elegida). Vacío si no hay duda.",
      items: {
        type: "object",
        properties: { commonName: { type: "string" }, species: { type: "string", description: "Nombre científico" } },
        required: ["commonName", "species"], additionalProperties: false,
      },
    },
  },
  required: ["isPlant", "alternatives", "commonName", "species", ...SEASONS.flatMap((k) => [`water_${k}`, `feed_${k}`, `tip_${k}`]), "frostSensitive", "notes", "confidence"],
  additionalProperties: false,
};

// The year calendar is asked separately (POST /calendar): with it in the same answer the free
// model takes up to 90 s, too slow for adding a plant. The app requests it in the background.
const CALENDAR_SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array", maxItems: 8,
      description: "Entre 3 y 6 tareas concretas del año para esta planta en ese lugar, sin riego ni abonado (ya van aparte). Cada tarea es una acción que se hace y se puede marcar como hecha (podar, trasplantar, tratar contra una plaga concreta, acolchar, proteger del frío, limpiar hojas secas, cosechar), nunca una fase o estado del año como «reposo invernal» o «preparación para el invierno»",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: TASK_TYPES },
          title: { type: "string", description: "La acción en pocas palabras, empezando por un verbo en infinitivo (p. ej. «Podar ramas secas», «Tratar contra la cochinilla», «Acolchar la base»)" },
          how: { type: "string", description: "Cómo hacerlo en una frase corta (menos de 120 caracteres)" },
          months: { type: "array", items: { type: "integer", minimum: 1, maximum: 12 }, description: "Meses del año (1-12) en que toca, para ese hemisferio" },
        },
        required: ["type", "title", "how", "months"], additionalProperties: false,
      },
    },
    risks: {
      type: "array", items: { type: "string", enum: RISKS },
      description: "Riesgos a los que es sensible: fungus (hongos con humedad), snails (caracoles y babosas tras la lluvia), sunburn (quemaduras con calor fuerte), wind (daños con viento fuerte)",
    },
  },
  required: ["tasks", "risks"],
  additionalProperties: false,
};

function calendarMessages({ name, species, place, lat }) {
  return [
    {
      role: "system",
      content:
        "Eres un jardinero experto en plantas de exterior. Das el calendario de tareas del año para un aficionado, " +
        "ajustado al clima del lugar (meses del hemisferio indicado). Sin riego ni abonado: van aparte. Solo acciones " +
        "concretas que se hacen y se pueden marcar como hechas, empezando por un verbo: podar, trasplantar, tratar " +
        "contra una plaga concreta, acolchar, proteger del frío, limpiar hojas secas, cosechar. Nunca fases del año. " +
        "Responde siempre en español.",
    },
    {
      role: "user",
      content: `Planta: «${name}»${species ? ` (${species})` : ""}.\nLugar: ${place || "sin nombre"} (hemisferio ${lat < 0 ? "sur" : "norte"}).\nDa su calendario de tareas del año y sus riesgos.`,
    },
  ];
}

function careMessages({ name, place, lat, lon }) {
  const south = lat < 0;
  return [
    {
      role: "system",
      content:
        "Eres un jardinero experto en plantas de exterior (jardín, terraza y huerto). Das pautas prácticas y prudentes " +
        "para un aficionado. Da la pauta de riego y abonado para cada estación del año, ajustada al clima de ese lugar " +
        "(un clima atlántico y lluvioso pide menos riego que uno mediterráneo o de interior): en invierno se riega " +
        "menos y la mayoría de plantas no se abonan. Los días de riego son para maceta mediana. " +
        "Referencias orientativas de riego en exterior: en pleno verano mediterráneo " +
        "una maceta puede necesitar agua cada 1–3 días; en primavera y otoño cada 3–7; en invierno cada 7–15. " +
        "Las suculentas y plantas de secano, bastante menos. Abonado: cada 15–60 días en crecimiento, 0 en reposo. " +
        "Las notas son consejos prácticos sobre la planta concreta, válidos todo el año; empieza directamente por el " +
        "consejo, no describas el tiempo y no supongas si está en maceta o en suelo. " +
        "Si el nombre no es una planta, marca isPlant=false y no inventes una especie. " +
        "Si el nombre común se usa para varias plantas (por ejemplo «jazmín»: Jasminum officinale, el falso jazmín " +
        "Trachelospermum jasminoides…), rellena la ficha de la más habitual en jardines y terrazas de España y pon las " +
        "demás en alternatives. En tasks pon solo acciones concretas que el jardinero pueda hacer y marcar como hechas, " +
        "con los meses en que tocan en ese clima; por ejemplo, para un cítrico: tratar contra la cochinilla, podar " +
        "ramas secas tras la cosecha, proteger del frío en las heladas. Responde siempre en español.",
    },
    {
      role: "user",
      content:
        `Planta: «${name}».\nLugar: ${place || "sin nombre"} (lat ${lat}, lon ${lon}, hemisferio ${south ? "sur" : "norte"}).\n` +
        `Rellena su ficha de cuidados para todo el año.`,
    },
  ];
}

// ---------- Providers ----------
// Each returns the parsed care object (or throws). Add "claude" here when moving to paid.
const providers = {
  async "workers-ai"(env, messages, schema = CARE_SCHEMA, name = "ficha_cuidados") {
    const out = await env.AI.run(env.MODEL, {
      messages,
      response_format: { type: "json_schema", json_schema: { name, schema, strict: true } },
      chat_template_kwargs: { enable_thinking: env.THINKING === "on" },
      max_tokens: 2500,
      temperature: 0.2,
    });
    const content = out?.choices?.[0]?.message?.content ?? out?.response;
    if (content && typeof content === "object") return content;
    try { return JSON.parse(content); } catch {
      throw new Error(`unparseable output: ${JSON.stringify(out).slice(0, 300)}`);
    }
  },
};

// Models overrun length hints: keep whole sentences up to `max` characters.
function clipSentences(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));
  return end > 0 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "") + "…";
}

// "Pelargonium × hortorum" and "Pelargonium hortorum" are the same plant.
const sameSpecies = (s) => s.toLowerCase().replace(/[^a-z]/g, "");
const looksLikeSpecies = (s) => /^[A-Z][a-zë]+(\s|$|\.)/.test(s);

// Nobody fertilises every few days: small models sometimes answer "1" meaning "yes, feed it".
// Read anything under a week as the usual fortnightly feed.
const feedDays = (n) => (n > 0 && n < 7 ? 15 : n);

// The model sometimes mislabels the type («Podar…» as repot): the verb decides when it's clear.
const VERB_TYPE = [[/^(podar|poda|despuntar|pinzar|recortar)/i, "prune"], [/^(trasplantar|replantar|cambiar de maceta)/i, "repot"],
  [/^(tratar|tratamiento|control|prevenir|fumigar|pulverizar)/i, "treat"], [/^(acolchar|aplicar mantillo|cubrir la base)/i, "mulch"],
  [/^(proteger|abrigar|resguardar|cubrir)/i, "protect"], [/^(limpiar|retirar|eliminar)/i, "clean"], [/^(cosechar|recolectar)/i, "harvest"]];
function sanitizeCalendar(c) {
  const str = (v, max) => String(v ?? "").trim().slice(0, max);
  return {
    tasks: (Array.isArray(c.tasks) ? c.tasks : [])
      .map((t) => {
        const title = str(t?.title, 60);
        const byVerb = VERB_TYPE.find(([re]) => re.test(title))?.[1];
        return {
          type: byVerb ?? (TASK_TYPES.includes(t?.type) ? t.type : "other"),
          title,
          how: clipSentences(str(t?.how, 300), 140),
          months: [...new Set((Array.isArray(t?.months) ? t.months : []).map(Number).filter((m) => m >= 1 && m <= 12))].sort((a, b) => a - b),
        };
      })
      // Watering and feeding already have their own seasonal table.
      .filter((t) => t.title && t.months.length && !/abon|fertiliz|rieg|regar/i.test(t.title))
      // Small models repeat themselves: merge same-title tasks (joining their months), at most 2 per type.
      .reduce((acc, t) => {
        const same = acc.find((x) => normName(x.title) === normName(t.title));
        if (same) same.months = [...new Set([...same.months, ...t.months])].sort((a, b) => a - b);
        else if (acc.filter((x) => x.type === t.type).length < 2) acc.push(t);
        return acc;
      }, [])
      .slice(0, 6),
    risks: [...new Set((Array.isArray(c.risks) ? c.risks : []).filter((r) => RISKS.includes(r)))],
  };
}

// Model output is advice, not trusted input: coerce types and clamp to the ranges the form allows.
function sanitize(c) {
  const int = (v, min, max, dflt) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
  };
  const str = (v, max) => String(v ?? "").trim().slice(0, max);
  return {
    commonName: str(c.commonName, 80),
    species: str(c.species, 80),
    // { spring: { water, feed }, summer: …, autumn: …, winter: … }
    seasons: Object.fromEntries(SEASONS.map((k) => [k, { water: int(c[`water_${k}`], 1, 60, 3), feed: feedDays(int(c[`feed_${k}`], 0, 365, 0)) }])),
    tips: Object.fromEntries(SEASONS.map((k) => [k, clipSentences(str(c[`tip_${k}`], 400), 160)])),
    frostSensitive: c.frostSensitive === true || c.frostSensitive === "true",
    notes: clipSentences(str(c.notes, 2000), 600),
    confidence: ["alta", "media", "baja"].includes(c.confidence) ? c.confidence : "baja",
    alternatives: (Array.isArray(c.alternatives) ? c.alternatives : [])
      .map((a) => ({ commonName: str(a?.commonName, 60), species: str(a?.species, 80) }))
      .filter((a, i, all) => a.commonName && looksLikeSpecies(a.species) && sameSpecies(a.species) !== sameSpecies(str(c.species, 80))
        && all.findIndex((x) => sameSpecies(x.species) === sameSpecies(a.species)) === i)
      .slice(0, 3),
    // Small models sometimes play along with nonsense ("random" → species "random"): a real answer
    // has a Latin-looking name (capitalised genus).
    isPlant: c.isPlant !== false && c.isPlant !== "false" && looksLikeSpecies(str(c.species, 80)),
  };
}

// ---------- HTTP ----------
function cors(request, env) {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
  return allowed.includes(origin)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,X-Access-Code", "Vary": "Origin" }
    : {};
}

const json = (body, status, headers) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const normName = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

// App versions from before the seasonal sheet send `month` and read one waterEvery/feedEvery.
function withLegacy(care, month, lat) {
  const m = Number(month);
  if (!(m >= 1 && m <= 12)) return care;
  const north = lat < 0 ? ((m + 5) % 12) + 1 : m;
  const now = care.seasons[SEASONS[Math.floor(((north + 9) % 12) / 3)]];
  return { ...care, waterEvery: now.water, feedEvery: now.feed };
}

const authorized = (request, env) => Boolean(env.ACCESS_CODE) && request.headers.get("X-Access-Code") === env.ACCESS_CODE;

async function handleCare(request, env, headers) {
  if (!authorized(request, env)) {
    return json({ error: "code" }, 401, headers);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: "input" }, 400, headers); }
  const name = String(body.name ?? "").trim().slice(0, 80);
  const lat = Number(body.lat), lon = Number(body.lon);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json({ error: "input" }, 400, headers);
  }
  const place = String(body.place ?? "").slice(0, 60);

  // Same plant, same climate cell (~100 km) → same answer, whatever the month.
  const cacheKey = `care:v10:${env.PROVIDER}:${normName(name)}:${Math.round(lat)}:${Math.round(lon)}`;
  const cached = await env.CACHE.get(cacheKey, "json");
  if (cached) return json({ ...withLegacy(cached, body.month, lat), cached: true }, 200, headers);

  const today = new Date().toISOString().slice(0, 10);
  const countKey = `count:${today}`;
  const used = Number(await env.CACHE.get(countKey)) || 0;
  if (used >= Number(env.DAILY_LIMIT)) return json({ error: "limit" }, 429, headers);
  await env.CACHE.put(countKey, String(used + 1), { expirationTtl: 2 * 86400 });

  const provider = providers[env.PROVIDER];
  if (!provider) return json({ error: "provider" }, 500, headers);
  let care;
  try {
    care = sanitize(await provider(env, careMessages({ name, place, lat, lon })));
  } catch (err) {
    console.error("care failed", env.PROVIDER, env.MODEL, err?.message);
    return json({ error: "ai" }, 502, headers);
  }
  if (!care.isPlant) return json({ error: "not_plant" }, 422, headers);
  if (care.confidence !== "baja") await env.CACHE.put(cacheKey, JSON.stringify(care), { expirationTtl: CACHE_TTL });
  return json(withLegacy(care, body.month, lat), 200, headers);
}

async function handleCalendar(request, env, headers) {
  if (!authorized(request, env)) return json({ error: "code" }, 401, headers);
  let body;
  try { body = await request.json(); } catch { return json({ error: "input" }, 400, headers); }
  const name = String(body.name ?? "").trim().slice(0, 80);
  const species = String(body.species ?? "").trim().slice(0, 80);
  const lat = Number(body.lat), lon = Number(body.lon);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return json({ error: "input" }, 400, headers);
  const place = String(body.place ?? "").slice(0, 60);

  const cacheKey = `cal:v2:${env.PROVIDER}:${normName(species || name)}:${Math.round(lat)}:${Math.round(lon)}`;
  const cached = await env.CACHE.get(cacheKey, "json");
  if (cached) return json({ ...cached, cached: true }, 200, headers);

  const countKey = `count:${new Date().toISOString().slice(0, 10)}`;
  const used = Number(await env.CACHE.get(countKey)) || 0;
  if (used >= Number(env.DAILY_LIMIT)) return json({ error: "limit" }, 429, headers);
  await env.CACHE.put(countKey, String(used + 1), { expirationTtl: 2 * 86400 });

  const provider = providers[env.PROVIDER];
  if (!provider) return json({ error: "provider" }, 500, headers);
  let cal;
  try {
    cal = sanitizeCalendar(await provider(env, calendarMessages({ name, species, place, lat }), CALENDAR_SCHEMA, "calendario"));
  } catch (err) {
    console.error("calendar failed", env.PROVIDER, env.MODEL, err?.message);
    return json({ error: "ai" }, 502, headers);
  }
  if (cal.tasks.length) await env.CACHE.put(cacheKey, JSON.stringify(cal), { expirationTtl: CACHE_TTL });
  return json(cal, 200, headers);
}

export default {
  async fetch(request, env) {
    const headers = cors(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return json({ ok: true, provider: env.PROVIDER }, 200, headers);
    if (pathname === "/check") return json({ ok: authorized(request, env) }, authorized(request, env) ? 200 : 401, headers);
    if (pathname === "/care" && request.method === "POST") return handleCare(request, env, headers);
    if (pathname === "/calendar" && request.method === "POST") return handleCalendar(request, env, headers);
    return json({ error: "not_found" }, 404, headers);
  },
};
