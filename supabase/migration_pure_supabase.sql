-- ============================================================
-- ARRZ MARKET — Migrasi ke Pure Supabase (REVISI 2)
-- Jalankan SETELAH schema.sql lama sudah ada di database.
-- Jalankan di Supabase SQL Editor, urut dari atas ke bawah.
-- Aman dijalankan ulang (idempotent) berkat "if exists"/"or replace".
-- ============================================================

-- 1. HAPUS AUTH LAMA (bcrypt manual) — diganti Supabase Auth
drop table if exists admin_profiles cascade;

-- Pastikan gen_random_uuid() tersedia (dipakai generator kode akun acak).
create extension if not exists pgcrypto;

-- 2. PROFILES — menyimpan role tiap user Supabase Auth
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'user' check (role in ('user', 'admin')),
  full_name text,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

drop policy if exists "User baca profile sendiri" on profiles;
create policy "User baca profile sendiri" on profiles
  for select using (auth.uid() = id);

drop policy if exists "User update profile sendiri" on profiles;
create policy "User update profile sendiri" on profiles
  for update using (auth.uid() = id);

-- auto-insert row profiles saat ada user baru daftar
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- helper: cek apakah user yang login adalah admin
create or replace function public.is_admin()
returns boolean as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$ language sql security definer stable;

-- ============================================================
-- 2B. KODE AKUN ACAK (bukan lagi sequential ACC-00001, ACC-00002, ...)
-- Kode lama gampang ditebak urutannya (mis. ACC-00019 → tinggal
-- tebak ACC-00020). Diganti kode acak 6 karakter, contoh: ARZ-7F3K9X.
-- Dipakai juga oleh fitur "Cari Akun" admin.
-- ============================================================
create or replace function public.generate_account_code()
returns text
language plpgsql
as $$
declare
  candidate text;
  tries int := 0;
begin
  loop
    candidate := 'ARZ-' || upper(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 6));
    exit when not exists (select 1 from public.accounts where account_code = candidate);
    tries := tries + 1;
    -- fallback super jarang: perpanjang kode kalau 20x tabrakan beruntun
    if tries > 20 then
      candidate := 'ARZ-' || upper(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 10));
      exit;
    end if;
  end loop;
  return candidate;
end;
$$;

create or replace function public.set_account_code()
returns trigger
language plpgsql
as $$
begin
  if new.account_code is null or btrim(new.account_code) = '' then
    new.account_code := public.generate_account_code();
  end if;
  return new;
end;
$$;

-- Matikan default lama yang sequential (kolom tetap ada & terisi via trigger)
alter table accounts alter column account_code drop default;

drop trigger if exists trg_accounts_set_code on accounts;
create trigger trg_accounts_set_code
  before insert on accounts
  for each row execute function public.set_account_code();

-- ============================================================
-- 3. RESET SEMUA POLICY LAMA (biar tidak dobel saat re-run)
-- ============================================================
drop policy if exists "Publik dapat membaca accounts" on accounts;
drop policy if exists "Publik baca accounts" on accounts;
drop policy if exists "Admin kelola accounts" on accounts;
drop policy if exists "Publik dapat membaca account_images" on account_images;
drop policy if exists "Publik baca account_images" on account_images;
drop policy if exists "Admin kelola account_images" on account_images;
drop policy if exists "Publik dapat membaca categories" on categories;
drop policy if exists "Publik baca categories" on categories;
drop policy if exists "Admin kelola categories" on categories;
drop policy if exists "Publik dapat membaca site_settings" on site_settings;
drop policy if exists "Publik baca site_settings" on site_settings;
drop policy if exists "Admin update site_settings" on site_settings;
drop policy if exists "Publik buat offer" on offers;
drop policy if exists "Admin kelola offers" on offers;
drop policy if exists "Admin kelola transactions" on transactions;
drop policy if exists "Publik buat transaction" on transactions;
drop policy if exists "Publik buat sell_request" on sell_requests;
drop policy if exists "Admin kelola sell_requests" on sell_requests;

-- ============================================================
-- 4. ACCOUNTS — publik baca, admin CRUD penuh
-- ============================================================
create policy "Publik baca accounts" on accounts
  for select using (true);
create policy "Admin kelola accounts" on accounts
  for all using (public.is_admin()) with check (public.is_admin());

-- ============================================================
-- 5. ACCOUNT_IMAGES
-- ============================================================
create policy "Publik baca account_images" on account_images
  for select using (true);
create policy "Admin kelola account_images" on account_images
  for all using (public.is_admin()) with check (public.is_admin());

-- ============================================================
-- 6. CATEGORIES
-- ============================================================
create policy "Publik baca categories" on categories
  for select using (true);
create policy "Admin kelola categories" on categories
  for all using (public.is_admin()) with check (public.is_admin());

-- ============================================================
-- 7. SITE_SETTINGS
-- ============================================================
create policy "Publik baca site_settings" on site_settings
  for select using (true);
create policy "Admin update site_settings" on site_settings
  for update using (public.is_admin()) with check (public.is_admin());

