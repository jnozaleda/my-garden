// Defence in depth for data that didn't come from this phone (a garden joined with a key, an imported
// copy): force the fields that are drawn into HTML to be what they should be. The Worker validates
// shared copies the same way before storing them; text fields are escaped where they are drawn.

const PHOTO = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const REF_URL = /^https:\/\/(inaturalist-open-data\.s3\.amazonaws\.com|static\.inaturalist\.org|upload\.wikimedia\.org)\//;
const SEASONS = ["spring", "summer", "autumn", "winter"];
const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);

export function scrubPlant(p) {
  if (!p || typeof p !== "object") return p;
  if (p.photo !== undefined && !(typeof p.photo === "string" && p.photo.length < 900000 && PHOTO.test(p.photo))) delete p.photo;
  if (p.refPhoto && !(typeof p.refPhoto.url === "string" && REF_URL.test(p.refPhoto.url))) p.refPhoto = null;
  if (p.seasons && typeof p.seasons === "object") {
    for (const k of SEASONS) p.seasons[k] = { water: Math.min(60, Math.max(1, Math.round(num(p.seasons[k]?.water, 3)))), feed: Math.min(365, Math.max(0, Math.round(num(p.seasons[k]?.feed, 0)))) };
  }
  if (p.size && !["small", "medium", "large"].includes(p.size)) p.size = "";
  if (p.sun && !["sun", "partial", "shade"].includes(p.sun)) p.sun = "";
  if (p.sunNeed && !["sun", "partial", "shade"].includes(p.sunNeed)) p.sunNeed = "sun";
  if (p.minTemp != null) p.minTemp = Math.min(25, Math.max(-40, Math.round(num(p.minTemp, 0))));
  for (const t of Array.isArray(p.yearTasks) ? p.yearTasks : []) {
    t.months = (Array.isArray(t.months) ? t.months : []).map(Number).filter((m) => Number.isInteger(m) && m >= 1 && m <= 12);
  }
  return p;
}
