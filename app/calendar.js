// Calendar export (.ics) that the phone's calendar (Apple, Google, Outlook) imports: for each plant
// and care type, one repeating all-day event per season over the next 12 months, at that
// season's interval. It's a snapshot: weather changes don't reach the calendar until the webcal
// subscription (phase 2).

import { CARE, SEASON_LABEL, nextDue, intervalFor, seasonOf, seasonStart, nextSeasonStart, addDays } from "./rules.js?v=20261002h";

const esc = (s) => String(s).replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
const compact = (iso) => iso.replaceAll("-", "");
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");

export function buildICS(plants, log, today, lat) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MiJardin//ES", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Mi Jardín"];
  // Today's season (from today) and the three after it, each as [first day, last day].
  const periods = [];
  for (let from = today, i = 0; i < 4; i++) {
    const next = nextSeasonStart(from, lat);
    periods.push({ season: seasonOf(from, lat), from, to: addDays(next, -1) });
    from = next;
  }
  for (const plant of plants) {
    for (const type of ["water", "feed"]) {
      periods.forEach(({ season, from, to }, i) => {
        const every = intervalFor(plant, type, season);
        if (!every) return;
        let start = i === 0 ? nextDue(plant, log, type, today, lat) ?? from : from;
        if (start < from) start = from;
        if (start > to) return;
        lines.push(
          "BEGIN:VEVENT",
          `UID:${plant.id}-${type}-${seasonStart(from, lat)}@mijardin`,
          `DTSTAMP:${stamp()}`,
          `DTSTART;VALUE=DATE:${compact(start)}`,
          `DTEND;VALUE=DATE:${compact(addDays(start, 1))}`,
          `RRULE:FREQ=DAILY;INTERVAL=${every};UNTIL=${compact(to)}`,
          `SUMMARY:${esc(`${CARE[type].icon} ${CARE[type].label}: ${plant.name}`)}`,
          `DESCRIPTION:${esc(`${SEASON_LABEL[season]}: cada ${every} días${plant.zone ? ` · ${plant.zone}` : ""}. Mira Mi Jardín por si el tiempo cambia el plan.`)}`,
          "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:PT9H", `DESCRIPTION:${esc(`${CARE[type].label} ${plant.name}`)}`, "END:VALARM",
          "END:VEVENT",
        );
      });
    }
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}
