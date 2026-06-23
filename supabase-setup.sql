-- ============================================================
--  Removals CRM — Supabase setup
--  Run this whole file once in your NEW project's SQL Editor
--  (Supabase dashboard → SQL Editor → New query → paste → Run)
-- ============================================================

-- ---------- TABLES ----------
create table if not exists customers (
  id text primary key,
  name text, company text, phone text, email text,
  address1 text, address2 text, town text, county text, postcode text,
  cust_type text, notes text,
  updated_at bigint, created_at text
);

create table if not exists enquiries (
  id text primary key,
  customer_id text,
  status text,
  enquiry_date text, preferred_date text, date_flexible boolean default false,
  from_address1 text, from_town text, from_postcode text,
  from_property_type text, from_bedrooms text, from_floor text, from_access text,
  to_address1 text, to_town text, to_postcode text,
  to_property_type text, to_floor text, to_access text,
  distance_miles text,
  inventory jsonb default '[]'::jsonb,
  volume_cuft numeric default 0, volume_m3 numeric default 0, weight_kg numeric default 0,
  extras jsonb default '[]'::jsonb,
  quote_lines jsonb default '[]'::jsonb,
  quote_vat boolean default false, quote_total numeric default 0,
  quote_status text, quote_sent_date text,
  follow_up_date text, follow_up_note text,
  lost_reason text, notes text,
  updated_at bigint, created_at text
);

create table if not exists jobs (
  id text primary key,
  customer_id text, enquiry_id text,
  move_date text, start_time text,
  from_address1 text, from_town text, from_postcode text, from_access text,
  to_address1 text, to_town text, to_postcode text, to_access text,
  crew jsonb default '[]'::jsonb, vehicle text,
  volume_cuft numeric default 0, volume_m3 numeric default 0, weight_kg numeric default 0,
  price numeric default 0, deposit numeric default 0,
  deposit_paid boolean default false, balance_paid boolean default false,
  status text, notes text,
  updated_at bigint, created_at text
);

-- ---------- ROW LEVEL SECURITY ----------
-- The app uses the publishable (anon) key, so policies must grant `anon`.
alter table customers enable row level security;
alter table enquiries enable row level security;
alter table jobs      enable row level security;

drop policy if exists "anon all customers" on customers;
drop policy if exists "anon all enquiries" on enquiries;
drop policy if exists "anon all jobs"      on jobs;

create policy "anon all customers" on customers for all to anon using (true) with check (true);
create policy "anon all enquiries" on enquiries for all to anon using (true) with check (true);
create policy "anon all jobs"      on jobs      for all to anon using (true) with check (true);

-- ---------- REALTIME (live multi-device sync) ----------
-- replica identity full makes DELETE events carry the row id (needed for tombstones).
alter table customers replica identity full;
alter table enquiries replica identity full;
alter table jobs      replica identity full;

-- Add tables to the realtime publication.
-- If you get "table is already member of publication", that line is safe to ignore.
alter publication supabase_realtime add table customers;
alter publication supabase_realtime add table enquiries;
alter publication supabase_realtime add table jobs;

-- ---------- (OPTIONAL) PHOTO STORAGE ----------
-- Only needed later if you add survey/condition photos. In the dashboard:
--   Storage → New bucket → name "move-photos" → Public bucket → Save
