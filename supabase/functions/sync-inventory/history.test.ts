import { outflowUnits, velocityPerDay, addTo, normalizeSku, isImportHeld, DAY_MS } from "./history.ts";

function eq(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
}

Deno.test("plain sales", () => eq(outflowUnits(500, 0, 0, 0, 450), 50, "sold 50"));
Deno.test("receipt hides sales without netting", () => eq(outflowUnits(100, 500, 0, 0, 450), 150, "sold 150 despite net +350"));
Deno.test("kitting out is not a sale", () => eq(outflowUnits(10000, 0, 0, 5000, 5000), 0, "components kitted"));
Deno.test("finished kits arriving", () => eq(outflowUnits(200, 0, 500, 0, 640), 60, "sold 60 while 500 kitted in"));
Deno.test("unexplained increase is not negative", () => eq(outflowUnits(100, 0, 0, 0, 130), 0, "no negative"));
Deno.test("addTo merges case", () => { const m = new Map(); addTo(m, "ABC-10", 5); addTo(m, "abc-10", 7); eq(m.get("abc-10"), 12, "merged"); });
Deno.test("velocity over covered time", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  const start = new Date(now.getTime() - 5 * DAY_MS);
  const rows = [{ day: "2026-10-16", sku: "A", outflow: 50 }, { day: "2026-10-19", sku: "A", outflow: 50 }, { day: "2026-09-01", sku: "A", outflow: 999 }];
  eq(velocityPerDay(rows, now, start, 7).get("a"), 20, "100 units over 5 covered days");
  eq(velocityPerDay(rows, now, new Date(now.getTime() - 0.5 * DAY_MS), 7).get("a"), null, "under a day -> null");
});

Deno.test("CUS prefix is ignored", () => {
  eq(normalizeSku("CUS BD-OUTER-MAILER-L"), "bd-outer-mailer-l", "prefix stripped");
  eq(normalizeSku("BD-STRTR-BOX"), "bd-strtr-box", "other SKUs untouched");
  eq(normalizeSku("cus-thing-10"), "cus-thing-10", "only 'CUS ' with a space");
});

Deno.test("import hold lasts 3 days then expires", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  const at = (h: number) => new Date(now - h * 3600000).toISOString();
  eq(isImportHeld({ qtySource: "import", qtyImportedAt: at(2) }, now), true, "fresh import held");
  eq(isImportHeld({ qtySource: "import", qtyImportedAt: at(71) }, now), true, "just under 3 days held");
  eq(isImportHeld({ qtySource: "import", qtyImportedAt: at(73) }, now), false, "over 3 days expired");
  eq(isImportHeld({ qtyImportedAt: at(1) }, now), false, "no source -> not held");
  eq(isImportHeld({ qtySource: "import" }, now), false, "no date -> not held");
});
