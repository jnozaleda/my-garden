// Weather for the garden: Open-Meteo daily forecast (no API key) plus the two previous days,
// so the rules can see "it rained yesterday" as well as "it will rain tomorrow".

const DAILY = [
  "temperature_2m_max", "temperature_2m_min", "precipitation_sum",
  "precipitation_probability_max", "wind_gusts_10m_max", "weather_code",
].join(",");

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Returns { days: [{ date, max, min, rain, rainProb, gust, code }], today: index of today }.
export async function fetchWeather(loc) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&daily=${DAILY}&past_days=2&forecast_days=7&timezone=auto`;
  const d = (await getJSON(url)).daily;
  const days = d.time.map((date, i) => ({
    date,
    max: d.temperature_2m_max[i],
    min: d.temperature_2m_min[i],
    rain: d.precipitation_sum[i] ?? 0,
    rainProb: d.precipitation_probability_max[i] ?? 0,
    gust: d.wind_gusts_10m_max[i] ?? 0,
    code: d.weather_code[i],
  }));
  return { days, today: 2 };
}

export async function searchCities(query) {
  if (!query.trim()) return [];
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=es&format=json`;
  const json = await getJSON(url);
  return (json.results ?? []).map((r) => ({
    name: r.name, country: r.country ?? "", admin: r.admin1 ?? "",
    lat: Math.round(r.latitude * 1e4) / 1e4, lon: Math.round(r.longitude * 1e4) / 1e4,
  }));
}

// WMO weather code → { kind, label }. `kind` names the app's icon (sun, cloud-sun, cloud, fog,
// cloud-rain, snow, cloud-storm); `label` is the short Spanish description.
export function weatherKind(code) {
  if (code === 0) return { kind: "sun", label: "Despejado" };
  if (code <= 2) return { kind: "cloud-sun", label: "Poco nuboso" };
  if (code === 3) return { kind: "cloud", label: "Nublado" };
  if (code <= 48) return { kind: "fog", label: "Niebla" };
  if (code <= 67 || (code >= 80 && code <= 82)) return { kind: "cloud-rain", label: "Lluvia" };
  if (code <= 77 || code === 85 || code === 86) return { kind: "snow", label: "Nieve" };
  return { kind: "cloud-storm", label: "Tormentas" };
}
