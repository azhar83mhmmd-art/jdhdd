-- ============================================================
-- ARRZ MARKET — Migrasi: Sistem Pembelian QRIS DANA Bisnis MANUAL
-- Jalankan SETELAH schema.sql + migration_pure_supabase.sql sudah ada.
-- Jalankan di Supabase SQL Editor, urut dari atas ke bawah.
-- Aman dijalankan ulang (idempotent) berkat IF NOT EXISTS / IF EXISTS.
--
-- TIDAK ADA payment gateway, webhook, atau verifikasi otomatis di sini.
-- Semua status PAID hanya boleh ditetapkan oleh ADMIN secara manual.
-- ============================================================

-- ============================================================
-- 1. ACCOUNTS — tambah status RESERVED (dipakai saat invoice dibuat,
--    supaya 2 pembeli tidak bisa checkout akun yang sama bersamaan)
-- ============================================================
alter table accounts drop constraint if exists accounts_status_check;
alter table accounts add constraint accounts_status_check
  check (status in ('AVAILABLE', 'RESERVED', 'SOLD'));

-- ============================================================
-- 2. TRANSACTIONS — kolom baru untuk alur invoice + QRIS manual.
--    Kolom lama (status, buyer_name, note) TETAP ADA (tidak dihapus),
--    tapi alur baru memakai payment_status / transaction_status.
-- ============================================================
alter table transactions alter column buyer_name drop not null;

alter table transactions add column if not exists invoice_id text;
alter table transactions add column if not exists buyer_email text;
alter table transactions add column if not exists buyer_instagram text;
alter table transactions add column if not exists payment_method text default 'QRIS_DANA_BISNIS';
alter table transactions add column if not exists sender_name text;
alter table transactions add column if not exists sender_account_number text;
alter table transactions add column if not exists payment_proof_path text;
alter table transactions add column if not exists payment_status text not null default 'PENDING_PAYMENT';
alter table transactions add column if not exists transaction_status text not null default 'PENDING';
alter table transactions add column if not exists rejection_reason text;
alter table transactions add column if not exists expires_at timestamptz;
alter table transactions add column if not exists payment_submitted_at timestamptz;
alter table transactions add column if not exists verified_at timestamptz;
alter table transactions add column if not exists verified_by uuid references auth.users(id) on delete set null;
alter table transactions add column if not exists completed_at timestamptz;

-- invoice_id harus unik & tidak boleh mudah ditebak (dibuat oleh RPC di bawah)
create unique index if not exists idx_transactions_invoice_id on transactions(invoice_id) where invoice_id is not null;
create index if not exists idx_transactions_payment_status on transactions(payment_status);
create index if not exists idx_transactions_account_id on transactions(account_id);

alter table transactions drop constraint if exists transactions_payment_status_check;
alter table transactions add constraint transactions_payment_status_check
  check (payment_status in ('PENDING_PAYMENT', 'PROOF_SUBMITTED', 'VERIFYING', 'PAID', 'REJECTED', 'EXPIRED', 'COMPLETED'));

alter table transactions drop constraint if exists transactions_transaction_status_check;
alter table transactions add constraint transactions_transaction_status_check
  check (transaction_status in ('PENDING', 'PROCESSING', 'WAITING_DELIVERY', 'DELIVERED', 'COMPLETED', 'CANCELLED'));

-- Proteksi double purchase di level DATABASE: satu akun hanya boleh
-- punya SATU transaksi aktif (belum final) pada satu waktu.
create unique index if not exists idx_transactions_one_active_per_account
  on transactions(account_id)
  where payment_status in ('PENDING_PAYMENT', 'PROOF_SUBMITTED', 'VERIFYING');

-- ============================================================
-- 3. SITE_SETTINGS — pengaturan QRIS DANA Bisnis & pembayaran
-- ============================================================
alter table site_settings add column if not exists merchant_name text default 'ARRZ MARKET';
alter table site_settings add column if not exists dana_business_name text;
alter table site_settings add column if not exists dana_business_number text;
alter table site_settings add column if not exists qris_image_path text;
alter table site_settings add column if not exists payment_whatsapp_template text;
alter table site_settings add column if not exists payment_instruction text;
alter table site_settings add column if not exists payment_expiration_minutes int not null default 30;

update site_settings set merchant_name = coalesce(merchant_name, site_name) where id = 1;

-- ============================================================
-- 4. HAPUS TRIGGER/POLICY LAMA yang tidak relevan lagi dengan
--    alur QRIS manual (dulu transactions.status='COMPLETED' otomatis
--    men-SOLD-kan akun — sekarang digantikan trigger payment_status
--    di bawah).
-- ============================================================
drop trigger if exists trg_transaction_complete_sync on transactions;
drop function if exists public.sync_account_on_transaction_complete() cascade;