-- ============================================================
-- 8. OFFERS — publik insert (klik Tawar), admin kelola status
-- ============================================================
create policy "Publik buat offer" on offers
  for insert with check (
    exists (select 1 from accounts where id = account_id and status = 'AVAILABLE')
  );
create policy "Admin kelola offers" on offers
  for all using (public.is_admin()) with check (public.is_admin());

-- ============================================================
-- 9. TRANSACTIONS — publik insert (klik Beli Sekarang), admin kelola status
-- ============================================================
create policy "Publik buat transaction" on transactions
  for insert with check (
    exists (select 1 from accounts where id = account_id and status = 'AVAILABLE')
  );
create policy "Admin kelola transactions" on transactions
  for all using (public.is_admin()) with check (public.is_admin());

-- Trigger: saat admin ubah status transaksi jadi COMPLETED, otomatis
-- tandai account terkait SOLD (dulu ini 2 langkah manual di Express).
create or replace function public.sync_account_on_transaction_complete()
returns trigger as $$
begin
  if new.status = 'COMPLETED' and new.account_id is not null
     and (old.status is distinct from 'COMPLETED') then
    update accounts set status = 'SOLD' where id = new.account_id;
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_transaction_complete_sync on transactions;
create trigger trg_transaction_complete_sync
  after update on transactions
  for each row execute function public.sync_account_on_transaction_complete();

-- ============================================================
-- 10. SELL_REQUESTS — publik insert (ajukan jual), admin kelola status
-- ============================================================
create policy "Publik buat sell_request" on sell_requests
  for insert with check (true);
create policy "Admin kelola sell_requests" on sell_requests
  for all using (public.is_admin()) with check (public.is_admin());

-- ============================================================
-- 11. REALTIME — daftarkan tabel ke publication
-- ============================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'accounts'
  ) then
    alter publication supabase_realtime add table public.accounts;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'categories'
  ) then
    alter publication supabase_realtime add table public.categories;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'offers'
  ) then
    alter publication supabase_realtime add table public.offers;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'transactions'
  ) then
    alter publication supabase_realtime add table public.transactions;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sell_requests'
  ) then
    alter publication supabase_realtime add table public.sell_requests;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'site_settings'
  ) then
    alter publication supabase_realtime add table public.site_settings;
  end if;
end $$;

-- ============================================================
-- 12. STORAGE — bucket account-images + policy
-- Struktur folder wajib:
--   account-images/accounts/{account_id}/...      → khusus ADMIN
--   account-images/sell-requests/{id-or-random}/.. → publik (form Jual Akun)
-- Sebelumnya kebijakan insert tidak membatasi folder sama sekali,
-- artinya user publik bisa saja menulis ke folder accounts/ milik
-- admin. Sekarang dibatasi per-folder pakai storage.foldername(name).
-- ============================================================
insert into storage.buckets (id, name, public)
values ('account-images', 'account-images', true)
on conflict (id) do nothing;

drop policy if exists "Publik baca account-images" on storage.objects;
drop policy if exists "Admin upload account-images" on storage.objects;
drop policy if exists "Publik upload account-images" on storage.objects;
drop policy if exists "Admin hapus account-images" on storage.objects;
drop policy if exists "Publik upload sell-requests" on storage.objects;
drop policy if exists "Admin upload accounts" on storage.objects;
drop policy if exists "Admin update account-images storage" on storage.objects;

-- Baca: publik (bucket sudah public juga, policy ini untuk kejelasan RLS)
create policy "Publik baca account-images" on storage.objects
  for select using (bucket_id = 'account-images');

-- Insert: publik HANYA boleh menulis ke folder sell-requests/
create policy "Publik upload sell-requests" on storage.objects
  for insert with check (
    bucket_id = 'account-images'
    and (storage.foldername(name))[1] = 'sell-requests'
  );

-- Insert: admin HANYA (biasanya) menulis ke folder accounts/, tapi tetap
-- diberi akses insert ke folder lain juga (mis. saat convert sell-request)
create policy "Admin upload accounts" on storage.objects
  for insert with check (
    bucket_id = 'account-images'
    and public.is_admin()
  );

-- Update: hanya admin (mis. ganti/replace foto)
create policy "Admin update account-images storage" on storage.objects
  for update using (bucket_id = 'account-images' and public.is_admin())
  with check (bucket_id = 'account-images' and public.is_admin());

-- Delete: hanya admin — user publik tidak boleh hapus foto siapa pun,
-- termasuk foto miliknya sendiri di sell-requests/.
create policy "Admin hapus account-images" on storage.objects
  for delete using (bucket_id = 'account-images' and public.is_admin());

-- ============================================================
-- 13. SET ADMIN PERTAMA
-- Jalankan manual SETELAH user pertama daftar lewat Supabase Auth
-- (Authentication → Add user, atau lewat signUp dari kode sekali pakai).
-- ============================================================
-- update public.profiles set role = 'admin' where id = 'UUID_USER_ADMIN';
