-- ARRZ MARKET — QRIS DANA Bisnis MANUAL (ringkas, idempotent)
-- Jalankan setelah schema.sql + migration_pure_supabase.sql.

alter table accounts drop constraint if exists accounts_status_check;
alter table accounts add constraint accounts_status_check check (status in ('AVAILABLE','RESERVED','SOLD'));

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

create unique index if not exists idx_tx_invoice on transactions(invoice_id) where invoice_id is not null;
create index if not exists idx_tx_pay_status on transactions(payment_status);
-- Normalisasi data transaksi lama supaya tidak bentrok dengan index unik baru:
-- transaksi lama yang akun-nya sudah SOLD dianggap sudah selesai (COMPLETED),
-- sisanya (akun masih AVAILABLE/RESERVED) yang lebih baru per akun tetap
-- PENDING_PAYMENT, dan duplikat lain di-EXPIRE.
update transactions t
set payment_status = 'COMPLETED'
from accounts a
where t.account_id = a.id
  and a.status = 'SOLD'
  and t.payment_status = 'PENDING_PAYMENT';

with ranked as (
  select id, account_id,
    row_number() over (partition by account_id order by created_at desc) as rn
  from transactions
  where payment_status in ('PENDING_PAYMENT','PROOF_SUBMITTED','VERIFYING')
)
update transactions t
set payment_status = 'EXPIRED'
from ranked r
where t.id = r.id and r.rn > 1;

create unique index if not exists idx_tx_one_active on transactions(account_id)
  where payment_status in ('PENDING_PAYMENT','PROOF_SUBMITTED','VERIFYING');

alter table transactions drop constraint if exists transactions_payment_status_check;
alter table transactions add constraint transactions_payment_status_check
  check (payment_status in ('PENDING_PAYMENT','PROOF_SUBMITTED','VERIFYING','PAID','REJECTED','EXPIRED','COMPLETED'));
alter table transactions drop constraint if exists transactions_transaction_status_check;
alter table transactions add constraint transactions_transaction_status_check
  check (transaction_status in ('PENDING','PROCESSING','WAITING_DELIVERY','DELIVERED','COMPLETED','CANCELLED'));

alter table site_settings add column if not exists merchant_name text default 'ARRZ MARKET';
alter table site_settings add column if not exists dana_business_name text;
alter table site_settings add column if not exists dana_business_number text;
alter table site_settings add column if not exists qris_image_path text;
alter table site_settings add column if not exists payment_whatsapp_template text;
alter table site_settings add column if not exists payment_instruction text;
alter table site_settings add column if not exists payment_expiration_minutes int not null default 30;
update site_settings set merchant_name = coalesce(merchant_name, site_name) where id = 1;

drop trigger if exists trg_transaction_complete_sync on transactions;
drop function if exists public.sync_account_on_transaction_complete() cascade;
drop policy if exists "Publik buat transaction" on transactions;
drop policy if exists "Admin kelola transactions" on transactions;
create policy "Admin kelola transactions" on transactions for all using (public.is_admin()) with check (public.is_admin());

create or replace function public.generate_invoice_id() returns text language plpgsql as $$
declare c text; begin
  loop
    c := 'ARRZ-' || to_char(now(),'YYYYMMDD') || '-' || upper(substr(md5(gen_random_uuid()::text||clock_timestamp()::text),1,6));
    exit when not exists (select 1 from transactions where invoice_id = c);
  end loop;
  return c;
end $$;

create or replace function public.expire_stale_transactions() returns void
language plpgsql security definer set search_path = public as $$
begin
  update transactions set payment_status='EXPIRED'
   where payment_status='PENDING_PAYMENT' and expires_at is not null and expires_at < now();
  update accounts set status='AVAILABLE'
   where status='RESERVED' and not exists (
     select 1 from transactions t where t.account_id = accounts.id
       and t.payment_status in ('PENDING_PAYMENT','PROOF_SUBMITTED','VERIFYING'));
end $$;
grant execute on function public.expire_stale_transactions() to anon, authenticated;

create or replace function public.create_purchase_transaction(
  p_account_id uuid, p_buyer_email text, p_buyer_whatsapp text, p_buyer_instagram text
) returns table (invoice_id text, transaction_id uuid, expires_at timestamptz,
  account_name text, account_code text, platform text, category_name text, price numeric)
