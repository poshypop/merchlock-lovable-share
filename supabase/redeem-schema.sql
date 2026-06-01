create extension if not exists pgcrypto;

create table if not exists public.mod_files (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  description text not null default '',
  storage_bucket text not null default 'redeem-mods',
  storage_path text not null,
  file_name text not null default 'download.zip',
  content_type text not null default 'application/octet-stream',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.steam_users (
  id uuid primary key default gen_random_uuid(),
  steam_id text not null unique,
  persona_name text not null default '',
  avatar_url text not null default '',
  profile_url text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_sessions (
  id uuid primary key default gen_random_uuid(),
  session_hash text not null unique,
  steam_user_id uuid not null references public.steam_users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  kind text not null default 'virtual' check (kind in ('physical', 'virtual')),
  description text not null default '',
  image_path text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.inventory_items (slug, title, kind, description, image_path)
values
  (
    'rem_plushie',
    'Rem Plushie',
    'physical',
    'Ready-to-ship Merchlock plushie designed by DIECHANCE.',
    'assets/rem-product.png'
  ),
  (
    'rem_bag_skin',
    'Rem Bag Skin',
    'virtual',
    'Merchlock virtual reward for the Rem bag skin fan mod.',
    'assets/rem-detail.svg'
  )
on conflict (slug) do update set
  title = excluded.title,
  kind = excluded.kind,
  description = excluded.description,
  image_path = excluded.image_path,
  active = true;

create table if not exists public.user_inventory (
  id uuid primary key default gen_random_uuid(),
  steam_user_id uuid not null references public.steam_users(id) on delete cascade,
  item_id uuid not null references public.inventory_items(id) on delete cascade,
  source_type text not null,
  source_ref text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  acquired_at timestamptz not null default now(),
  unique (steam_user_id, item_id)
);

create table if not exists public.inventory_events (
  id bigserial primary key,
  steam_user_id uuid references public.steam_users(id) on delete set null,
  item_id uuid references public.inventory_items(id) on delete set null,
  event_type text not null,
  source_type text not null default '',
  source_ref text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.shopify_order_events (
  id bigserial primary key,
  webhook_id text not null unique,
  event_id text not null default '',
  order_id text not null default '',
  steam_id text,
  inventory_item_slug text,
  status text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.redeem_codes (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  mod_file_id uuid not null references public.mod_files(id) on delete cascade,
  code_hash text not null unique,
  code_prefix text,
  code_suffix text,
  code_type text not null default 'one_time_download',
  inventory_item_slug text references public.inventory_items(slug),
  max_uses_per_user integer not null default 1,
  shared_uses integer not null default 0,
  status text not null default 'active' check (status in ('active', 'redeemed', 'disabled')),
  notes text not null default '',
  redeemed_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.redeem_codes add column if not exists code_type text not null default 'one_time_download';
alter table public.redeem_codes add column if not exists inventory_item_slug text references public.inventory_items(slug);
alter table public.redeem_codes add column if not exists max_uses_per_user integer not null default 1;
alter table public.redeem_codes add column if not exists shared_uses integer not null default 0;

create table if not exists public.redeem_code_claims (
  id uuid primary key default gen_random_uuid(),
  code_id uuid not null references public.redeem_codes(id) on delete cascade,
  steam_user_id uuid not null references public.steam_users(id) on delete cascade,
  status text not null default 'redeemed',
  user_agent text,
  created_at timestamptz not null default now(),
  unique (code_id, steam_user_id)
);

create table if not exists public.redeem_events (
  id bigserial primary key,
  code_id uuid references public.redeem_codes(id) on delete set null,
  mod_file_id uuid references public.mod_files(id) on delete set null,
  steam_user_id uuid references public.steam_users(id) on delete set null,
  event_type text not null,
  reason text,
  user_agent text,
  created_at timestamptz not null default now()
);

alter table public.redeem_events add column if not exists steam_user_id uuid references public.steam_users(id) on delete set null;

create index if not exists steam_users_steam_id_idx on public.steam_users(steam_id);
create index if not exists user_sessions_hash_idx on public.user_sessions(session_hash);
create index if not exists user_sessions_user_idx on public.user_sessions(steam_user_id);
create index if not exists inventory_items_slug_idx on public.inventory_items(slug);
create index if not exists user_inventory_user_idx on public.user_inventory(steam_user_id);
create index if not exists user_inventory_item_idx on public.user_inventory(item_id);
create index if not exists inventory_events_user_idx on public.inventory_events(steam_user_id);
create index if not exists shopify_order_events_webhook_idx on public.shopify_order_events(webhook_id);
create index if not exists shopify_order_events_order_idx on public.shopify_order_events(order_id);
create index if not exists redeem_codes_batch_idx on public.redeem_codes(batch_id);
create index if not exists redeem_codes_mod_idx on public.redeem_codes(mod_file_id);
create index if not exists redeem_codes_status_idx on public.redeem_codes(status);
create index if not exists redeem_codes_type_idx on public.redeem_codes(code_type);
create index if not exists redeem_claims_code_idx on public.redeem_code_claims(code_id);
create index if not exists redeem_claims_user_idx on public.redeem_code_claims(steam_user_id);

alter table public.mod_files enable row level security;
alter table public.steam_users enable row level security;
alter table public.user_sessions enable row level security;
alter table public.inventory_items enable row level security;
alter table public.user_inventory enable row level security;
alter table public.inventory_events enable row level security;
alter table public.shopify_order_events enable row level security;
alter table public.redeem_codes enable row level security;
alter table public.redeem_code_claims enable row level security;
alter table public.redeem_events enable row level security;

insert into storage.buckets (id, name, public)
values ('redeem-mods', 'redeem-mods', false)
on conflict (id) do nothing;

create or replace function public.redeem_code(
  lookup_hash text,
  request_user_agent text default null
)
returns table (
  ok boolean,
  reason text,
  code_id uuid,
  mod_file_id uuid,
  title text,
  description text,
  storage_bucket text,
  storage_path text,
  file_name text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
begin
  select
    rc.id,
    rc.mod_file_id,
    rc.status,
    rc.code_type,
    mf.title,
    mf.description,
    mf.storage_bucket,
    mf.storage_path,
    mf.file_name,
    mf.active as mod_active
  into rec
  from public.redeem_codes rc
  join public.mod_files mf on mf.id = rc.mod_file_id
  where rc.code_hash = lookup_hash
  for update;

  if not found then
    insert into public.redeem_events(event_type, reason, user_agent)
    values ('failed', 'invalid', request_user_agent);

    return query select
      false,
      'Code is invalid.',
      null::uuid,
      null::uuid,
      null::text,
      null::text,
      null::text,
      null::text,
      null::text;
    return;
  end if;

  if rec.code_type = 'shared_reward_download' then
    insert into public.redeem_events(code_id, mod_file_id, event_type, reason, user_agent)
    values (rec.id, rec.mod_file_id, 'failed', 'Steam sign-in is required for shared reward codes.', request_user_agent);

    return query select
      false,
      'Steam sign-in is required for this shared reward code.',
      rec.id,
      rec.mod_file_id,
      rec.title,
      rec.description,
      rec.storage_bucket,
      rec.storage_path,
      rec.file_name;
    return;
  end if;

  if rec.status = 'disabled' then
    insert into public.redeem_events(code_id, mod_file_id, event_type, reason, user_agent)
    values (rec.id, rec.mod_file_id, 'failed', 'Code is disabled.', request_user_agent);

    return query select false, 'Code is disabled.', rec.id, rec.mod_file_id, rec.title, rec.description, rec.storage_bucket, rec.storage_path, rec.file_name;
    return;
  end if;

  if rec.status = 'redeemed' then
    insert into public.redeem_events(code_id, mod_file_id, event_type, reason, user_agent)
    values (rec.id, rec.mod_file_id, 'failed', 'Code was already redeemed.', request_user_agent);

    return query select false, 'Code was already redeemed.', rec.id, rec.mod_file_id, rec.title, rec.description, rec.storage_bucket, rec.storage_path, rec.file_name;
    return;
  end if;

  if rec.mod_active is not true then
    insert into public.redeem_events(code_id, mod_file_id, event_type, reason, user_agent)
    values (rec.id, rec.mod_file_id, 'failed', 'Download is not available yet.', request_user_agent);

    return query select false, 'Download is not available yet.', rec.id, rec.mod_file_id, rec.title, rec.description, rec.storage_bucket, rec.storage_path, rec.file_name;
    return;
  end if;

  update public.redeem_codes
  set status = 'redeemed', redeemed_at = now()
  where id = rec.id;

  insert into public.redeem_events(code_id, mod_file_id, event_type, reason, user_agent)
  values (rec.id, rec.mod_file_id, 'redeemed', 'Code redeemed.', request_user_agent);

  return query select
    true,
    'Code redeemed.',
    rec.id,
    rec.mod_file_id,
    rec.title,
    rec.description,
    rec.storage_bucket,
    rec.storage_path,
    rec.file_name;
end;
$$;
