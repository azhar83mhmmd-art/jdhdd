# ARRZ MARKET — Pure Supabase + Static Frontend + Vercel

Marketplace jual beli akun digital. Tidak ada lagi server Node.js yang
berjalan terus-menerus — semua backend (database, auth, realtime, storage)
ditangani Supabase, frontend murni HTML/CSS/vanilla JS static.

```
Browser → Supabase Client → PostgreSQL
Browser → Supabase Realtime
Browser → Supabase Storage
Browser → Supabase Auth
```

## 1. Buat project Supabase

Di [supabase.com](https://supabase.com), buat project baru. Catat
**Project URL** dan **anon public key** dari Project Settings → API.

## 2. Jalankan skema database

Buka Supabase → SQL Editor, jalankan berurutan:

1. `supabase/schema.sql` — skema tabel dasar (accounts, categories, offers,
   sell_requests, transactions, site_settings, account_images).
2. `supabase/migration_pure_supabase.sql` — migrasi ke pure Supabase:
   tabel `profiles` (role admin/user), RLS baru per tabel, trigger auto-SOLD
   saat transaksi COMPLETED, publication realtime, bucket + policy Storage.

## 3. Isi konfigurasi Supabase di frontend

Edit `public/js/supabase-client.js`, isi `SUPABASE_URL` dan
`SUPABASE_ANON_KEY` dari langkah 1. **Jangan pernah** memasukkan
`service_role` key ke file manapun di folder `public/`.

## 4. Buat user admin pertama

1. Supabase → Authentication → Add user (isi email + password).
2. Jalankan di SQL Editor:
   ```sql
   update public.profiles set role = 'admin' where id = 'UUID_USER_TADI';
   ```
3. Login lewat `public/login.html` pakai email + password tadi.

## 5. Sistem Pembayaran — QRIS DANA Bisnis MANUAL

Jalankan **`supabase/migration_manual_qris.sql`** di SQL Editor (setelah
langkah 2 di atas). Migration ini aman dijalankan ulang dan **tidak
menghapus data lama**. Isinya:

- Kolom baru di `transactions` (invoice_id, buyer_email, buyer_instagram,
  payment_status, transaction_status, sender_name, sender_account_number,
  payment_proof_path, rejection_reason, expires_at, dst).
- Kolom baru di `site_settings` untuk QRIS & instruksi pembayaran
  (`qris_image_path`, `dana_business_name`, `dana_business_number`,
  `payment_whatsapp_template`, `payment_instruction`,
  `payment_expiration_minutes`).
- Status `accounts` bertambah `RESERVED` (dipakai saat invoice dibuat,
  supaya akun tidak bisa dibeli 2 orang sekaligus).
- 4 fungsi RPC (`SECURITY DEFINER`) yang menjadi **satu-satunya jalur**
  publik menyentuh tabel `transactions` (tabel `transactions` sendiri
  **tidak** punya policy insert/select/update untuk anon — hanya admin):
  - `create_purchase_transaction` — reservasi akun + buat invoice, atomik.
  - `get_transaction_by_invoice` — baca detail transaksi via invoice_id
    (dipakai sebagai token akses, karena acak & tidak mudah ditebak).
  - `submit_payment_proof` — kirim bukti pembayaran (hanya boleh
    `PENDING_PAYMENT` → `PROOF_SUBMITTED`, tidak pernah ke `PAID`).
  - `expire_stale_transactions` — bebaskan reservasi kedaluwarsa,
    dipanggil opportunistic dari frontend (bukan cron job).
- Trigger yang menjaga admin tidak bisa approve dua kali, dan otomatis
  mengubah `accounts.status` (SOLD saat PAID, AVAILABLE lagi saat REJECTED).
- Bucket Storage baru: `payment-proofs` (**private**, hanya admin yang
  boleh membaca lewat signed URL) dan `payment-assets` (**public**, untuk
  gambar QRIS).

**Website ini TIDAK PERNAH mengklaim pembayaran otomatis berhasil.**
Status `PAID` hanya bisa ditetapkan admin lewat tombol Approve di dashboard
setelah mengecek DANA Bisnis secara manual.

### Cara memasukkan QRIS DANA Bisnis

1. Login ke `/admin.html` → tab **Pengaturan** → bagian **Pengaturan
   Pembayaran**.
2. Klik area upload di bawah "QRIS DANA Bisnis", pilih gambar QRIS
   (JPG/PNG/WEBP, maks 5MB). Preview langsung tampil, dan otomatis
   dipakai di halaman pembayaran publik. Untuk mengganti, upload ulang;
   untuk menghapus, klik "Hapus QRIS".

### Cara mengatur nomor DANA / rekening & template

Masih di bagian **Pengaturan Pembayaran**: isi **Nama Penerima**, **Nama
DANA Bisnis**, **Nomor DANA** (opsional, tampil ke pembeli), **Waktu
Kadaluarsa Invoice**, **Instruksi Pembayaran** (satu baris = satu
langkah), dan **Template Pesan WhatsApp** untuk konfirmasi bukti
pembayaran. Semua data ini disimpan di `site_settings` — tidak ada yang
di-hardcode di HTML/JS.

### Cara menjalankan migration

Buka project Supabase → **SQL Editor** → New query → tempel isi
`supabase/migration_manual_qris.sql` → Run. Jalankan sekali; aman
dijalankan ulang kalau perlu (semua `IF NOT EXISTS` / `DROP POLICY IF
EXISTS`).

### Cara test di Vercel production

1. Pastikan `public/js/supabase-client.js` memakai `SUPABASE_URL` /
   `SUPABASE_ANON_KEY` project yang sama dengan tempat migration
   dijalankan.
2. Buka situs Vercel → pilih akun → Beli Sekarang → isi email + WhatsApp
   → pastikan invoice & halaman `payment.html?invoice=...` muncul dengan
   QRIS.
3. Upload bukti pembayaran (screenshot apa saja untuk testing) → pastikan
   toast sukses & WhatsApp admin terbuka.
4. Login admin → tab **Transaksi Pembelian** → buka detail transaksi tadi
   → pastikan bukti pembayaran tampil (signed URL) → coba **Approve**
   (akun harus berubah jadi SOLD) dan di transaksi lain coba **Tolak**
   (akun harus kembali AVAILABLE).
5. Buka dua tab/browser berbeda, coba beli akun yang sama nyaris
   bersamaan — device kedua harus mendapat pesan "Akun ini sedang
   diproses pembeli lain" karena proteksi dilakukan di level database
   (`create_purchase_transaction` mengunci baris akun + partial unique
   index di `transactions`).

## 6. Jalankan lokal / deploy

```bash
npm run dev     # serve folder public/ secara lokal (butuh `npx serve`)
```

Deploy ke Vercel: hubungkan repo, Vercel otomatis membaca `vercel.json`
(`outputDirectory: public`) — tidak perlu build step, tidak perlu env
server karena semua konfigurasi ada di `public/js/supabase-client.js`.

## Struktur proyek

```
arrz-market/
├── vercel.json                  # deploy static dari folder public/
├── supabase/
│   ├── schema.sql                    # skema tabel dasar
│   ├── migration_pure_supabase.sql   # RLS admin, trigger, realtime, storage
│   └── migration_manual_qris.sql     # sistem pembayaran QRIS DANA Bisnis manual
└── public/
    ├── index.html, shop.html, product.html, sell.html, payment.html,
    │   login.html, faq.html, how-it-works.html, admin.html
    ├── css/
    └── js/
        ├── supabase-client.js     # konfigurasi Supabase client (SUPABASE_URL/ANON_KEY)
        ├── wa-templates.js        # template pesan WhatsApp (dulu di server)
        ├── app.js                 # util bersama: toast, navbar, settings, homepage
        ├── shop.js, product.js, sell.js   # query Supabase langsung per halaman
        ├── payment.js              # halaman pembayaran QRIS manual (invoice, upload bukti, polling status)
        ├── admin.js                # dashboard admin (Supabase Auth + CRUD + verifikasi pembayaran + realtime)
        └── realtime.js             # Supabase Realtime publik (ganti Socket.IO)
```

## Arsitektur (sebelum → sesudah)

| Sebelum | Sesudah |
|---|---|
| Express routes (`/api/accounts`, dst) | Query `supabaseClient.from(...)` langsung dari browser |
| Socket.IO (`io.emit`, `socket.on`) | Supabase Realtime (`postgres_changes`) |
| express-session + bcrypt admin | Supabase Auth + tabel `profiles.role` |
| multer → filesystem `uploads/` | Upload langsung ke Supabase Storage (`account-images`) |
| Validasi & keamanan di Express middleware | Row Level Security (RLS) di PostgreSQL |
| — | Checkout QRIS DANA Bisnis manual via RPC `SECURITY DEFINER` (`create_purchase_transaction`, `submit_payment_proof`, dst), verifikasi PAID/REJECTED 100% oleh admin |
