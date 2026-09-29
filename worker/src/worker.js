// my-garden-api — the app's small backend. For now one job: fill in a plant's care sheet from
// its name ("✨ Rellenar con IA"). The AI provider is a setting (PROVIDER) so moving from the free
// Cloudflare model to a paid one later only touches this file, never the app.
//
// Guards, in order: allowed origin (CORS), access code, per-species cache (a repeat costs nothing),
// daily call limit. Every failure answers JSON { error } and the app falls back to manual entry.

const CACHE_TTL = 90 * 86400; // a season: the answer depends on it
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

// The shape the app's form expects. Kept flat and small so modest models fill it reliably.
const CARE_SCHEMA = {
  type: "object",
  properties: {
    commonName: { type: "string", description: "Nombre común en español" },
    species: { type: "string", description: "Nombre científico (género y especie)" },
    waterEvery: { type: "integer", minimum: 1, maximum: 60, description: "Días entre riegos ahora, en exterior y en maceta mediana, para ese clima y estación" },
    feedEvery: { type: "integer", minimum: 0, maximum: 365, description: "Días entre abonados ahora (en temporada suele ser 15–60); 0 si en esta estación no se abona" },
    frostSensitive: { type: "boolean", description: "Si sufre con temperaturas bajo 0 °C" },
    notes: { type: "string", maxLength: 400, description: "Máximo 4 frases cortas sobre ESTA planta: luz, poda, plagas habituales y qué hacer este mes" },
    confidence: { type: "string", enum: ["alta", "media", "baja"], description: "baja si el nombre es ambiguo o no reconoces la planta" },
  },
  required: ["commonName", "species", "waterEvery", "feedEvery", "frostSensitive", "notes", "confidence"],
  additionalProperties: false,
};

function careMessages({ name, place, lat, lon, month }) {
  const south = lat < 0;
  return [
    {
      role: "system",
      content:
        "Eres un jardinero experto en plantas de exterior (jardín, terraza y huerto). Das pautas prácticas y prudentes " +
        "para un aficionado. Ajusta riego y abonado al clima del lugar y a la estación indicada: en invierno se riega " +
        "menos y la mayoría de plantas no se abonan. Si una planta vive en maceta necesita más riego que en suelo; " +
        "da la pauta para maceta mediana. Referencias orientativas de riego en exterior: en pleno verano mediterráneo " +
        "una maceta puede necesitar agua cada 1–3 días; en primavera y otoño cada 3–7; en invierno cada 7–15. " +
        "Las suculentas y plantas de secano, bastante menos. Abonado: cada 15–60 días en crecimiento, 0 en reposo. " +
        "Las notas son consejos prácticos sobre la planta concreta; empieza directamente por el consejo y no describas " +
        "el tiempo ni la estación. Responde siempre en español.",
    },
    {
      role: "user",
      content:
        `Planta: «${name}».\nLugar: ${place || "sin nombre"} (lat ${lat}, lon ${lon}, hemisferio ${south ? "sur" : "norte"}).\n` +
        `Mes actual: ${MONTHS[month - 1]}.\nRellena su ficha de cuidados para ahora mismo.`,
    },
  ];
}

// ---------- Providers ----------
// Each returns the parsed care object (or throws). Add "claude" here when moving to paid.
const providers = {
  async "workers-ai"(env, messages) {
    const out = await env.AI.run(env.MODEL, {
      messages,
      response_format: { type: "json_schema", json_schema: { name: "ficha_cuidados", schema: CARE_SCHEMA, strict: true } },
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
    waterEvery: int(c.waterEvery, 1, 60, 3),
    feedEvery: int(c.feedEvery, 0, 365, 0),
    frostSensitive: c.frostSensitive === true || c.frostSensitive === "true",
    notes: clipSentences(str(c.notes, 2000), 600),
    confidence: ["alta", "media", "baja"].includes(c.confidence) ? c.confidence : "baja",
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
const season = (month, lat) => Math.floor(((month + (lat < 0 ? 6 : 0)) % 12) / 3); // 0 winter … 3 autumn (north)

async function handleCare(request, env, headers) {
  if (!env.ACCESS_CODE || request.headers.get("X-Access-Code") !== env.ACCESS_CODE) {
    return json({ error: "code" }, 401, headers);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: "input" }, 400, headers); }
  const name = String(body.name ?? "").trim().slice(0, 80);
  const lat = Number(body.lat), lon = Number(body.lon), month = Number(body.month);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || !(month >= 1 && month <= 12)) {
    return json({ error: "input" }, 400, headers);
  }
  const place = String(body.place ?? "").slice(0, 60);

  // Same plant, same climate cell (~100 km) and season → same answer.
  const cacheKey = `care:v1:${env.PROVIDER}:${normName(name)}:${Math.round(lat)}:${Math.round(lon)}:${season(month, lat)}`;
  const cached = await env.CACHE.get(cacheKey, "json");
  if (cached) return json({ ...cached, cached: true }, 200, headers);

  const today = new Date().toISOString().slice(0, 10);
  const countKey = `count:${today}`;
  const used = Number(await env.CACHE.get(countKey)) || 0;
  if (used >= Number(env.DAILY_LIMIT)) return json({ error: "limit" }, 429, headers);
  await env.CACHE.put(countKey, String(used + 1), { expirationTtl: 2 * 86400 });

  const provider = providers[env.PROVIDER];
  if (!provider) return json({ error: "provider" }, 500, headers);
  let care;
  try {
    care = sanitize(await provider(env, careMessages({ name, place, lat, lon, month })));
  } catch (err) {
    console.error("care failed", env.PROVIDER, env.MODEL, err?.message);
    return json({ error: "ai" }, 502, headers);
  }
  if (care.confidence !== "baja") await env.CACHE.put(cacheKey, JSON.stringify(care), { expirationTtl: CACHE_TTL });
  return json(care, 200, headers);
}

export default {
  async fetch(request, env) {
    const headers = cors(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return json({ ok: true, provider: env.PROVIDER }, 200, headers);
    if (pathname === "/care" && request.method === "POST") return handleCare(request, env, headers);
    return json({ error: "not_found" }, 404, headers);
  },
};
