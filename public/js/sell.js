/* ============================================================
   ARRZ MARKET — sell.js
   Form pengajuan Jual Akun: upload multi foto (drag & drop),
   validasi, insert langsung ke Supabase, buka WhatsApp dengan
   pesan siap pakai. Migrasi: upload langsung ke Supabase Storage
   (bucket account-images/sell-requests/), bukan lagi /api/uploads.
   ============================================================ */

(function () {
  const form = document.querySelector('[data-sell-form]');
  if (!form) return;

  const dropzone = document.querySelector('[data-dropzone]');
  const fileInput = document.querySelector('[data-photo-input]');
  const previewGrid = document.querySelector('[data-photo-preview]');
  const categorySelect = document.querySelector('[name="category_id"]');

  let selectedFiles = [];
  const MAX_FILES = 8;
  const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  const MAX_SIZE = 5 * 1024 * 1024;

  (async function loadCategories() {
    if (!categorySelect) return;
    try {
      const { data, error } = await supabaseClient.from('categories').select('*').order('name', { ascending: true });
      if (error) throw error;
      categorySelect.innerHTML =
        '<option value="">Pilih kategori</option>' +
        (data || []).map((cat) => `<option value="${cat.id}">${ARRZ.escapeAttr(cat.name)}</option>`).join('');
    } catch (e) {
      categorySelect.innerHTML = '<option value="">Gagal memuat kategori</option>';
    }
  })();

  dropzone?.addEventListener('click', () => fileInput.click());
  dropzone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('is-dragover');
  });
  dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('is-dragover'));
  dropzone?.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-dragover');
    handleFiles(e.dataTransfer.files);
  });

  fileInput?.addEventListener('change', () => {
    handleFiles(fileInput.files);
    fileInput.value = '';
  });

  function handleFiles(fileList) {
    for (const file of Array.from(fileList)) {
      if (selectedFiles.length >= MAX_FILES) {
        ARRZ.toast(`Maksimal ${MAX_FILES} foto.`, 'error');
        break;
      }
      if (!ALLOWED_TYPES.includes(file.type)) {
        ARRZ.toast(`${file.name}: format tidak didukung (gunakan JPG/PNG/WEBP).`, 'error');
        continue;
      }
      if (file.size > MAX_SIZE) {
        ARRZ.toast(`${file.name}: ukuran melebihi 5MB.`, 'error');
        continue;
      }
      selectedFiles.push(file);
    }
    renderPreviews();
  }

  function renderPreviews() {
    previewGrid.innerHTML = '';
    selectedFiles.forEach((file, idx) => {
      const url = URL.createObjectURL(file);
      const item = document.createElement('div');
      item.className = 'photo-preview-item';
      item.innerHTML = `<img src="${url}" alt="Foto ${idx + 1}" /><button type="button" class="photo-preview-item__remove" aria-label="Hapus foto">×</button>`;
      item.querySelector('button').addEventListener('click', () => {
        selectedFiles.splice(idx, 1);
        renderPreviews();
      });
      previewGrid.appendChild(item);
    });
  }

  function extFromMime(mime) {
    switch (mime) {
      case 'image/jpeg':
      case 'image/jpg':
        return 'jpg';
      case 'image/png':
        return 'png';
      case 'image/webp':
        return 'webp';
      default:
        return 'bin';
    }
  }

  // ── Upload langsung ke Supabase Storage dari browser ────────
  async function uploadPhotos(files) {
    const urls = [];
    for (const file of files) {
      const ext = extFromMime(file.type);
      const path = `sell-requests/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
      const { error: uploadErr } = await supabaseClient.storage
        .from('account-images')
        .upload(path, file, { contentType: file.type, upsert: false });
      if (uploadErr) {
        ARRZ.toast(`${file.name}: gagal diunggah (${uploadErr.message}).`, 'error');
        continue;
      }
      const { data: publicUrlData } = supabaseClient.storage.from('account-images').getPublicUrl(path);
      if (publicUrlData?.publicUrl) urls.push(publicUrlData.publicUrl);
    }
    return urls;
  }

  // ── Submit ───────────────────────────────────────────────────
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector('button[type="submit"]');
    const confirmCheckbox = form.querySelector('[name="confirmed"]');

    const sellerName = form.querySelector('[name="seller_name"]').value.trim();
    const sellerWa = form.querySelector('[name="seller_whatsapp"]').value.trim();
    const accountName = form.querySelector('[name="account_name"]').value.trim();
    const platform = form.querySelector('[name="platform"]').value.trim();
    const desiredPrice = form.querySelector('[name="desired_price"]').value;

    if (!sellerName) return ARRZ.toast('Nama wajib diisi.', 'error');
    if (!ARRZ.isValidWhatsApp(sellerWa)) return ARRZ.toast('Nomor WhatsApp wajib diisi dengan format yang benar.', 'error');
    if (!accountName || !platform) return ARRZ.toast('Nama akun dan platform wajib diisi.', 'error');
    if (!confirmCheckbox.checked) {
      ARRZ.toast('Kamu harus menyetujui bahwa informasi yang diberikan benar.', 'error');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Mengirim...';

    try {
      let photoUrls = [];
      if (selectedFiles.length > 0) {
        photoUrls = await uploadPhotos(selectedFiles);
      }

      const categoryId = categorySelect?.value || null;
      const payload = {
        seller_name: sellerName,
        seller_whatsapp: sellerWa,
        seller_email: form.querySelector('[name="seller_email"]').value.trim() || null,
        account_name: accountName,
        platform,
        category_id: categoryId,
        username: form.querySelector('[name="username"]').value.trim() || null,
        desired_price: desiredPrice ? Number(desiredPrice) : null,
        description: form.querySelector('[name="description"]').value.trim(),
        details: form.querySelector('[name="details"]').value.trim(),
        features: form.querySelector('[name="features"]').value.trim(),
        additional_info: form.querySelector('[name="additional_info"]').value.trim(),
        photo_urls: photoUrls,
        status: 'PENDING',
      };

      // JANGAN .select() setelah insert: sell_requests tidak memberi
      // anon/authenticated policy SELECT, jadi read-back akan gagal RLS
      // walaupun insert-nya sendiri sah.
      const { error } = await supabaseClient.from('sell_requests').insert(payload);
      if (error) throw error;

      let categoryName = '-';
      if (categoryId) {
        const { data: cat } = await supabaseClient.from('categories').select('name').eq('id', categoryId).maybeSingle();
        categoryName = cat?.name || '-';
      }

      const settings = (await ARRZ.loadSettings()) || {};
      const template = settings.wa_template_sell || WA_TEMPLATES.DEFAULT_TEMPLATE_SELL;
      const message = WA_TEMPLATES.fillTemplate(template, {
        NAMA: sellerName,
        WHATSAPP: sellerWa,
        EMAIL: payload.seller_email || '-',
        'NAMA AKUN': accountName,
        PLATFORM: platform,
        KATEGORI: categoryName,
        USERNAME: payload.username || '-',
        HARGA: payload.desired_price ? WA_TEMPLATES.formatRupiah(payload.desired_price) : '-',
        DESKRIPSI: payload.description || '-',
        DETAIL: payload.details || '-',
      });

      ARRZ.openWhatsApp(settings.admin_whatsapp || '', message);
      ARRZ.toast('Pengajuan terkirim! Kamu akan diarahkan ke WhatsApp admin.', 'success');
      form.reset();
      selectedFiles = [];
      renderPreviews();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      ARRZ.toast(err.message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Kirim Pengajuan';
    }
  });
})();
