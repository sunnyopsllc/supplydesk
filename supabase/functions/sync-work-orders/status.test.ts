import { isRecentBlankStatus } from "./status.ts";
const now = Date.parse("2026-10-26T16:00:00Z");
const ago = (h: number) => new Date(now - h * 3600000).toISOString();
function eq(a: unknown, b: unknown, m: string) { if (a !== b) throw new Error(`${m}: got ${a} expected ${b}`); }
Deno.test("blank status updated today counts", () => eq(isRecentBlankStatus({ status: null, updatedDate: ago(6) }, now), true, "recent blank"));
Deno.test("blank status untouched for weeks does not", () => eq(isRecentBlankStatus({ status: null, updatedDate: ago(24 * 20) }, now), false, "old blank"));
Deno.test("blank but has an end date does not", () => eq(isRecentBlankStatus({ status: null, endDate: ago(5), updatedDate: ago(2) }, now), false, "ended"));
Deno.test("real statuses are not this function's job", () => { eq(isRecentBlankStatus({ status: "Open", updatedDate: ago(1) }, now), false, "open"); eq(isRecentBlankStatus({ status: "Complete", updatedDate: ago(1) }, now), false, "complete"); });
Deno.test("missing or bad date does not", () => eq(isRecentBlankStatus({ status: null }, now), false, "no date"));