language plpgsql security definer set search_path = public as $$
declare v_acc accounts%rowtype; v_cat text; v_min int; v_inv text; v_exp timestamptz; v_id uuid;
begin
  if p_buyer_email is null or btrim(p_buyer_email)='' then raise exception 'EMAIL_WAJIB_DIISI'; end if;
  if p_buyer_whatsapp is null or btrim(p_buyer_whatsapp)='' then raise exception 'WHATSAPP_WAJIB_DIISI'; end if;
  perform public.expire_stale_transactions();
  select * into v_acc from accounts where id = p_account_id for update;
  if not found then raise exception 'AKUN_TIDAK_DITEMUKAN'; end if;
  if v_acc.status <> 'AVAILABLE' then raise exception 'AKUN_TIDAK_TERSEDIA'; end if;
  select name into v_cat from categories where id = v_acc.category_id;
  select coalesce(payment_expiration_minutes,30) into v_min from site_settings where id=1;
  v_inv := public.generate_invoice_id();
  v_exp := now() + (coalesce(v_min,30) || ' minutes')::interval;
  update accounts set status='RESERVED' where id = p_account_id;
  begin
    insert into transactions (account_id, buyer_whatsapp, buyer_email, buyer_instagram, price,
      payment_method, payment_status, transaction_status, invoice_id, expires_at)
    values (p_account_id, p_buyer_whatsapp, btrim(p_buyer_email), nullif(btrim(coalesce(p_buyer_instagram,'')),''),
      v_acc.price, 'QRIS_DANA_BISNIS', 'PENDING_PAYMENT', 'PENDING', v_inv, v_exp)
    returning id into v_id;
  exception when unique_violation then
    -- Ada transaksi PENDING_PAYMENT/PROOF_SUBMITTED/VERIFYING lain yang
    -- masih aktif untuk akun ini (idx_tx_one_active), padahal status akun
    -- sempat AVAILABLE lagi (mis. direset manual oleh admin). Beri pesan
    -- yang jelas alih-alih membiarkan error unique_violation mentah bocor
    -- ke frontend sebagai "Gagal membuat invoice".
    raise exception 'AKUN_TIDAK_TERSEDIA';
  end;
  return query select v_inv, v_id, v_exp, v_acc.name, v_acc.account_code, v_acc.platform, v_cat, v_acc.price;
end $$;
grant execute on function public.create_purchase_transaction(uuid,text,text,text) to anon, authenticated;

create or replace function public.get_transaction_by_invoice(p_invoice_id text)
returns table (invoice_id text, payment_status text, transaction_status text, price numeric,
  buyer_email text, buyer_whatsapp text, buyer_instagram text, payment_proof_path text,
  rejection_reason text, expires_at timestamptz, created_at timestamptz,
  payment_submitted_at timestamptz, verified_at timestamptz,
  account_id uuid, account_name text, account_code text, platform text, category_name text)
language sql security definer set search_path = public stable as $$
  select t.invoice_id, t.payment_status, t.transaction_status, t.price, t.buyer_email, t.buyer_whatsapp,
    t.buyer_instagram, t.payment_proof_path, t.rejection_reason, t.expires_at, t.created_at,
    t.payment_submitted_at, t.verified_at, a.id, a.name, a.account_code, a.platform, c.name
  from transactions t
  left join accounts a on a.id = t.account_id
  left join categories c on c.id = a.category_id
  where t.invoice_id = p_invoice_id limit 1;
$$;
grant execute on function public.get_transaction_by_invoice(text) to anon, authenticated;

create or replace function public.submit_payment_proof(
  p_invoice_id text, p_sender_name text, p_sender_account_number text, p_payment_proof_path text
) returns table (invoice_id text, payment_status text)
language plpgsql security definer set search_path = public as $$
declare v_tx transactions%rowtype;
begin
  select * into v_tx from transactions where invoice_id = p_invoice_id for update;
  if not found then raise exception 'TRANSAKSI_TIDAK_DITEMUKAN'; end if;
  if v_tx.payment_status='PENDING_PAYMENT' and v_tx.expires_at is not null and v_tx.expires_at < now() then
    update transactions set payment_status='EXPIRED' where id=v_tx.id;
    raise exception 'TRANSAKSI_KEDALUWARSA';
  end if;
  if v_tx.payment_status in ('PROOF_SUBMITTED','VERIFYING','PAID','COMPLETED') then raise exception 'BUKTI_SUDAH_DIKIRIM'; end if;
  if v_tx.payment_status='EXPIRED' then raise exception 'TRANSAKSI_KEDALUWARSA'; end if;
  if v_tx.payment_status='REJECTED' then raise exception 'PEMBAYARAN_DITOLAK'; end if;
  if p_sender_name is null or btrim(p_sender_name)='' then raise exception 'NAMA_PENGIRIM_WAJIB_DIISI'; end if;
  if p_sender_account_number is null or btrim(p_sender_account_number)='' then raise exception 'NOMOR_PENGIRIM_WAJIB_DIISI'; end if;
  if p_payment_proof_path is null or btrim(p_payment_proof_path)='' then raise exception 'BUKTI_PEMBAYARAN_WAJIB_DIUPLOAD'; end if;
  update transactions set payment_status='PROOF_SUBMITTED', sender_name=btrim(p_sender_name),
    sender_account_number=btrim(p_sender_account_number), payment_proof_path=p_payment_proof_path,
    payment_submitted_at=now() where id=v_tx.id;
  return query select v_tx.invoice_id, 'PROOF_SUBMITTED'::text;