drop policy if exists "Publik buat transaction" on transactions;

-- ============================================================
-- 5. RESET POLICY TRANSACTIONS
--    PENTING: publik (anon) TIDAK diberi policy insert/select/update
--    langsung ke tabel transactions. Semua interaksi publik WAJIB
--    lewat RPC SECURITY DEFINER di bawah (create_purchase_transaction,
--    get_transaction_by_invoice, submit_payment_proof) supaya:
--    - status pembayaran tidak bisa diubah sembarangan dari browser
--    - user tidak bisa melihat transaksi orang lain kecuali tahu
--      invoice_id-nya sendiri (dipakai seperti token akses)
--    - reservasi akun (cegah double purchase) atomik di level DB
-- ============================================================
drop policy if exists "Admin kelola transactions" on transactions;
create policy "Admin kelola transactions" on transactions
  for all using (public.is_admin()) with check (public.is_admin());

-- ============================================================
-- 6. GENERATE INVOICE ID ACAK (contoh: ARRZ-20260816-X7K29P)
-- ============================================================
create or replace function public.generate_invoice_id()
returns text
language plpgsql
as $$
declare
  candidate text;
  tries int := 0;
begin
  loop
    candidate := 'ARRZ-' || to_char(now(), 'YYYYMMDD') || '-' ||
      upper(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 6));
    exit when not exists (select 1 from public.transactions where invoice_id = candidate);
    tries := tries + 1;
    if tries > 20 then
      candidate := candidate || upper(substr(md5(gen_random_uuid()::text), 1, 4));
      exit;
    end if;
  end loop;
  return candidate;
end;
$$;

-- ============================================================
-- 7. EXPIRE RESERVASI KEDALUWARSA
--    Dipanggil (opportunistic, bukan cron) dari frontend saat halaman
--    shop/product/payment dibuka. Aman dipanggil berkali-kali.
--    TIDAK PERNAH menyentuh transaksi yang sudah PROOF_SUBMITTED /
--    VERIFYING / PAID / COMPLETED — hanya PENDING_PAYMENT yang lewat waktu.
-- ============================================================
create or replace function public.expire_stale_transactions()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update transactions
     set payment_status = 'EXPIRED'
   where payment_status = 'PENDING_PAYMENT'
     and expires_at is not null
     and expires_at < now();

  update accounts
     set status = 'AVAILABLE'
   where status = 'RESERVED'
     and not exists (
       select 1 from transactions t
        where t.account_id = accounts.id
          and t.payment_status in ('PENDING_PAYMENT', 'PROOF_SUBMITTED', 'VERIFYING')
     );
end;
$$;

grant execute on function public.expire_stale_transactions() to anon, authenticated;

