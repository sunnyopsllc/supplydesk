-- Inventory history for velocity tracking. Written only by the sync-inventory Edge
-- Function (service role); RLS is on with no policies, so nobody else can read or write.

create table if not exists public.inventory_state (
  sku         text primary key,
  on_hand     integer     not null,
  available   integer     not null,
  blocked     integer     not null default 0,
  taken_at    timestamptz not null,
  first_seen  timestamptz not null
);

create table if not exists public.inventory_daily (
  day         date    not null,
  sku         text    not null,
  outflow     integer not null default 0,  -- units that left (sold/shipped/scrapped)
  inbound     integer not null default 0,  -- received from Deposco receipts
  kitted_in   integer not null default 0,  -- finished kits completed by work orders
  kitted_out  integer not null default 0,  -- components consumed by work orders
  primary key (day, sku)
);

alter table public.inventory_state enable row level security;
alter table public.inventory_daily enable row level security;
