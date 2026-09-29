// Calendar export: one recurring all-day event per plant and care type (.ics), which the
// phone's calendar (Apple, Google, Outlook) imports. It's a snapshot: weather changes don't
// reach the calendar until the webcal subscription (phase 2).

import { CARE, nextDue } from "./rules.js";

const esc = (s) => String(s).replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
const compact = (iso) => iso.replaceAll("-", "");
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");

export function buildICS(plants, log, today) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MiJardin//ES", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Mi Jardín"];
  for (const plant of plants) {
    for (const [type, every] of [["water", plant.waterEvery], ["feed", plant.feedEvery]]) {
      if (!every) continue;
      let start = nextDue(plant, log, type);
      if (start < today) start = today;
      const end = new Date(start + "T12:00:00Z");
      end.setUTCDate(end.getUTCDate() + 1);
      lines.push(
        "BEGIN:VEVENT",
        `UID:${plant.id}-${type}@mijardin`,
        `DTSTAMP:${stamp()}`,
        `DTSTART;VALUE=DATE:${compact(start)}`,
        `DTEND;VALUE=DATE:${compact(end.toISOString().slice(0, 10))}`,
        `RRULE:FREQ=DAILY;INTERVAL=${every}`,
        `SUMMARY:${esc(`${CARE[type].icon} ${CARE[type].label}: ${plant.name}`)}`,
        `DESCRIPTION:${esc(`Cada ${every} días${plant.zone ? ` · ${plant.zone}` : ""}. Mira Mi Jardín por si el tiempo cambia el plan.`)}`,
        "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:PT9H", `DESCRIPTION:${esc(`${CARE[type].label} ${plant.name}`)}`, "END:VALARM",
        "END:VEVENT",
      );
    }
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}
