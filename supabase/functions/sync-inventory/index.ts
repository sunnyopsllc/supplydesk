// Supabase Edge Function: sync-inventory
//
// Pulls on-hand inventory for Better Days from Deposco and writes it onto the
// matching Supply Desk items (matched by SKU, case-insensitive):
//   item.qty              <- availableQuantity    (sellable/ATP, same basis as the old manual import)
//   item.totalPhysicalQty <- totalOnHandQuantity
//   item.totalSellableQty <- availableQuantity
// summed across every facility queried. Items Supply Desk doesn't track are
// ignored (nothing is added), and tracked items Deposco has no record of are
// left untouched.
//
// Deposco's /inventory endpoint returns nothing for 3PL clients unless the
// facilities are named explicitly (their empty default facility filter is the
// bug we hit for weeks), so facilityNumbers is always sent. Override the list
// with the DEPOSCO_FACILITIES function secret (comma-separated); defaults to
// UT1,KY1.
//
// History: every sync also compares against the previous snapshot (table inventory_state)
// and logs how many units left per SKU (table inventory_daily), adding back anything that
// arrived since — Deposco receipts, and finished kits from completed work orders — and
// taking off components consumed by kitting. From that it writes item.velocity7d /
// velocity30d (units/day) onto each item. If the history tables don't exist yet, the sync
// still runs and just skips this part.
//
// Auth/secrets work exactly like sync-work-orders: a logged-in Supply Desk user
// (the "Sync inventory" button) or the project's service role key (cron).

import { createClient } from "jsr:@supabase/supabase-js@2";
import { coveredDays, dayKey, outflowUnits, velocityPerDay } from "./history.ts";
import { getInboundSince } from "./deposco.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PAGE_SIZE = 100;
const MAX_PAGES = 200;

async function getDeposcoAccessToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: Deno.env.get("DEPOSCO_REFRESH_TOKEN")!,
    client_id: Deno.env.get("DEPOSCO_CLIENT_ID")!,
    client_secret: Deno.env.get("DEPOSCO_CLIENT_SECRET")!,
  });
  const resp = await fetch("https://auth.deposco.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resp.ok) {
    throw new Error(`Deposco token request failed: ${resp.status} ${await resp.text()}`);
  }
  return (await resp.json()).access_token as string;
}

async function getAllInventory(accessToken: string, facilities: string): Promise<any[]> {
  let url: string | null = "https://api.deposco.com/latest/inventory?" + new URLSearchParams({
    pageSize: String(PAGE_SIZE),
    businessUnit: "Better Days",
    facilityNumbers: facilities,
  });
  const records: any[] = [];
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const resp: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!resp.ok) {
      throw new Error(`Deposco inventory request failed: ${resp.status} ${await resp.text()}`);
    }
    const data: any = await resp.json();
    records.push(...(data.data ?? []));
    if (data.complete) break;
    url = (data.links ?? []).find((l: any) => l.rel === "next")?.href ?? null;
  }
  return records;
}


