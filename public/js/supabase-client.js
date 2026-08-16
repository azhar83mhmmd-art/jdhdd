/* ============================================================
   ARRZ MARKET — supabase-client.js
   Konfigurasi terpusat Supabase client (browser).
   JANGAN PERNAH memasukkan SUPABASE_SERVICE_ROLE_KEY di sini.
   ============================================================ */

const SUPABASE_URL = 'https://rjorraiiexiirhdjiniv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Zcw9UyOheH9YT-FAmSuSwg_CvmcTLPA';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