-- ============================================================
-- 8. BUAT TRANSAKSI PEMBELIAN (RESERVASI AKUN + INVOICE)
--    Atomik: cek AVAILABLE, kunci baris akun, ubah ke RESERVED,
--    insert transaksi PENDING_PAYMENT — semua dalam satu transaction
--    database supaya tidak ada race condition dua pembeli sekaligus.
-- ============================================================
create or replace function public.create_purchase_transaction(
  p_account_id uuid,
  p_buyer_email text,
  p_buyer_whatsapp text,
  p_buyer_instagram text
)
returns table (
  invoice_id text,
  transaction_id uuid,
  expires_at timestamptz,
  account_name text,
  account_code text,
  platform text,
  category_name text,
  price numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account accounts%rowtype;
  v_category_name text;
  v_minutes int;
  v_invoice text;
  v_expires timestamptz;
  v_tx_id uuid;
begin
  if p_buyer_email is null or btrim(p_buyer_email) = '' then
    raise exception 'EMAIL_WAJIB_DIISI';
  end if;
  if p_buyer_whatsapp is null or btrim(p_buyer_whatsapp) = '' then
    raise exception 'WHATSAPP_WAJIB_DIISI';
  end if;

  perform public.expire_stale_transactions();

  select * into v_account from accounts where id = p_account_id for update;
  if not found then
    raise exception 'AKUN_TIDAK_DITEMUKAN';
  end if;
  if v_account.status <> 'AVAILABLE' then
    raise exception 'AKUN_TIDAK_TERSEDIA';
  end if;

  select name into v_category_name from categories where id = v_account.category_id;

  select coalesce(payment_expiration_minutes, 30) into v_minutes from site_settings where id = 1;
  if v_minutes is null then v_minutes := 30; end if;

  v_invoice := public.generate_invoice_id();
  v_expires := now() + (v_minutes || ' minutes')::interval;

  update accounts set status = 'RESERVED' where id = p_account_id;

  insert into transactions (
    account_id, buyer_whatsapp, buyer_email, buyer_instagram, price,
    payment_method, payment_status, transaction_status,
    invoice_id, expires_at
  ) values (
    p_account_id, p_buyer_whatsapp, btrim(p_buyer_email), nullif(btrim(coalesce(p_buyer_instagram, '')), ''),
    v_account.price, 'QRIS_DANA_BISNIS', 'PENDING_PAYMENT', 'PENDING',
    v_invoice, v_expires
  ) returning id into v_tx_id;

  return query select v_invoice, v_tx_id, v_expires, v_account.name, v_account.account_code,
                       v_account.platform, v_category_name, v_account.price;
end;
$$;

grant execute on function public.create_purchase_transaction(uuid, text, text, text) to anon, authenticated;

-- ============================================================
-- 9. AMBIL DETAIL TRANSAKSI VIA INVOICE (dipakai halaman payment.html)
--    invoice_id berfungsi sebagai token akses acak — hanya orang yang
--    tahu invoice_id (dari proses checkout / URL) yang bisa membacanya.
-- ============================================================
create or replace function public.get_transaction_by_invoice(p_invoice_id text)
returns table (
  invoice_id text,
  payment_status text,
  transaction_status text,
  price numeric,
  buyer_email text,
  buyer_whatsapp text,
  buyer_instagram text,
  payment_proof_path text,
  rejection_reason text,
  expires_at timestamptz,
  created_at timestamptz,
  payment_submitted_at timestamptz,
  verified_at timestamptz,
  account_id uuid,
  account_name text,
  account_code text,
  platform text,
  category_name text
)
language sql
security definer
set search_path = public
stable
as $$
  select t.invoice_id, t.payment_status, t.transaction_status, t.price,
         t.buyer_email, t.buyer_whatsapp, t.buyer_instagram,
         t.payment_proof_path, t.rejection_reason, t.expires_at, t.created_at,
         t.payment_submitted_at, t.verified_at,
         a.id, a.name, a.account_code, a.platform, c.name
    from transactions t
    left join accounts a on a.id = t.account_id
    left join categories c on c.id = a.category_id
   where t.invoice_id = p_invoice_id
   limit 1;
$$;

grant execute on function public.get_transaction_by_invoice(text) to anon, authenticated;

-- ============================================================
-- 10. KIRIM BUKTI PEMBAYARAN
--     Hanya boleh mengubah PENDING_PAYMENT -> PROOF_SUBMITTED.
--     Tidak pernah mengubah menjadi PAID — itu wewenang admin.
-- ============================================================
create or replace function public.submit_payment_proof(
  p_invoice_id text,
  p_sender_name text,
  p_sender_account_number text,
  p_payment_proof_path text
)
returns table (invoice_id text, payment_status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tx transactions%rowtype;
begin
  select * into v_tx from transactions where invoice_id = p_invoice_id for update;
  if not found then
    raise exception 'TRANSAKSI_TIDAK_DITEMUKAN';
  end if;

  if v_tx.payment_status = 'PENDING_PAYMENT' and v_tx.expires_at is not null and v_tx.expires_at < now() then
    update transactions set payment_status = 'EXPIRED' where id = v_tx.id;
    perform public.expire_stale_transactions();
    raise exception 'TRANSAKSI_KEDALUWARSA';
  end if;

  if v_tx.payment_status in ('PROOF_SUBMITTED', 'VERIFYING', 'PAID', 'COMPLETED') then
    raise exception 'BUKTI_SUDAH_DIKIRIM';
  end if;

  if v_tx.payment_status = 'EXPIRED' then
    raise exception 'TRANSAKSI_KEDALUWARSA';
  end if;

  if v_tx.payment_status = 'REJECTED' then
    raise exception 'PEMBAYARAN_DITOLAK';
  end if;

  if p_sender_name is null or btrim(p_sender_name) = '' then
    raise exception 'NAMA_PENGIRIM_WAJIB_DIISI';
  end if;
  if p_sender_account_number is null or btrim(p_sender_account_number) = '' then
    raise exception 'NOMOR_PENGIRIM_WAJIB_DIISI';
  end if;
  if p_payment_proof_path is null or btrim(p_payment_proof_path) = '' then
    raise exception 'BUKTI_PEMBAYARAN_WAJIB_DIUPLOAD';
  end if;

  update transactions set
    payment_status = 'PROOF_SUBMITTED',
    sender_name = btrim(p_sender_name),
    sender_account_number = btrim(p_sender_account_number),
    payment_proof_path = p_payment_proof_path,
    payment_submitted_at = now()
  where id = v_tx.id;

  return query select v_tx.invoice_id, 'PROOF_SUBMITTED'::text;
end;
$$;

grant execute on function public.submit_payment_proof(text, text, text, text) to anon, authenticated;

-- ============================================================
-- 11. TRIGGER: efek samping saat ADMIN mengubah payment_status
--     (approve -> PAID, reject -> REJECTED). Ini hanya bisa dipicu
--     oleh admin karena hanya admin yang punya policy UPDATE pada
--     transactions (lihat langkah 5 di atas).
-- ============================================================
create or replace function public.handle_transaction_payment_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Proteksi double approve / aksi ulang pada status final
  if old.payment_status = 'PAID' and new.payment_status = 'PAID' then
    raise exception 'Transaksi ini sudah diverifikasi.';
  end if;

  if new.payment_status = 'PAID' and old.payment_status is distinct from 'PAID' then
    new.verified_at := now();
    new.verified_by := auth.uid();
    if new.transaction_status = 'PENDING' then
      new.transaction_status := 'PROCESSING';
    end if;
  end if;

  if new.payment_status = 'REJECTED' and old.payment_status is distinct from 'REJECTED' then
    if new.rejection_reason is null or btrim(new.rejection_reason) = '' then
      raise exception 'Alasan penolakan wajib diisi.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_transaction_payment_status_change on transactions;
create trigger trg_transaction_payment_status_change
  before update on transactions
  for each row execute function public.handle_transaction_payment_status_change();

create or replace function public.sync_account_on_payment_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.payment_status = 'PAID' and old.payment_status is distinct from 'PAID' and new.account_id is not null then
    update accounts set status = 'SOLD' where id = new.account_id;
  end if;

  if new.payment_status = 'REJECTED' and old.payment_status is distinct from 'REJECTED' and new.account_id is not null then
    update accounts set status = 'AVAILABLE' where id = new.account_id and status = 'RESERVED';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sync_account_on_payment_status on transactions;
create trigger trg_sync_account_on_payment_status
  after update on transactions
  for each row execute function public.sync_account_on_payment_status();

-- ============================================================
-- 12. REALTIME — daftarkan transactions (kalau belum, dari migrasi
--     sebelumnya biasanya sudah). Admin dashboard dengar perubahan;
--     halaman payment.html publik memakai POLLING (bukan Realtime)
--     lewat get_transaction_by_invoice karena RLS transactions tidak
--     mengizinkan anon subscribe langsung ke tabel ini.
-- ============================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'transactions'
  ) then
    alter publication supabase_realtime add table public.transactions;
  end if;
end $$;

-- ============================================================
-- 13. STORAGE — bucket payment-proofs (PRIVATE) & payment-assets (PUBLIC)
-- ============================================================
insert into storage.buckets (id, name, public)
values ('payment-proofs', 'payment-proofs', false)
on conflict (id) do update set public = false;

insert into storage.buckets (id, name, public)
values ('payment-assets', 'payment-assets', true)
on conflict (id) do nothing;

drop policy if exists "Publik upload payment-proofs" on storage.objects;
drop policy if exists "Admin baca payment-proofs" on storage.objects;
drop policy if exists "Admin kelola payment-proofs" on storage.objects;
drop policy if exists "Publik baca payment-assets" on storage.objects;
drop policy if exists "Admin kelola payment-assets" on storage.objects;

-- payment-proofs: publik HANYA boleh insert (upload bukti), tidak boleh
-- membaca/menghapus bukti siapa pun (termasuk miliknya sendiri) — bukti
-- hanya bisa dilihat admin lewat signed URL.
create policy "Publik upload payment-proofs" on storage.objects
  for insert with check (bucket_id = 'payment-proofs');

create policy "Admin baca payment-proofs" on storage.objects
  for select using (bucket_id = 'payment-proofs' and public.is_admin());

create policy "Admin kelola payment-proofs" on storage.objects
  for update using (bucket_id = 'payment-proofs' and public.is_admin())
  with check (bucket_id = 'payment-proofs' and public.is_admin());

create policy "Admin hapus payment-proofs" on storage.objects
  for delete using (bucket_id = 'payment-proofs' and public.is_admin());

-- payment-assets (gambar QRIS): publik boleh baca (bucket public),
-- hanya admin yang boleh upload/ganti/hapus.
create policy "Publik baca payment-assets" on storage.objects
  for select using (bucket_id = 'payment-assets');

create policy "Admin kelola payment-assets" on storage.objects
  for insert with check (bucket_id = 'payment-assets' and public.is_admin());

create policy "Admin update payment-assets" on storage.objects
  for update using (bucket_id = 'payment-assets' and public.is_admin())
  with check (bucket_id = 'payment-assets' and public.is_admin());

create policy "Admin hapus payment-assets" on storage.objects
  for delete using (bucket_id = 'payment-assets' and public.is_admin());

-- ============================================================
-- SELESAI. Langkah manual setelah migration ini:
-- 1. Admin login ke /admin.html → tab Pengaturan → isi QRIS DANA
--    Bisnis, nama/nomor DANA, nomor WhatsApp, template pesan.
-- 2. Test alur beli di halaman produk → payment.html.
-- ============================================================