async function fetchAll(table: string, columns: string, supabase: any, filter?: (q: any) => any): Promise<any[]> {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select(columns).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

// The platform's injected SUPABASE_SERVICE_ROLE_KEY is no longer byte-identical
// to the legacy JWT service key the cron job sends from Vault, so a plain string
// compare rejected the scheduled calls (401). Instead: confirm the token claims
// the service_role and prove it by making a call only the service role can make
// (Supabase's auth server verifies the signature, so a forged token fails).
async function isServiceRoleToken(token: string, supabaseUrl: string): Promise<boolean> {
  try {
    const part = token.split(".")[1];
    if (!part) return false;
    const claims = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    if (claims.role !== "service_role") return false;
    const probe = createClient(supabaseUrl, token);
    const { error } = await probe.auth.admin.listUsers({ page: 1, perPage: 1 });
    return !error;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization") ?? "";
    const callerToken = authHeader.replace(/^Bearer\s+/i, "");
    const isScheduledCall = callerToken === serviceRoleKey || await isServiceRoleToken(callerToken, supabaseUrl);

    if (!isScheduledCall) {
      const callerClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userData, error: userError } = await callerClient.auth.getUser(callerToken);
      if (userError || !userData?.user) {
        return new Response(JSON.stringify({ ok: false, error: "Not authenticated" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const facilities = Deno.env.get("DEPOSCO_FACILITIES") || "UT1,KY1";
    const accessToken = await getDeposcoAccessToken();
    const records = await getAllInventory(accessToken, facilities);

    // A response with zero records is far more likely to be an upstream problem
    // than an empty warehouse — refuse rather than zeroing out every item.
    if (records.length === 0) {
      throw new Error("Deposco returned no inventory records; leaving Supply Desk untouched.");
    }

    const bySku = new Map<string, { onHand: number; available: number; blocked: number }>();
    for (const r of records) {
      const sku = String(r?.item?.businessKey?.number ?? "").trim().toLowerCase();
      if (!sku) continue;
      const cur = bySku.get(sku) ?? { onHand: 0, available: 0, blocked: 0 };
      cur.onHand += Number(r?.inventory?.totalOnHandQuantity) || 0;
      cur.available += Number(r?.inventory?.availableQuantity) || 0;
      cur.blocked += Number(r?.inventory?.blockedQuantity) || 0;
      bySku.set(sku, cur);
    }


    // ---- inventory history / velocity (never allowed to break the main sync) ----
    const now = new Date();
    const velocity7 = new Map<string, number | null>();
    const velocity30 = new Map<string, number | null>();
    let historyDays = 0;
    const history: Record<string, unknown> = { enabled: false };
    try {
      const prevRows = await fetchAll("inventory_state", "sku,on_hand,taken_at,first_seen", supabase);
      history.enabled = true;
      const prev = new Map<string, { onHand: number; takenAt: number; firstSeen: string }>();
      for (const r of prevRows) prev.set(String(r.sku).toLowerCase(), { onHand: Number(r.on_hand), takenAt: Date.parse(r.taken_at), firstSeen: r.first_seen });

      if (prev.size > 0) {
        const since = new Date(Math.max(...[...prev.values()].map((v) => v.takenAt)));
        const flows = await getInboundSince(accessToken, since, now);
        Object.assign(history, { since: since.toISOString(), receipts: flows.receiptCount, completedWorkOrders: flows.woCount });

        const today = dayKey(now);
        const todayRows = new Map<string, any>();
        for (const r of await fetchAll("inventory_daily", "day,sku,outflow,inbound,kitted_in,kitted_out", supabase, (q) => q.eq("day", today))) {
          todayRows.set(String(r.sku).toLowerCase(), r);
        }
        const upserts: any[] = [];
        let withOutflow = 0;
        for (const [sku, cur] of bySku) {
          const p = prev.get(sku);
          if (!p) continue;
          const inb = flows.inbound.get(sku) ?? 0, kin = flows.kittedIn.get(sku) ?? 0, kout = flows.kittedOut.get(sku) ?? 0;
          const out = outflowUnits(p.onHand, inb, kin, kout, cur.onHand);
          if (!out && !inb && !kin && !kout) continue;
          if (out) withOutflow++;
          const t = todayRows.get(sku);
          upserts.push({
            day: today, sku,
            outflow: (Number(t?.outflow) || 0) + out,
            inbound: (Number(t?.inbound) || 0) + inb,
            kitted_in: (Number(t?.kitted_in) || 0) + kin,
            kitted_out: (Number(t?.kitted_out) || 0) + kout,
          });
        }
        for (let i = 0; i < upserts.length; i += 500) {
          const { error } = await supabase.from("inventory_daily").upsert(upserts.slice(i, i + 500), { onConflict: "day,sku" });
          if (error) throw error;
        }
        history.skusWithOutflow = withOutflow;
      } else {
        history.baseline = true;
      }

      const stateRows = [...bySku].map(([sku, cur]) => ({
        sku, on_hand: cur.onHand, available: cur.available, blocked: cur.blocked,
        taken_at: now.toISOString(), first_seen: prev.get(sku)?.firstSeen ?? now.toISOString(),
      }));
      for (let i = 0; i < stateRows.length; i += 500) {
        const { error } = await supabase.from("inventory_state").upsert(stateRows.slice(i, i + 500), { onConflict: "sku" });
        if (error) throw error;
      }

      const firstSeen = new Date(Math.min(...stateRows.map((r) => Date.parse(r.first_seen))));
      historyDays = coveredDays(now, firstSeen);
      const since30 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 29 * 86400000);
      const dailyRows = (await fetchAll("inventory_daily", "day,sku,outflow", supabase, (q) => q.gte("day", dayKey(since30))))
        .map((r) => ({ day: r.day as string, sku: r.sku as string, outflow: Number(r.outflow) || 0 }));
      for (const [k, v] of velocityPerDay(dailyRows, now, firstSeen, 7)) velocity7.set(k, v);
      for (const [k, v] of velocityPerDay(dailyRows, now, firstSeen, 30)) velocity30.set(k, v);
      history.days = historyDays;
    } catch (e) {
      console.error("inventory history skipped:", e);
      history.error = String((e as Error)?.message ?? e);
    }

    const { data: row, error: readError } = await supabase
      .from("app_state").select("data").eq("id", 1).single();
    if (readError) throw readError;

    const state = row.data;
    let matched = 0, changed = 0, notInDeposco = 0;

    for (const item of state.items ?? []) {
      const inv = bySku.get(String(item.sku ?? "").trim().toLowerCase());
      if (!inv) { notInDeposco++; continue; }
      matched++;
      if (item.qty !== inv.available || item.totalPhysicalQty !== inv.onHand || item.totalSellableQty !== inv.available) {
        item.qty = inv.available;
        item.totalPhysicalQty = inv.onHand;
        item.totalSellableQty = inv.available;
        changed++;
      }
      if (history.enabled === true && !history.error) {
        const key = String(item.sku ?? "").trim().toLowerCase();
        // No recorded outflow in a window that's been tracked long enough means 0, not "unknown".
        item.velocity7d = historyDays >= 1 ? (velocity7.get(key) ?? 0) : null;
        item.velocity30d = historyDays >= 1 ? (velocity30.get(key) ?? 0) : null;
        item.velocityDays = historyDays;
      }
    }

    state.meta = state.meta ?? {};
    state.meta.lastInventorySync = {
      at: new Date().toISOString(),
      facilities,
      records: records.length,
      matched,
      changed,
      history,
    };

    const { error: writeError } = await supabase
      .from("app_state")
      .update({ data: state, updated_at: new Date().toISOString() })
      .eq("id", 1);
    if (writeError) throw writeError;

    return new Response(
      JSON.stringify({ ok: true, records: records.length, deposcoSkus: bySku.size, matched, changed, notInDeposco, history }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ ok: false, error: String((err as Error)?.message ?? err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
