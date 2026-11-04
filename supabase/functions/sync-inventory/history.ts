// Pure helpers for inventory history/velocity — no I/O, so they can be tested directly.

export const DAY_MS = 24 * 60 * 60 * 1000;

export type Flow = Map<string, number>; // lower-case sku -> units

// Deposco names a few supplies "CUS BD-OUTER-MAILER-L"; Supply Desk tracks them without the
// "CUS " customer-supplied prefix, so both sides are compared with it stripped.
export function normalizeSku(sku: string): string {
  return sku.trim().toLowerCase().replace(/^cus\s+/, "");
}

export function addTo(map: Flow, sku: string, units: number) {
  const key = normalizeSku(sku);
  if (!key || !units) return;
  map.set(key, (map.get(key) ?? 0) + units);
}

// Units that must have left the building (sold, shipped, scrapped) since the last
// snapshot. Anything that arrived (PO/return receipts, finished kits) is added back to
// where stock started, and anything consumed by kitting is taken off, so replenishment
// can't hide sales and kitting doesn't look like selling. Never negative: an unexplained
// increase (cycle-count fix, etc.) just means no recorded outflow.
export function outflowUnits(prevOnHand: number, inbound: number, kittedIn: number, kittedOut: number, nowOnHand: number): number {
  const expected = prevOnHand + inbound + kittedIn - kittedOut;
  return Math.max(0, Math.round(expected - nowOnHand));
}

export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export type DailyRow = { day: string; sku: string; outflow: number };

// Units/day over the last `windowDays` calendar days (UTC buckets), dividing by the time
// actually covered by history so a brand-new tracker isn't diluted by days it didn't exist.
// null until at least a day of history exists.
export function velocityPerDay(rows: DailyRow[], now: Date, coverageStart: Date, windowDays: number): Map<string, number | null> {
  const windowStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (windowDays - 1) * DAY_MS;
  const startKey = dayKey(new Date(windowStartMs));
  const covered = (now.getTime() - Math.max(windowStartMs, coverageStart.getTime())) / DAY_MS;
  const sums = new Map<string, number>();
  for (const r of rows) {
    if (r.day < startKey) continue;
    const k = r.sku.toLowerCase();
    sums.set(k, (sums.get(k) ?? 0) + r.outflow);
  }
  const out = new Map<string, number | null>();
  for (const [k, v] of sums) out.set(k, covered >= 1 ? Math.round((v / covered) * 100) / 100 : null);
  return out;
}

export function coveredDays(now: Date, coverageStart: Date): number {
  return Math.max(0, Math.round(((now.getTime() - coverageStart.getTime()) / DAY_MS) * 10) / 10);
}

// Quantities imported from a Deposco export are held for a while so the hourly sync doesn't
// immediately overwrite them (the export has Total Sellable Qty, which the API can't give us).
// The hold expires so imported numbers can't go stale forever without anyone noticing.
export const IMPORT_HOLD_MS = 3 * DAY_MS;
export function isImportHeld(item: { qtySource?: string; qtyImportedAt?: string }, nowMs: number): boolean {
  if (item.qtySource !== "import") return false;
  const at = Date.parse(item.qtyImportedAt ?? "");
  return Number.isFinite(at) && nowMs - at < IMPORT_HOLD_MS;
}

// ---- learned sale/day ("aggregate") --------------------------------------------------------
// Built from every day of outflow ever recorded (inventory_daily is never pruned), so it keeps
// improving as history accumulates. Two figures per SKU:
//   • lifetime: average units/day since tracking began, with one-off bulk days (a pallet to a
//     retailer, a big write-off) capped so they don't distort the everyday rate;
//   • projected: where the next `horizon` days should land given the time of year — recent
//     velocity scaled by what happened over the same stretch a year earlier. That needs a full
//     year of history first; until then it is null and `readyOn` says when it switches on.

// Caps each day at the SKU's 95th-percentile day once there are enough days to tell what's
// unusual (under that, every day is kept as-is).
export function capOutliers(values: number[]): number[] {
  if (values.length < 14) return values;
  const sorted = [...values].sort((a, b) => a - b);
  const cap = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))];
  return values.map((v) => Math.min(v, cap));
}

function dayList(startMs: number, days: number): string[] {
  return Array.from({ length: days }, (_, i) => dayKey(new Date(startMs + i * DAY_MS)));
}

function utcMidnight(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export type Learned = { lifetime: number | null; projected: number | null };

// `coverageStart` is when tracking began; days with no row count as zero outflow.
export function learnedSalePerDay(rows: DailyRow[], now: Date, coverageStart: Date, horizon = 30): Map<string, Learned> {
  const todayMs = utcMidnight(now);
  const startMs = utcMidnight(coverageStart);
  const totalDays = Math.round((todayMs - startMs) / DAY_MS) + 1;
  const bySku = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const k = r.sku.toLowerCase();
    let m = bySku.get(k);
    if (!m) bySku.set(k, (m = new Map()));
    m.set(r.day, (m.get(r.day) ?? 0) + r.outflow);
  }
  const out = new Map<string, Learned>();
  const allDays = dayList(startMs, Math.max(totalDays, 0));
  const avg = (m: Map<string, number>, from: number, days: number) =>
    dayList(from, days).reduce((n, d) => n + (m.get(d) ?? 0), 0) / days;
  // Year-ago comparison needs the trailing window a year back AND the stretch after it.
  const trailingStart = todayMs - 365 * DAY_MS - (horizon - 1) * DAY_MS;
  const seasonalReady = startMs <= trailingStart;
  for (const [sku, m] of bySku) {
    if (totalDays < 1) { out.set(sku, { lifetime: null, projected: null }); continue; }
    const capped = capOutliers(allDays.map((d) => m.get(d) ?? 0));
    const lifetime = Math.round((capped.reduce((a, b) => a + b, 0) / capped.length) * 100) / 100;
    let projected: number | null = null;
    if (seasonalReady) {
      const recent = capOutliers(allDays.map((d) => m.get(d) ?? 0)).slice(-horizon);
      const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
      const lastYearTrailing = avg(m, trailingStart, horizon);
      const lastYearAhead = avg(m, todayMs - 365 * DAY_MS + DAY_MS, horizon);
      // A SKU that didn't move at all in the year-ago baseline has nothing to scale from.
      if (lastYearTrailing > 0) {
        const index = Math.min(4, Math.max(0.25, lastYearAhead / lastYearTrailing));
        projected = Math.round(recentAvg * index * 100) / 100;
      }
    }
    out.set(sku, { lifetime, projected });
  }
  return out;
}

// The first day the year-ago comparison is possible, given when tracking began.
export function seasonalReadyOn(coverageStart: Date, horizon = 30): string {
  return dayKey(new Date(utcMidnight(coverageStart) + (365 + horizon - 1) * DAY_MS));
}
