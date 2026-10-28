// Dates from chat messages. Pure: the chat date is passed in; this file never reads the computer's clock.
// Dates travel as "YYYY-MM-DD" strings. The maths uses UTC days, so time zones can't shift a date.
// Rules: PLAN.md Section 6 ("nearest date" year rule, visible warnings, impossible dates are unclear).

const DAY_MS = 24 * 60 * 60 * 1000;
const WARN_DAYS = 60;
const WARNING = "Check the Chat date";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Day words -> days to add ("esok") or the weekday to find (0 = Sunday).
const OFFSETS = { esok: 1, tomorrow: 1, lusa: 2 };
const DAY_NAMES = {
  ahad: 0, isnin: 1, selasa: 2, rabu: 3, khamis: 4, jumaat: 5, sabtu: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

// Day number (days since 1 Jan 1970) for a date that really exists, else null.
function dayNumber(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  const real = d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
  return real ? d.getTime() / DAY_MS : null;
}

// "2026-10-28" -> day number, or null if it isn't a real date.
function parseIso(iso) {
  const m = typeof iso === "string" ? iso.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  return m ? dayNumber(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

const toIso = (days) => new Date(days * DAY_MS).toISOString().slice(0, 10);

function toLabel(days) {
  const d = new Date(days * DAY_MS);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// "9:02 AM" -> "09:02"; "21:30" -> "21:30". null if the time is not real. Seconds are checked, then dropped.
function parseTime(hours, minutes, ampm, seconds) {
  let h = Number(hours);
  if (Number(minutes) > 59 || Number(seconds ?? 0) > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ampm[0].toUpperCase() === "P" ? 12 : 0);
  } else if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${minutes}`;
}

// The timestamp formats phones paste (day/month order, as in Malaysia). Best effort (PLAN.md robustness #1-#5);
// each line is tried against these in order. A year is optional; seconds are read and dropped.
const DATE = String.raw`(?<day>\d{1,2})\/(?<month>\d{1,2})(?:\/(?<year>\d{4}|\d{2}))?`;
const TIME = String.raw`(?<hours>\d{1,2})[:.](?<minutes>\d{2})(?::(?<seconds>\d{2}))?(?:\s*(?<ampm>[AaPp]\.?[Mm]\.?))?`;
const STAMPS = [
  new RegExp(String.raw`^\[\s*${DATE}(?:,?\s+${TIME})?\s*\]\s*`), // [28/10 9:02 AM], [28/10/2026, 9:02:15 AM], [28/10]
  new RegExp(String.raw`^\[\s*${TIME},?\s+${DATE}\s*\]\s*`), // [9:02 am, 28/10/2026] (copied from a web chat)
  new RegExp(String.raw`^${DATE},?\s+${TIME}\s+[-–]\s+`), // 28/10/26, 9:02 am - Lina: (Android, no brackets)
];
// Spaces and the invisible direction marks some phone exports put before a line.
const LEADING = /^[\s‎‏‪-‮⁦-⁩]+/;
// A bracketed stamp we can't read ("[28/10 25:00]") still starts a new message, so the reason shows on it.
const LOOKS_LIKE_STAMP = /^\[\s*\d{1,2}[/:.]\d/;

// A line -> { groups, text } when it starts with a timestamp (text = what comes after it), else null.
function matchStamp(line) {
  if (typeof line !== "string") return null;
  const clean = line.replace(LEADING, "");
  for (const re of STAMPS) {
    const m = clean.match(re);
    if (m) return { groups: m.groups, text: clean.slice(m[0].length) };
  }
  return null;
}

// A chat line + the chat date -> { date, time, label, warning, reason }. With no year in the stamp
// ("[28/10 9:02 AM]"), the year is the one (chat year, or one before or after) that puts the message
// NEAREST the chat date; on a tie the earlier year wins. A year in the stamp is used as written.
// A date after the chat date, or more than 60 days away, gets a visible warning; it is never moved
// silently. An impossible date gives date: null and a reason.
export function parseTimestamp(stamp, chatDate) {
  const chat = parseIso(chatDate);
  if (chat === null) throw new RangeError(`Not a valid chat date: ${JSON.stringify(chatDate)}`);

  const fail = (reason, time = null) => ({ date: null, time, label: null, warning: "", reason });
  const g = matchStamp(stamp)?.groups;
  const time = g?.hours ? parseTime(g.hours, g.minutes, g.ampm, g.seconds) : null;
  if (!g || (g.hours && !time)) return fail(`Can't read the timestamp ${JSON.stringify(stamp)}.`);

  const day = Number(g.day);
  const month = Number(g.month);
  const chatYear = new Date(chat * DAY_MS).getUTCFullYear();

  // Distance uses Date.UTC as-is (29 Feb 2027 rolls to 1 Mar 2027), so we can find the
  // nearest year first and only then ask whether the date really exists in that year.
  let year = g.year ? Number(g.year) + (g.year.length === 2 ? 2000 : 0) : null;
  let best = Infinity;
  for (const y of year ? [] : [chatYear - 1, chatYear, chatYear + 1]) {
    const distance = Math.abs(Date.UTC(y, month - 1, day) / DAY_MS - chat);
    if (distance < best) [year, best] = [y, distance];
  }

  const days = dayNumber(year, month, day);
  if (days === null) return fail(`There is no ${day}/${month} in ${year}: check the timestamp.`, time);

  const warning = days > chat || chat - days > WARN_DAYS ? WARNING : "";
  return { date: toIso(days), time, label: toLabel(days), warning, reason: "" };
}

// A day word + the message's own date -> "YYYY-MM-DD", or null for a word we don't know.
// "esok"/"tomorrow" = +1 day, "lusa" = +2 days. A day name means the NEXT such day after
// the message date, so "rabu" written on a Wednesday is 7 days later.
export function resolveDayWord(word, messageDate) {
  const start = parseIso(messageDate);
  if (start === null) throw new RangeError(`Not a valid message date: ${JSON.stringify(messageDate)}`);

  const key = typeof word === "string" ? word.trim().toLowerCase() : "";
  // Object.hasOwn, not "in": "in" would also accept names every object has, like "constructor".
  if (Object.hasOwn(OFFSETS, key)) return toIso(start + OFFSETS[key]);
  if (Object.hasOwn(DAY_NAMES, key)) {
    const today = new Date(start * DAY_MS).getUTCDay();
    return toIso(start + ((DAY_NAMES[key] - today + 7) % 7 || 7));
  }
  return null;
}

// A pasted chat -> messages, numbered from 1, each with its full date (for the AI prompt).
// A line that starts with a timestamp ("[28/10 9:02 AM] ...", or another phone format above) starts a
// new message; every other line belongs to the message above it. Text before the first timestamp (or a
// whole paste with no timestamps, like one copied message) is one message dated on the Chat date.
// Blank lines are skipped; no other text is ever dropped.
export function splitMessages(paste, chatDate) {
  const chat = parseIso(chatDate);
  if (chat === null) throw new RangeError(`Not a valid chat date: ${JSON.stringify(chatDate)}`);

  const messages = [];
  for (const line of String(paste ?? "").split(/\r?\n/)) {
    if (!line.replace(LEADING, "")) continue;
    const found = matchStamp(line);
    const unreadable = !found && LOOKS_LIKE_STAMP.test(line.replace(LEADING, ""));
    if (found || unreadable) {
      const text = found ? found.text : line.replace(LEADING, "").replace(/^\[[^\]]*\]\s*/, "");
      messages.push({ n: messages.length + 1, ...parseTimestamp(line, chatDate), text: text.trimEnd() });
    } else if (messages.length) {
      messages.at(-1).text += `\n${line.trimEnd()}`;
    } else {
      messages.push({ n: 1, date: chatDate, time: null, label: toLabel(chat), warning: "", reason: "", text: line.trimEnd() });
    }
  }
  return messages;
}

// The Chat date and the days after it, as { date: "2026-10-29", label: "Thu 29 Oct 2026" }.
// The AI prompt lists these, so "Saturday" or "tomorrow" become exact dates without the AI counting days.
export function calendarDays(chatDate, count) {
  const start = parseIso(chatDate);
  if (start === null) throw new RangeError(`Not a valid chat date: ${JSON.stringify(chatDate)}`);
  return Array.from({ length: count }, (_, i) => ({ date: toIso(start + i), label: toLabel(start + i) }));
}
