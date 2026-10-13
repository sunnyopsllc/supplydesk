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
// Auth/secrets work exactly like sync-work-orders: a logged-in Supply Desk user
// (the "Sync inventory" button) or the project's service role key (cron).

import { createClient } from "jsr:@supabase/supabase-js@2";

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
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!resp.ok) {
      throw new Error(`Deposco inventory request failed: ${resp.status} ${await resp.text()}`);
    }
    const data = await resp.json();
    records.push(...(data.data ?? []));
    if (data.complete) break;
    url = (data.links ?? []).find((l: any) => l.rel === "next")?.href ?? null;
  }
  return records;
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
    const isScheduledCall = callerToken === serviceRoleKey;

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

    const bySku = new Map<string, { onHand: number; available: number }>();
    for (const r of records) {
      const sku = String(r?.item?.businessKey?.number ?? "").trim().toLowerCase();
      if (!sku) continue;
      const cur = bySku.get(sku) ?? { onHand: 0, available: 0 };
      cur.onHand += Number(r?.inventory?.totalOnHandQuantity) || 0;
      cur.available += Number(r?.inventory?.availableQuantity) || 0;
      bySku.set(sku, cur);
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
    }

    state.meta = state.meta ?? {};
    state.meta.lastInventorySync = {
      at: new Date().toISOString(),
      facilities,
      records: records.length,
      matched,
      changed,
    };

    const { error: writeError } = await supabase
      .from("app_state")
      .update({ data: state, updated_at: new Date().toISOString() })
      .eq("id", 1);
    if (writeError) throw writeError;

    return new Response(
      JSON.stringify({ ok: true, records: records.length, deposcoSkus: bySku.size, matched, changed, notInDeposco }),
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