end $$;
grant execute on function public.submit_payment_proof(text,text,text,text) to anon, authenticated;

create or replace function public.handle_transaction_payment_status_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.payment_status='PAID' and new.payment_status='PAID' then raise exception 'Transaksi ini sudah diverifikasi.'; end if;
  if new.payment_status='PAID' and old.payment_status is distinct from 'PAID' then
    new.verified_at := now(); new.verified_by := auth.uid();
    if new.transaction_status='PENDING' then new.transaction_status:='PROCESSING'; end if;
  end if;
  if new.payment_status='REJECTED' and old.payment_status is distinct from 'REJECTED' then
    if new.rejection_reason is null or btrim(new.rejection_reason)='' then raise exception 'Alasan penolakan wajib diisi.'; end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_tx_payment_status on transactions;
create trigger trg_tx_payment_status before update on transactions
  for each row execute function public.handle_transaction_payment_status_change();

create or replace function public.sync_account_on_payment_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.payment_status='PAID' and old.payment_status is distinct from 'PAID' and new.account_id is not null then
    update accounts set status='SOLD' where id=new.account_id;
  end if;
  if new.payment_status='REJECTED' and old.payment_status is distinct from 'REJECTED' and new.account_id is not null then
    update accounts set status='AVAILABLE' where id=new.account_id and status='RESERVED';
  end if;
  return new;
end $$;
drop trigger if exists trg_sync_account_payment on transactions;
create trigger trg_sync_account_payment after update on transactions
  for each row execute function public.sync_account_on_payment_status();

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='transactions') then
    alter publication supabase_realtime add table public.transactions;
  end if;
end $$;

insert into storage.buckets (id, name, public) values ('payment-proofs','payment-proofs', false)
  on conflict (id) do update set public = false;
insert into storage.buckets (id, name, public) values ('payment-assets','payment-assets', true)
  on conflict (id) do nothing;

drop policy if exists "Publik upload payment-proofs" on storage.objects;
drop policy if exists "Admin baca payment-proofs" on storage.objects;
drop policy if exists "Admin kelola payment-proofs" on storage.objects;
drop policy if exists "Admin hapus payment-proofs" on storage.objects;
drop policy if exists "Publik baca payment-assets" on storage.objects;
drop policy if exists "Admin kelola payment-assets" on storage.objects;
drop policy if exists "Admin update payment-assets" on storage.objects;
drop policy if exists "Admin hapus payment-assets" on storage.objects;

create policy "Publik upload payment-proofs" on storage.objects for insert with check (bucket_id='payment-proofs');
create policy "Admin baca payment-proofs" on storage.objects for select using (bucket_id='payment-proofs' and public.is_admin());
create policy "Admin kelola payment-proofs" on storage.objects for update using (bucket_id='payment-proofs' and public.is_admin()) with check (bucket_id='payment-proofs' and public.is_admin());
create policy "Admin hapus payment-proofs" on storage.objects for delete using (bucket_id='payment-proofs' and public.is_admin());

create policy "Publik baca payment-assets" on storage.objects for select using (bucket_id='payment-assets');
create policy "Admin kelola payment-assets" on storage.objects for insert with check (bucket_id='payment-assets' and public.is_admin());
create policy "Admin update payment-assets" on storage.objects for update using (bucket_id='payment-assets' and public.is_admin()) with check (bucket_id='payment-assets' and public.is_admin());
create policy "Admin hapus payment-assets" on storage.objects for delete using (bucket_id='payment-assets' and public.is_admin());
