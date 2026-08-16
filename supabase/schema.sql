-- ============================================================
-- ARRZ MARKET — Skema Database Supabase (PostgreSQL)
-- Jalankan di Supabase SQL Editor
-- ============================================================

-- Ekstensi untuk generate UUID
create extension if not exists "uuid-ossp";

-- ── CATEGORIES ──────────────────────────────────────────────
create table if not exists categories (
  id uuid primary key default uuid_generate_v4(),
  name text not null unique,
  slug text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── ACCOUNTS ─────────────────────────────────────────────────
create sequence if not exists account_code_seq start 1;

create table if not exists accounts (
  id uuid primary key default uuid_generate_v4(),
  account_code text not null unique default ('ACC-' || lpad(nextval('account_code_seq')::text, 5, '0')),
  name text not null,
  platform text not null,
  category_id uuid references categories(id) on delete set null,
  username text,
  price numeric(14,2) not null default 0,
  description text,
  details text,
  features text,
  status text not null default 'AVAILABLE' check (status in ('AVAILABLE', 'SOLD')),
  featured boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_accounts_status on accounts(status);
create index if not exists idx_accounts_category on accounts(category_id);
create index if not exists idx_accounts_featured on accounts(featured);

-- ── ACCOUNT IMAGES ───────────────────────────────────────────
create table if not exists account_images (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  image_url text not null,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_account_images_account on account_images(account_id);

-- ── SELL REQUESTS (pengajuan jual dari user publik) ─────────
create table if not exists sell_requests (
  id uuid primary key default uuid_generate_v4(),
  seller_name text not null,
  seller_whatsapp text not null,
  seller_email text,
  account_name text not null,
  platform text not null,
  category_id uuid references categories(id) on delete set null,
  username text,
  desired_price numeric(14,2),
  description text,
  details text,
  features text,
  additional_info text,
  photo_urls text[] default '{}',
  status text not null default 'PENDING' check (status in ('PENDING', 'REVIEW', 'ACCEPTED', 'REJECTED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_sell_requests_status on sell_requests(status);

-- ── OFFERS (tawaran harga) ───────────────────────────────────
create table if not exists offers (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  original_price numeric(14,2) not null,
  offer_price numeric(14,2) not null,
  buyer_name text not null,
  buyer_whatsapp text not null,
  note text,
  status text not null default 'PENDING' check (status in ('PENDING', 'ACCEPTED', 'REJECTED', 'COMPLETED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_offers_account on offers(account_id);
create index if not exists idx_offers_status on offers(status);

-- ── TRANSACTIONS ─────────────────────────────────────────────
create table if not exists transactions (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid references accounts(id) on delete set null,
  buyer_name text not null,
  buyer_whatsapp text not null,
  price numeric(14,2) not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_transactions_status on transactions(status);

-- ── SITE SETTINGS (single row) ──────────────────────────────
create table if not exists site_settings (
  id int primary key default 1,
  site_name text not null default 'ARRZ MARKET',
  logo_url text,
  admin_whatsapp text,
  admin_email text,
  social_media jsonb default '{}',
  footer_text text,
  wa_template_buy text,
  wa_template_offer text,
  wa_template_sell text,
  updated_at timestamptz not null default now(),
  constraint single_row check (id = 1)
);

insert into site_settings (id, site_name)
values (1, 'ARRZ MARKET')
on conflict (id) do nothing;

-- ── ADMIN PROFILES ───────────────────────────────────────────
-- Password disimpan sebagai bcrypt hash, TIDAK PERNAH plaintext.
create table if not exists admin_profiles (
  id uuid primary key default uuid_generate_v4(),
  username text not null unique,
  password_hash text not null,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Catatan: baris admin awal (username: kenzstr) di-seed lewat script Node.js
-- (lib/seedAdmin.js) agar password di-hash dengan bcrypt sebelum masuk DB,
-- bukan lewat SQL mentah.

-- ── TRIGGER: auto update updated_at ──────────────────────────
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_accounts_updated_at on accounts;
create trigger trg_accounts_updated_at before update on accounts
  for each row execute function set_updated_at();

drop trigger if exists trg_categories_updated_at on categories;
create trigger trg_categories_updated_at before update on categories
  for each row execute function set_updated_at();

drop trigger if exists trg_sell_requests_updated_at on sell_requests;
create trigger trg_sell_requests_updated_at before update on sell_requests
  for each row execute function set_updated_at();

drop trigger if exists trg_offers_updated_at on offers;
create trigger trg_offers_updated_at before update on offers
  for each row execute function set_updated_at();

drop trigger if exists trg_transactions_updated_at on transactions;
create trigger trg_transactions_updated_at before update on transactions
  for each row execute function set_updated_at();

drop trigger if exists trg_admin_profiles_updated_at on admin_profiles;
create trigger trg_admin_profiles_updated_at before update on admin_profiles
  for each row execute function set_updated_at();

-- ── ROW LEVEL SECURITY ───────────────────────────────────────
alter table accounts enable row level security;
alter table account_images enable row level security;
alter table categories enable row level security;
alter table sell_requests enable row level security;
alter table offers enable row level security;
alter table transactions enable row level security;
alter table site_settings enable row level security;
alter table admin_profiles enable row level security;

-- Publik boleh MEMBACA data akun/kategori/gambar/settings yang memang
-- ditampilkan di marketplace. Semua tulis (insert/update/delete) hanya
-- lewat backend Node.js memakai service_role key (bypass RLS),
-- jadi tidak perlu policy write untuk anon di sini.
create policy "Publik dapat membaca accounts" on accounts
  for select using (true);

create policy "Publik dapat membaca account_images" on account_images
  for select using (true);

create policy "Publik dapat membaca categories" on categories
  for select using (true);

create policy "Publik dapat membaca site_settings" on site_settings
  for select using (true);

-- sell_requests, offers, transactions, admin_profiles: TIDAK ada policy
-- select/insert untuk anon — semua akses wajib lewat backend (service role),
-- supaya data pembeli/penjual/kredensial admin tidak bisa dibaca langsung
-- dari client.
