// Shared CSV helpers used by the server import pipeline and database seeding.

// Parse one CSV line into fields (handles quoted fields with embedded delimiters/quotes).
function parseCsvLine(line, delimiter = ',') {
  const result = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQuote = !inQuote; }
    } else if (ch === delimiter && !inQuote) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

// Count delimiter occurrences outside quotes to auto-detect tab vs comma CSVs.
function detectDelimiter(headerLine) {
  let tabs = 0, commas = 0, inQuote = false;
  for (let i = 0; i < headerLine.length; i++) {
    const ch = headerLine[i];
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote) {
      if (ch === '\t') tabs++;
      else if (ch === ',') commas++;
    }
  }
  return tabs > commas ? '\t' : ',';
}

// Parse CSV date (M/D/YYYY HH:MM or M/D/YYYY) to ISO-ish SQLite datetime.
// Date-only values fall back to 00:00:00 so rows without a time aren't silently dropped.
function parseCsvDate(str) {
  if (!str || !str.trim()) return null;
  const s = str.trim();
  const withTime = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (withTime) {
    const [, month, day, year, hour, minute] = withTime;
    return `${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')} ${hour.padStart(2,'0')}:${minute}:00`;
  }
  const dateOnly = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dateOnly) {
    const [, month, day, year] = dateOnly;
    return `${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')} 00:00:00`;
  }
  return null;
}

module.exports = { parseCsvLine, detectDelimiter, parseCsvDate };
