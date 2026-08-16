/* ============================================================
   ARRZ MARKET — admin.js
   Dashboard admin: auth guard (Supabase Auth), tab switching,
   CRUD akun/tawaran/pengajuan/transaksi/kategori, pengaturan
   situs, realtime notif. Migrasi: semua panggilan /api/* diganti
   query Supabase langsung (RLS membatasi ke role admin).
   ============================================================ */

(function () {
  const shell = document.querySelector('[data-admin-shell]');
  if (!shell) return; // bukan halaman admin.html

  let categoriesCache = [];

  // ── Auth guard (Supabase Auth + role admin di tabel profiles) ─
  async function checkAuth() {
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      if (!session) {
        window.location.href = 'login.html';
        return false;
      }
      const { data: profile, error } = await supabaseClient
        .from('profiles')
        .select('role')
        .eq('id', session.user.id)
        .maybeSingle();
      if (error || !profile || profile.role !== 'admin') {
        await supabaseClient.auth.signOut();
        window.location.href = 'login.html';
        return false;
      }
      shell.style.display = '';
      return true;
    } catch (e) {
      window.location.href = 'login.html';
      return false;
    }
  }

  // Kalau sesi berakhir/logout dari tab lain, ikut terlempar ke login.
  supabaseClient.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') window.location.href = 'login.html';
  });

  // ── Logout ───────────────────────────────────────────────────
  document.querySelector('[data-logout-btn]')?.addEventListener('click', async () => {
    try {
      await supabaseClient.auth.signOut();
    } finally {
      window.location.href = 'login.html';
    }
  });

  // ── Tab switching ────────────────────────────────────────────
  const tabButtons = document.querySelectorAll('[data-tab-btn]');
  const tabPanels = document.querySelectorAll('[data-tab-panel]');
  const loadedTabs = new Set();

  function switchTab(tabName) {
    tabButtons.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.tabBtn === tabName));
    tabPanels.forEach((panel) => {
      panel.style.display = panel.dataset.tabPanel === tabName ? '' : 'none';
    });
    loadTabData(tabName);
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tabBtn));
  });

  function loadTabData(tabName) {
    switch (tabName) {
      case 'dashboard':
        loadDashboard();
        break;
      case 'accounts':
        loadAccountsTable();
        if (!loadedTabs.has('categories-cache')) loadCategoriesCache();
        break;
      case 'offers':
        loadOffersTable();
        break;
      case 'sell-requests':
        loadSellRequestsTable();
        break;
      case 'transactions':
        loadTransactionsTable();
        break;
      case 'categories':
        loadCategoriesTable();
        break;
      case 'settings':
        loadSettingsForm();
        break;
    }
  }

  // ── Dashboard stats ──────────────────────────────────────────
  async function loadDashboard() {
    const grid = document.querySelector('[data-dashboard-stats]');
    try {
      const countOf = (table, eqCol, eqVal) => {
        let q = supabaseClient.from(table).select('id', { count: 'exact', head: true });
        if (eqCol) q = q.eq(eqCol, eqVal);
        return q;
      };
      const [totalAccounts, availableAccounts, soldAccounts, pendingSellRequests, pendingOffers, totalTransactions] =
        await Promise.all([
          countOf('accounts'),
          countOf('accounts', 'status', 'AVAILABLE'),
          countOf('accounts', 'status', 'SOLD'),
          countOf('sell_requests', 'status', 'PENDING'),
          countOf('offers', 'status', 'PENDING'),
          countOf('transactions'),
        ]);

      const values = [
        totalAccounts.count || 0,
        availableAccounts.count || 0,
        soldAccounts.count || 0,
        pendingSellRequests.count || 0,
        pendingOffers.count || 0,
        totalTransactions.count || 0,
      ];
      grid.querySelectorAll('.stat-card__value').forEach((el, idx) => (el.textContent = values[idx] ?? '—'));
    } catch (e) {
      ARRZ.toast(e.message, 'error');
    }
  }

  // ══════════════════════════════════════════════════════════
  // CARI AKUN (Dashboard) — cari lewat Kode Akun acak sistem
  // (contoh: ARZ-7F3K9X), bukan lagi kode berurutan seperti ACC-00019.
  // ══════════════════════════════════════════════════════════
  const lookupForm = document.querySelector('[data-account-lookup-form]');
  const lookupResult = document.querySelector('[data-account-lookup-result]');

  lookupForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = lookupForm.querySelector('button[type="submit"]');
    const rawCode = lookupForm.querySelector('[name="code"]').value.trim();
    if (!rawCode) {
      ARRZ.toast('Masukkan kode akun terlebih dahulu.', 'error');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Mencari...';
    lookupResult.innerHTML = '';

    try {
      const { data, error } = await supabaseClient
        .from('accounts')
        .select('*, account_images(id, image_url, is_primary), categories(name)')
        .ilike('account_code', rawCode)
        .maybeSingle();
      if (error) throw error;

      if (!data) {
        lookupResult.innerHTML = `<div class="admin-empty" style="padding:14px 0;">Akun dengan kode "${ARRZ.escapeAttr(rawCode)}" tidak ditemukan.</div>`;
        return;
      }

      const primary = (data.account_images || []).find((i) => i.is_primary) || data.account_images?.[0];
      lookupResult.innerHTML = `
        <div class="admin-lookup-card">
          ${primary ? `<img class="table-thumb" style="width:56px; height:56px;" src="${ARRZ.escapeAttr(primary.image_url)}" alt="" />` : `<div class="table-thumb" style="width:56px; height:56px;"></div>`}
          <div style="flex:1; min-width:0;">
            <div class="mono" style="font-weight:700;">${ARRZ.escapeAttr(data.account_code)}</div>
            <div style="font-weight:600;">${ARRZ.escapeAttr(data.name)} — ${ARRZ.escapeAttr(data.platform)}</div>
            <div style="font-size:0.85rem; color:var(--ink-soft);">${ARRZ.formatRupiah(data.price)} · <span class="badge ${data.status === 'SOLD' ? 'badge--sold' : 'badge--available'}">${data.status}</span></div>
          </div>
          <button type="button" class="btn btn-sm btn-primary" data-lookup-edit="${data.id}">Buka / Edit</button>
        </div>`;

      lookupResult.querySelector('[data-lookup-edit]')?.addEventListener('click', () => {
        switchTab('accounts');
        openAccountDrawer(data.id);
      });
    } catch (err) {
      ARRZ.toast(err.message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Cari Akun';
    }
  });

  // ── Kategori cache (dipakai dropdown akun) ──────────────────
  async function loadCategoriesCache() {
    try {
      const { data, error } = await supabaseClient.from('categories').select('*').order('name', { ascending: true });
      if (error) throw error;
      categoriesCache = data || [];
      loadedTabs.add('categories-cache');
      const select = document.getElementById('acc-category');
      if (select) {
        select.innerHTML =
          '<option value="">Pilih kategori</option>' +
          categoriesCache.map((c) => `<option value="${c.id}">${ARRZ.escapeAttr(c.name)}</option>`).join('');
      }
    } catch (e) {
      // diamkan, dropdown tetap kosong
    }
  }

  // ══════════════════════════════════════════════════════════
  // AKUN
  // ══════════════════════════════════════════════════════════

  let accountsCache = [];
  const accountsSearchInput = document.querySelector('[data-accounts-table-search]');

  function matchesAccountSearch(acc, query) {
    if (!query) return true;
    const q = query.trim().toLowerCase();
    return (
      (acc.account_code || '').toLowerCase().includes(q) ||
      (acc.name || '').toLowerCase().includes(q) ||
      (acc.username || '').toLowerCase().includes(q)
    );
  }

  function renderAccountsTable(rows) {
    const tbody = document.querySelector('[data-accounts-table]');
    if (!rows || rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="admin-empty">Tidak ada akun yang cocok.</td></tr>`;
      return;
    }
    renderAccountsRows(rows, tbody);
  }

  accountsSearchInput?.addEventListener('input', () => {
    renderAccountsTable(accountsCache.filter((acc) => matchesAccountSearch(acc, accountsSearchInput.value)));
  });

  async function loadAccountsTable() {
    const tbody = document.querySelector('[data-accounts-table]');
    tbody.innerHTML = `<tr><td colspan="8" class="admin-empty">Memuat...</td></tr>`;
    try {
      const { data: all, error } = await supabaseClient
        .from('accounts')
        .select('*, account_images(id, image_url, is_primary)')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;

      accountsCache = all || [];

      if (!all || all.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="admin-empty">Belum ada akun. Klik "+ Tambah Akun" untuk memulai.</td></tr>`;
        return;
      }

      const filtered = accountsSearchInput?.value
        ? accountsCache.filter((acc) => matchesAccountSearch(acc, accountsSearchInput.value))
        : accountsCache;

      renderAccountsRows(filtered, tbody);
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="8" class="admin-empty">Data belum dapat dimuat. Silakan coba lagi.</td></tr>`;
    }
  }

  // Dipisah dari loadAccountsTable supaya bisa dipakai ulang saat
  // hasil pencarian (client-side filter) di-render tanpa fetch ulang.
  function renderAccountsRows(all, tbody) {
    try {
      tbody.innerHTML = all
        .map((acc) => {
          const primary = (acc.account_images || []).find((i) => i.is_primary) || acc.account_images?.[0];
          return `
          <tr data-account-row="${acc.id}">
            <td>${primary ? `<img class="table-thumb" src="${ARRZ.escapeAttr(primary.image_url)}" alt="" />` : `<div class="table-thumb"></div>`}</td>
            <td class="mono">${ARRZ.escapeAttr(acc.account_code || '')}</td>
            <td>${ARRZ.escapeAttr(acc.name)}</td>
            <td>${ARRZ.escapeAttr(acc.platform)}</td>
            <td class="mono">${ARRZ.formatRupiah(acc.price)}</td>
            <td><span class="badge ${acc.status === 'SOLD' ? 'badge--sold' : 'badge--available'}">${acc.status}</span></td>
            <td>${acc.featured ? '<span class="badge badge--featured">Featured</span>' : '-'}</td>
            <td class="admin-table__actions">
              <button class="btn btn-sm" data-edit-account="${acc.id}">Edit</button>
              <button class="btn btn-sm" data-toggle-status="${acc.id}" data-current-status="${acc.status}">${acc.status === 'SOLD' ? 'Tandai Available' : 'Tandai Sold'}</button>
              <button class="btn btn-sm" style="background:var(--danger-soft); color:var(--danger);" data-delete-account="${acc.id}">Hapus</button>
            </td>
          </tr>`;
        })
        .join('');

      tbody.querySelectorAll('[data-edit-account]').forEach((btn) => {
        btn.addEventListener('click', () => openAccountDrawer(btn.dataset.editAccount));
      });
      tbody.querySelectorAll('[data-toggle-status]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const newStatus = btn.dataset.currentStatus === 'SOLD' ? 'AVAILABLE' : 'SOLD';
          try {
            const { error } = await supabaseClient.from('accounts').update({ status: newStatus }).eq('id', btn.dataset.toggleStatus);
            if (error) throw error;
            ARRZ.toast('Status akun diperbarui.', 'success');
            loadAccountsTable();
            loadDashboard();
          } catch (e) {
            ARRZ.toast(e.message, 'error');
          }
        });
      });
      tbody.querySelectorAll('[data-delete-account]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Hapus akun ini secara permanen?')) return;
          try {
            const { error } = await supabaseClient.from('accounts').delete().eq('id', btn.dataset.deleteAccount);
            if (error) throw error;
            ARRZ.toast('Akun dihapus.', 'success');
            loadAccountsTable();
            loadDashboard();
          } catch (e) {
            ARRZ.toast(e.message, 'error');
          }
        });
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="8" class="admin-empty">Data belum dapat dimuat. Silakan coba lagi.</td></tr>`;
    }
  }

  // ── Drawer tambah/edit akun ─────────────────────────────────
  const drawer = document.querySelector('[data-account-drawer]');
  const accountForm = document.querySelector('[data-account-form]');
  const drawerTitle = document.querySelector('[data-drawer-title]');
  const imagesGrid = document.querySelector('[data-account-images]');
  let pendingNewImages = [];
  let editingAccountId = null;

  function openAccountDrawer(accountId = null) {
    editingAccountId = accountId;
    pendingNewImages = [];
    accountForm.reset();
    imagesGrid.innerHTML = '';
    drawerTitle.textContent = accountId ? 'Edit Akun' : 'Tambah Akun';

    if (categoriesCache.length === 0) loadCategoriesCache();

    if (accountId) {
      supabaseClient
        .from('accounts')
        .select('*, account_images(id, image_url, is_primary)')
        .eq('id', accountId)
        .maybeSingle()
        .then(({ data, error }) => {
          if (error || !data) throw error || new Error('Akun tidak ditemukan.');
          accountForm.id.value = data.id;
          accountForm.name.value = data.name;
          accountForm.platform.value = data.platform;
          accountForm.category_id.value = data.category_id || '';
          accountForm.price.value = data.price;
          accountForm.username.value = data.username || '';
          accountForm.description.value = data.description || '';
          accountForm.details.value = data.details || '';
          accountForm.features.value = data.features || '';
          accountForm.status.value = data.status;
          accountForm.featured.checked = Boolean(data.featured);
          renderExistingImages(data.account_images || [], data.id);
        })
        .catch((e) => ARRZ.toast(e.message, 'error'));
    }

    drawer.classList.add('is-open');
  }

  function closeAccountDrawer() {
    drawer.classList.remove('is-open');
  }

  document.querySelector('[data-open-account-drawer]')?.addEventListener('click', () => openAccountDrawer());
  document.querySelector('[data-close-drawer]')?.addEventListener('click', closeAccountDrawer);
  drawer?.addEventListener('click', (e) => {
    if (e.target === drawer) closeAccountDrawer();
  });

  async function removeExistingImage(imageId, btnEl) {
    try {
      const { error } = await supabaseClient.from('account_images').delete().eq('id', imageId);
      if (error) throw error;
      btnEl.closest('.image-manage-item').remove();
      ARRZ.toast('Foto dihapus.', 'success');
    } catch (e) {
      ARRZ.toast(e.message, 'error');
    }
  }

  function renderExistingImages(images) {
    imagesGrid.innerHTML = images
      .map(
        (img) => `
      <div class="image-manage-item ${img.is_primary ? 'is-primary' : ''}" data-existing-image="${img.id}">
        <img src="${ARRZ.escapeAttr(img.image_url)}" alt="" />
        <button type="button" class="image-manage-item__remove" data-remove-existing-image="${img.id}">×</button>
      </div>`
      )
      .join('');

    imagesGrid.querySelectorAll('[data-remove-existing-image]').forEach((btn) => {
      btn.addEventListener('click', () => removeExistingImage(btn.dataset.removeExistingImage, btn));
    });
  }

  function renderPendingImages() {
    const pendingHtml = pendingNewImages
      .map(
        (item, idx) => `
      <div class="image-manage-item" data-pending-image="${idx}">
        <img src="${item.previewUrl}" alt="" />
        <button type="button" class="image-manage-item__remove" data-remove-pending-image="${idx}">×</button>
      </div>`
      )
      .join('');
    const existingHtml = Array.from(imagesGrid.querySelectorAll('[data-existing-image]'))
      .map((el) => el.outerHTML)
      .join('');
    imagesGrid.innerHTML = existingHtml + pendingHtml;

    imagesGrid.querySelectorAll('[data-remove-pending-image]').forEach((btn) => {
      btn.addEventListener('click', () => {
        pendingNewImages.splice(Number(btn.dataset.removePendingImage), 1);
        renderPendingImages();
      });
    });
    imagesGrid.querySelectorAll('[data-remove-existing-image]').forEach((btn) => {
      btn.addEventListener('click', () => removeExistingImage(btn.dataset.removeExistingImage, btn));
    });
  }

  const accountDropzone = document.querySelector('[data-account-dropzone]');
  const accountPhotoInput = document.querySelector('[data-account-photo-input]');

  accountDropzone?.addEventListener('click', () => accountPhotoInput.click());
  accountDropzone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    accountDropzone.classList.add('is-dragover');
  });
  accountDropzone?.addEventListener('dragleave', () => accountDropzone.classList.remove('is-dragover'));
  accountDropzone?.addEventListener('drop', (e) => {
    e.preventDefault();
    accountDropzone.classList.remove('is-dragover');
    handleAccountPhotos(e.dataTransfer.files);
  });
  accountPhotoInput?.addEventListener('change', () => {
    handleAccountPhotos(accountPhotoInput.files);
    accountPhotoInput.value = '';
  });

  function handleAccountPhotos(fileList) {
    const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    for (const file of Array.from(fileList)) {
      if (!validTypes.includes(file.type)) {
        ARRZ.toast(`${file.name}: format tidak didukung.`, 'error');
        continue;
      }
      if (file.size > 5 * 1024 * 1024) {
        ARRZ.toast(`${file.name}: ukuran melebihi 5MB.`, 'error');
        continue;
      }
      pendingNewImages.push({ file, previewUrl: URL.createObjectURL(file) });
    }
    renderPendingImages();
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

  // Upload langsung ke Supabase Storage (bucket account-images/accounts/),
  // lalu insert baris account_images. Menggantikan POST /api/uploads?context=accounts.
  async function uploadPendingImages(accountId) {
    if (pendingNewImages.length === 0) return;
    const hasExistingImages = imagesGrid.querySelectorAll('[data-existing-image]').length > 0;

    let uploadedCount = 0;
    for (let i = 0; i < pendingNewImages.length; i++) {
      const { file } = pendingNewImages[i];
      const ext = extFromMime(file.type);
      const path = `accounts/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;

      const { error: uploadErr } = await supabaseClient.storage
        .from('account-images')
        .upload(path, file, { contentType: file.type, upsert: false });
      if (uploadErr) {
        ARRZ.toast(`${file.name}: gagal diunggah (${uploadErr.message}).`, 'error');
        continue;
      }
      const { data: publicUrlData } = supabaseClient.storage.from('account-images').getPublicUrl(path);
      if (!publicUrlData?.publicUrl) continue;

      const { error: insertErr } = await supabaseClient.from('account_images').insert({
        account_id: accountId,
        image_url: publicUrlData.publicUrl,
        is_primary: !hasExistingImages && uploadedCount === 0,
      });
      if (insertErr) throw insertErr;
      uploadedCount++;
    }
    pendingNewImages = [];
  }

  accountForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = accountForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Menyimpan...';

    try {
      const payload = {
        name: accountForm.name.value.trim(),
        platform: accountForm.platform.value.trim(),
        category_id: accountForm.category_id.value || null,
        price: Number(accountForm.price.value),
        username: accountForm.username.value.trim(),
        description: accountForm.description.value.trim(),
        details: accountForm.details.value.trim(),
        features: accountForm.features.value.trim(),
        status: accountForm.status.value,
        featured: accountForm.featured.checked,
      };

      let accountId = editingAccountId;

      if (accountId) {
        const { error } = await supabaseClient.from('accounts').update(payload).eq('id', accountId);
        if (error) throw error;
      } else {
        const { data, error } = await supabaseClient.from('accounts').insert(payload).select('id').single();
        if (error) throw error;
        accountId = data.id;
      }

      await uploadPendingImages(accountId);

      ARRZ.toast('Akun berhasil disimpan.', 'success');
      closeAccountDrawer();
      loadAccountsTable();
      loadDashboard();
    } catch (err) {
      ARRZ.toast(err.message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Simpan Akun';
    }
  });

  // ══════════════════════════════════════════════════════════
  // TAWARAN
  // ══════════════════════════════════════════════════════════

  let currentOffersFilter = '';

  async function loadOffersTable() {
    const tbody = document.querySelector('[data-offers-table]');
    tbody.innerHTML = `<tr><td colspan="7" class="admin-empty">Memuat...</td></tr>`;
    try {
      let query = supabaseClient
        .from('offers')
        .select('*, accounts(name, account_code, platform)')
        .order('created_at', { ascending: false });
      if (currentOffersFilter) query = query.eq('status', currentOffersFilter);
      const { data, error } = await query;
      if (error) throw error;

      if (!data || data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="admin-empty">Tidak ada tawaran.</td></tr>`;
        return;
      }

      tbody.innerHTML = data
        .map(
          (offer) => `
        <tr>
          <td>${ARRZ.escapeAttr(offer.accounts?.name || '-')}</td>
          <td class="mono">${ARRZ.formatRupiah(offer.original_price)}</td>
          <td class="mono">${ARRZ.formatRupiah(offer.offer_price)}</td>
          <td>${ARRZ.escapeAttr(offer.buyer_name)}</td>
          <td class="mono">${ARRZ.escapeAttr(offer.buyer_whatsapp)}</td>
          <td><span class="badge badge--neutral">${offer.status}</span></td>
          <td class="admin-table__actions">
            ${offer.status === 'PENDING' ? `
              <button class="btn btn-sm" data-offer-action="${offer.id}" data-offer-status="ACCEPTED">Terima</button>
              <button class="btn btn-sm" data-offer-action="${offer.id}" data-offer-status="REJECTED">Tolak</button>
            ` : ''}
            ${offer.status === 'ACCEPTED' ? `<button class="btn btn-sm" data-offer-action="${offer.id}" data-offer-status="COMPLETED">Selesai</button>` : ''}
          </td>
        </tr>`
        )
        .join('');

      tbody.querySelectorAll('[data-offer-action]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            const { error } = await supabaseClient
              .from('offers')
              .update({ status: btn.dataset.offerStatus })
              .eq('id', btn.dataset.offerAction);
            if (error) throw error;
            ARRZ.toast('Status tawaran diperbarui.', 'success');
            loadOffersTable();
            loadDashboard();
          } catch (e) {
            ARRZ.toast(e.message, 'error');
          }
        });
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="7" class="admin-empty">Data belum dapat dimuat. Silakan coba lagi.</td></tr>`;
    }
  }

  document.querySelectorAll('[data-offers-filter] .tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-offers-filter] .tab-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      currentOffersFilter = btn.dataset.status;
      loadOffersTable();
    });
  });

  // ══════════════════════════════════════════════════════════
  // PENGAJUAN JUAL
  // ══════════════════════════════════════════════════════════

  let currentSellRequestsFilter = '';

  async function loadSellRequestsTable() {
    const tbody = document.querySelector('[data-sell-requests-table]');
    tbody.innerHTML = `<tr><td colspan="6" class="admin-empty">Memuat...</td></tr>`;
    try {
      let query = supabaseClient.from('sell_requests').select('*').order('created_at', { ascending: false });
      if (currentSellRequestsFilter) query = query.eq('status', currentSellRequestsFilter);
      const { data, error } = await query;
      if (error) throw error;

      if (!data || data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="admin-empty">Tidak ada pengajuan.</td></tr>`;
        return;
      }

      tbody.innerHTML = data
        .map(
          (req) => `
        <tr>
          <td>${ARRZ.escapeAttr(req.account_name)}<br/><span style="font-size:0.78rem; color:var(--ink-soft);">${ARRZ.escapeAttr(req.platform)}</span></td>
          <td>${ARRZ.escapeAttr(req.seller_name)}</td>
          <td class="mono">${ARRZ.escapeAttr(req.seller_whatsapp)}</td>
          <td class="mono">${req.desired_price ? ARRZ.formatRupiah(req.desired_price) : '-'}</td>
          <td><span class="badge badge--neutral">${req.status}</span></td>
          <td class="admin-table__actions">
            ${req.status === 'PENDING' ? `<button class="btn btn-sm" data-sr-action="${req.id}" data-sr-status="REVIEW">Review</button>` : ''}
            ${req.status !== 'ACCEPTED' && req.status !== 'REJECTED' ? `
              <button class="btn btn-sm" data-sr-action="${req.id}" data-sr-status="ACCEPTED">Terima</button>
              <button class="btn btn-sm" data-sr-action="${req.id}" data-sr-status="REJECTED">Tolak</button>
            ` : ''}
            ${req.status === 'ACCEPTED' ? `<button class="btn btn-sm btn-primary" data-sr-convert="${req.id}">+ Marketplace</button>` : ''}
          </td>
        </tr>`
        )
        .join('');

      tbody.querySelectorAll('[data-sr-action]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            const { error } = await supabaseClient
              .from('sell_requests')
              .update({ status: btn.dataset.srStatus })
              .eq('id', btn.dataset.srAction);
            if (error) throw error;
            ARRZ.toast('Status pengajuan diperbarui.', 'success');
            loadSellRequestsTable();
            loadDashboard();
          } catch (e) {
            ARRZ.toast(e.message, 'error');
          }
        });
      });

      tbody.querySelectorAll('[data-sr-convert]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Tambahkan pengajuan ini sebagai akun baru di marketplace?')) return;
          try {
            await convertSellRequestToAccount(btn.dataset.srConvert);
            ARRZ.toast('Akun berhasil ditambahkan ke marketplace.', 'success');
            loadSellRequestsTable();
            loadDashboard();
          } catch (e) {
            ARRZ.toast(e.message, 'error');
          }
        });
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" class="admin-empty">Data belum dapat dimuat. Silakan coba lagi.</td></tr>`;
    }
  }

  // Dulu POST /api/sell-requests/:id/convert (server). Sekarang beberapa
  // langkah Supabase berurutan (aman karena hanya admin yang lolos RLS).
  async function convertSellRequestToAccount(sellRequestId) {
    const { data: sellRequest, error: fetchErr } = await supabaseClient
      .from('sell_requests')
      .select('*')
      .eq('id', sellRequestId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!sellRequest) throw new Error('Pengajuan tidak ditemukan.');
    if (sellRequest.status !== 'ACCEPTED') {
      throw new Error('Pengajuan harus berstatus ACCEPTED sebelum ditambahkan ke marketplace.');
    }

    const { data: account, error: insertErr } = await supabaseClient
      .from('accounts')
      .insert({
        name: sellRequest.account_name,
        platform: sellRequest.platform,
        category_id: sellRequest.category_id,
        username: sellRequest.username,
        price: sellRequest.desired_price || 0,
        description: sellRequest.description,
        details: sellRequest.details,
        features: sellRequest.features,
        status: 'AVAILABLE',
        featured: false,
      })
      .select('*')
      .single();
    if (insertErr) throw insertErr;

    if (Array.isArray(sellRequest.photo_urls) && sellRequest.photo_urls.length > 0) {
      const imageRows = sellRequest.photo_urls.map((url, idx) => ({
        account_id: account.id,
        image_url: url,
        is_primary: idx === 0,
      }));
      const { error: imgErr } = await supabaseClient.from('account_images').insert(imageRows);
      if (imgErr) console.error('[convertSellRequestToAccount] gagal salin gambar:', imgErr.message);
    }

    return account;
  }

  document.querySelectorAll('[data-sell-requests-filter] .tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-sell-requests-filter] .tab-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      currentSellRequestsFilter = btn.dataset.status;
      loadSellRequestsTable();
    });
  });

  // ══════════════════════════════════════════════════════════
  // TRANSAKSI
  // ══════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════
  // TRANSAKSI PEMBELIAN (QRIS DANA Bisnis manual)
  // ══════════════════════════════════════════════════════════

  let currentTransactionsFilter = '';
  let currentTxDetail = null;

  const PAYMENT_STATUS_LABEL = {
    PENDING_PAYMENT: 'Menunggu Pembayaran',
    PROOF_SUBMITTED: 'Perlu Verifikasi',
    VERIFYING: 'Perlu Verifikasi',
    PAID: 'Terverifikasi',
    REJECTED: 'Ditolak',
    EXPIRED: 'Kedaluwarsa',
    COMPLETED: 'Selesai',
  };
  const PAYMENT_STATUS_BADGE = {
    PENDING_PAYMENT: 'badge--pending',
    PROOF_SUBMITTED: 'badge--verifying',
    VERIFYING: 'badge--verifying',
    PAID: 'badge--paid',
    REJECTED: 'badge--rejected',
    EXPIRED: 'badge--expired',
    COMPLETED: 'badge--paid',
  };

  function fmtDateTime(iso) {
    if (!iso) return '-';
    try {
      return new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) {
      return iso;
    }
  }

  async function loadTransactionsTable() {
    const tbody = document.querySelector('[data-transactions-table]');
    tbody.innerHTML = `<tr><td colspan="7" class="admin-empty">Memuat...</td></tr>`;
    try {
      let query = supabaseClient
        .from('transactions')
        .select('*, accounts(name, account_code, platform)')
        .order('created_at', { ascending: false });
      if (currentTransactionsFilter) query = query.eq('payment_status', currentTransactionsFilter);
      const { data, error } = await query;
      if (error) throw error;

      if (!data || data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="admin-empty">Tidak ada transaksi.</td></tr>`;
        return;
      }

      tbody.innerHTML = data
        .map((tx) => {
          const label = PAYMENT_STATUS_LABEL[tx.payment_status] || tx.payment_status;
          const badgeClass = PAYMENT_STATUS_BADGE[tx.payment_status] || 'badge--neutral';
          return `
        <tr>
          <td class="mono">${ARRZ.escapeAttr(tx.invoice_id || '-')}</td>
          <td>${ARRZ.escapeAttr(tx.accounts?.name || '-')}</td>
          <td>
            <div>${ARRZ.escapeAttr(tx.buyer_email || '-')}</div>
            <div class="mono" style="font-size:0.78rem; opacity:0.75;">${ARRZ.escapeAttr(tx.buyer_whatsapp || '-')}</div>
          </td>
          <td class="mono">${ARRZ.formatRupiah(tx.price)}</td>
          <td><span class="badge ${badgeClass}">${ARRZ.escapeAttr(label)}</span></td>
          <td style="font-size:0.78rem;">${fmtDateTime(tx.payment_submitted_at)}</td>
          <td class="admin-table__actions">
            <button class="btn btn-sm" data-tx-detail-btn="${tx.id}">Detail</button>
          </td>
        </tr>`;
        })
        .join('');

      tbody.querySelectorAll('[data-tx-detail-btn]').forEach((btn) => {
        btn.addEventListener('click', () => openTxDetail(btn.dataset.txDetailBtn, data));
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="7" class="admin-empty">Data belum dapat dimuat. Silakan coba lagi.</td></tr>`;
    }
  }

  document.querySelectorAll('[data-transactions-filter] .tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-transactions-filter] .tab-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      currentTransactionsFilter = btn.dataset.status;
      loadTransactionsTable();
    });
  });

  // ── Drawer detail transaksi ─────────────────────────────────
  const txDrawer = document.querySelector('[data-tx-drawer]');

  function closeTxDrawer() {
    txDrawer?.classList.remove('is-open');
    currentTxDetail = null;
  }
  document.querySelector('[data-close-tx-drawer]')?.addEventListener('click', closeTxDrawer);
  txDrawer?.addEventListener('click', (e) => {
    if (e.target === txDrawer) closeTxDrawer();
  });

  async function openTxDetail(txId, rows) {
    const tx = rows.find((r) => r.id === txId);
    if (!tx) return;
    currentTxDetail = tx;

    document.querySelector('[data-tx-account-name]').textContent = tx.accounts?.name || '-';
    document.querySelector('[data-tx-account-code]').textContent = tx.accounts?.account_code || '-';
    document.querySelector('[data-tx-platform]').textContent = tx.accounts?.platform || '-';
    document.querySelector('[data-tx-category]').textContent = '-';
    document.querySelector('[data-tx-price]').textContent = ARRZ.formatRupiah(tx.price);
    document.querySelector('[data-tx-email]').textContent = tx.buyer_email || '-';
    document.querySelector('[data-tx-whatsapp]').textContent = tx.buyer_whatsapp || '-';
    document.querySelector('[data-tx-instagram]').textContent = tx.buyer_instagram || '-';
    document.querySelector('[data-tx-invoice]').textContent = tx.invoice_id || '-';
    document.querySelector('[data-tx-sender-name]').textContent = tx.sender_name || '-';
    document.querySelector('[data-tx-sender-number]').textContent = tx.sender_account_number || '-';
    document.querySelector('[data-tx-submitted-at]').textContent = fmtDateTime(tx.payment_submitted_at);
    document.querySelector('[data-tx-status-label]').textContent = PAYMENT_STATUS_LABEL[tx.payment_status] || tx.payment_status;

    // Kategori akun (query ringan, opsional)
    if (tx.account_id) {
      supabaseClient
        .from('accounts')
        .select('categories(name)')
        .eq('id', tx.account_id)
        .maybeSingle()
        .then(({ data }) => {
          const el = document.querySelector('[data-tx-category]');
          if (el) el.textContent = data?.categories?.name || '-';
        });
    }

    // Bukti pembayaran via signed URL (bucket private)
    const proofWrap = document.querySelector('[data-tx-proof-wrap]');
    proofWrap.innerHTML = `<p style="font-size:0.85rem;">Memuat bukti pembayaran...</p>`;
    if (tx.payment_proof_path) {
      const { data: signed, error: signErr } = await supabaseClient.storage
        .from('payment-proofs')
        .createSignedUrl(tx.payment_proof_path, 3600);
      if (signErr || !signed?.signedUrl) {
        proofWrap.innerHTML = `<p style="font-size:0.85rem;">Bukti pembayaran tidak dapat dimuat.</p>`;
      } else {
        proofWrap.innerHTML = `<img class="tx-proof-img" src="${ARRZ.escapeAttr(signed.signedUrl)}" alt="Bukti pembayaran" data-tx-proof-zoom />`;
        proofWrap.querySelector('[data-tx-proof-zoom]')?.addEventListener('click', () => {
          openProofZoom(signed.signedUrl);
        });
      }
    } else {
      proofWrap.innerHTML = `<p style="font-size:0.85rem;">Belum ada bukti pembayaran.</p>`;
    }

    const rejectionWrap = document.querySelector('[data-tx-rejection-wrap]');
    if (tx.rejection_reason) {
      rejectionWrap.style.display = '';
      document.querySelector('[data-tx-rejection-reason]').textContent = tx.rejection_reason;
    } else {
      rejectionWrap.style.display = 'none';
    }

    // Tombol aksi mengikuti status saat ini
    const actionsWrap = document.querySelector('[data-tx-actions]');
    const deliveryWrap = document.querySelector('[data-tx-delivery-wrap]');
    const approveBtn = document.querySelector('[data-tx-approve-btn]');
    const rejectBtn = document.querySelector('[data-tx-reject-btn]');

    const canVerify = ['PROOF_SUBMITTED', 'VERIFYING'].includes(tx.payment_status);
    actionsWrap.style.display = canVerify ? '' : 'none';
    approveBtn.disabled = !canVerify;
    rejectBtn.disabled = !canVerify;

    deliveryWrap.style.display = tx.payment_status === 'PAID' || tx.payment_status === 'COMPLETED' ? '' : 'none';
    if (deliveryWrap.style.display !== 'none') {
      document.querySelector('[data-tx-delivery-select]').value = tx.transaction_status || 'PROCESSING';
    }

    txDrawer.classList.add('is-open');
  }

  function openProofZoom(url) {
    let overlay = document.querySelector('.tx-proof-img-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'tx-proof-img-overlay';
      overlay.innerHTML = `<img src="" alt="Bukti pembayaran (perbesar)" />`;
      overlay.addEventListener('click', () => overlay.classList.remove('is-open'));
      document.body.appendChild(overlay);
    }
    overlay.querySelector('img').src = url;
    overlay.classList.add('is-open');
  }

  // ── Approve ──────────────────────────────────────────────────
  const approveModal = document.querySelector('[data-tx-approve-modal]');
  document.querySelector('[data-tx-approve-btn]')?.addEventListener('click', () => {
    if (!currentTxDetail) return;
    document.querySelector('[data-tx-approve-confirm-text]').textContent =
      `Pastikan pembayaran sebesar ${ARRZ.formatRupiah(currentTxDetail.price)} benar-benar sudah masuk ke DANA Bisnis ARRZ MARKET.`;
    approveModal.classList.add('is-open');
  });
  document.querySelectorAll('[data-tx-approve-modal] [data-modal-close]').forEach((btn) => {
    btn.addEventListener('click', () => approveModal.classList.remove('is-open'));
  });
  document.querySelector('[data-tx-approve-confirm-btn]')?.addEventListener('click', async () => {
    if (!currentTxDetail) return;
    const btn = document.querySelector('[data-tx-approve-confirm-btn]');
    btn.disabled = true;
    try {
      const { error } = await supabaseClient
        .from('transactions')
        .update({ payment_status: 'PAID' })
        .eq('id', currentTxDetail.id);
      if (error) {
        if ((error.message || '').includes('sudah diverifikasi')) throw new Error('Transaksi ini sudah diverifikasi.');
        throw error;
      }
      ARRZ.toast('Pembayaran diverifikasi. Akun ditandai SOLD.', 'success');
      approveModal.classList.remove('is-open');
      closeTxDrawer();
      loadTransactionsTable();
      loadAccountsTable();
      loadDashboard();
    } catch (e) {
      ARRZ.toast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // ── Reject ───────────────────────────────────────────────────
  const rejectModal = document.querySelector('[data-tx-reject-modal]');
  document.querySelector('[data-tx-reject-btn]')?.addEventListener('click', () => {
    if (!currentTxDetail) return;
    document.querySelector('[data-tx-reject-form]').reset();
    rejectModal.classList.add('is-open');
  });
  document.querySelectorAll('[data-tx-reject-modal] [data-modal-close]').forEach((btn) => {
    btn.addEventListener('click', () => rejectModal.classList.remove('is-open'));
  });
  document.querySelector('[data-tx-reject-reason-select]')?.addEventListener('change', (e) => {
    if (e.target.value) document.querySelector('#tx-reject-reason').value = e.target.value;
  });
  document.querySelector('[data-tx-reject-form]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentTxDetail) return;
    const reason = e.target.rejection_reason.value.trim();
    if (!reason) return ARRZ.toast('Alasan penolakan wajib diisi.', 'error');
    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const { error } = await supabaseClient
        .from('transactions')
        .update({ payment_status: 'REJECTED', rejection_reason: reason })
        .eq('id', currentTxDetail.id);
      if (error) throw error;
      ARRZ.toast('Pembayaran ditolak. Akun dikembalikan ke status Available.', 'success');
      rejectModal.classList.remove('is-open');
      closeTxDrawer();
      loadTransactionsTable();
      loadAccountsTable();
      loadDashboard();
    } catch (e) {
      ARRZ.toast(e.message, 'error');
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ── Status penyerahan akun (pasca PAID) ─────────────────────
  document.querySelector('[data-tx-delivery-select]')?.addEventListener('change', async (e) => {
    if (!currentTxDetail) return;
    try {
      const updates = { transaction_status: e.target.value };
      if (e.target.value === 'COMPLETED') updates.completed_at = new Date().toISOString();
      const { error } = await supabaseClient.from('transactions').update(updates).eq('id', currentTxDetail.id);
      if (error) throw error;
      ARRZ.toast('Status penyerahan diperbarui.', 'success');
      loadTransactionsTable();
    } catch (e) {
      ARRZ.toast(e.message, 'error');
    }
  });

  // ══════════════════════════════════════════════════════════
  // KATEGORI
  // ══════════════════════════════════════════════════════════

  function slugify(text) {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
  }

  async function loadCategoriesTable() {
    const tbody = document.querySelector('[data-categories-table]');
    tbody.innerHTML = `<tr><td colspan="3" class="admin-empty">Memuat...</td></tr>`;
    try {
      const { data, error } = await supabaseClient.from('categories').select('*').order('name', { ascending: true });
      if (error) throw error;
      categoriesCache = data || [];

      if (!data || data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3" class="admin-empty">Belum ada kategori.</td></tr>`;
        return;
      }

      tbody.innerHTML = data
        .map(
          (cat) => `
        <tr>
          <td>${ARRZ.escapeAttr(cat.name)}</td>
          <td class="mono">${ARRZ.escapeAttr(cat.slug)}</td>
          <td class="admin-table__actions">
            <button class="btn btn-sm" style="background:var(--danger-soft); color:var(--danger);" data-delete-category="${cat.id}">Hapus</button>
          </td>
        </tr>`
        )
        .join('');

      tbody.querySelectorAll('[data-delete-category]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Hapus kategori ini?')) return;
          try {
            const { error } = await supabaseClient.from('categories').delete().eq('id', btn.dataset.deleteCategory);
            if (error) throw error;
            ARRZ.toast('Kategori dihapus.', 'success');
            loadCategoriesTable();
          } catch (e) {
            ARRZ.toast(e.message, 'error');
          }
        });
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="3" class="admin-empty">Data belum dapat dimuat. Silakan coba lagi.</td></tr>`;
    }
  }

  document.querySelector('[data-add-category-form]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const cleanName = form.name.value.trim();
      const { error } = await supabaseClient.from('categories').insert({ name: cleanName, slug: slugify(cleanName) });
      if (error) {
        if (error.code === '23505') throw new Error('Kategori dengan nama tersebut sudah ada.');
        throw error;
      }
      ARRZ.toast('Kategori ditambahkan.', 'success');
      form.reset();
      loadCategoriesTable();
    } catch (e) {
      ARRZ.toast(e.message, 'error');
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ══════════════════════════════════════════════════════════
  // PENGATURAN
  // ══════════════════════════════════════════════════════════

  async function loadSettingsForm() {
    const form = document.querySelector('[data-settings-form]');
    const paymentForm = document.querySelector('[data-payment-settings-form]');
    try {
      const { data, error } = await supabaseClient.from('site_settings').select('*').eq('id', 1).maybeSingle();
      if (error) throw error;
      form.site_name.value = data?.site_name || '';
      form.admin_whatsapp.value = data?.admin_whatsapp || '';
      form.footer_text.value = data?.footer_text || '';
      form.wa_template_buy.value = data?.wa_template_buy || '';
      form.wa_template_offer.value = data?.wa_template_offer || '';
      form.wa_template_sell.value = data?.wa_template_sell || '';

      paymentForm.merchant_name.value = data?.merchant_name || data?.site_name || '';
      paymentForm.dana_business_name.value = data?.dana_business_name || '';
      paymentForm.dana_business_number.value = data?.dana_business_number || '';
      paymentForm.payment_expiration_minutes.value = data?.payment_expiration_minutes ?? 30;
      paymentForm.payment_instruction.value = data?.payment_instruction || '';
      paymentForm.payment_whatsapp_template.value = data?.payment_whatsapp_template || '';

      renderQrisPreview(data?.qris_image_path);
    } catch (e) {
      ARRZ.toast(e.message, 'error');
    }
  }

  function renderQrisPreview(path) {
    const preview = document.querySelector('[data-qris-preview]');
    if (!preview) return;
    if (!path) {
      preview.innerHTML = `<div class="admin-empty" style="padding:20px; border:2px dashed var(--border); border-radius:var(--radius);">Belum ada QRIS</div>`;
      return;
    }
    const { data } = supabaseClient.storage.from('payment-assets').getPublicUrl(path);
    preview.innerHTML = data?.publicUrl
      ? `<img src="${ARRZ.escapeAttr(data.publicUrl)}" alt="QRIS DANA Bisnis" style="width:100%; border:var(--border-w-sm) solid var(--border); border-radius:var(--radius);" />`
      : `<div class="admin-empty" style="padding:20px;">QRIS tidak dapat dimuat</div>`;
  }

  function extFromMimeQris(mime) {
    switch (mime) {
      case 'image/jpeg':
      case 'image/jpg':
        return 'jpg';
      case 'image/png':
        return 'png';
      case 'image/webp':
        return 'webp';
      default:
        return null;
    }
  }

  document.querySelector('[data-qris-dropzone]')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-qris-remove]')) return;
    document.querySelector('[data-qris-input]')?.click();
  });

  document.querySelector('[data-qris-input]')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const ext = extFromMimeQris(file.type);
    if (!ext) return ARRZ.toast('Format foto tidak didukung.', 'error');
    if (file.size > 5 * 1024 * 1024) return ARRZ.toast('Ukuran foto maksimal 5 MB.', 'error');

    try {
      const path = `qris-dana-business-${Date.now()}.${ext}`;
      const { error: uploadErr } = await supabaseClient.storage
        .from('payment-assets')
        .upload(path, file, { contentType: file.type, upsert: false });
      if (uploadErr) throw new Error('QRIS gagal diupload. Silakan coba lagi.');

      const { data: current } = await supabaseClient.from('site_settings').select('qris_image_path').eq('id', 1).maybeSingle();
      const oldPath = current?.qris_image_path;

      const { error: updateErr } = await supabaseClient.from('site_settings').update({ qris_image_path: path }).eq('id', 1);
      if (updateErr) throw updateErr;

      if (oldPath && oldPath !== path) {
        await supabaseClient.storage.from('payment-assets').remove([oldPath]);
      }

      renderQrisPreview(path);
      ARRZ.toast('QRIS berhasil diperbarui.', 'success');
    } catch (e) {
      ARRZ.toast(e.message, 'error');
    } finally {
      e.target.value = '';
    }
  });

  document.querySelector('[data-qris-remove]')?.addEventListener('click', async () => {
    if (!confirm('Hapus QRIS DANA Bisnis saat ini?')) return;
    try {
      const { data: current } = await supabaseClient.from('site_settings').select('qris_image_path').eq('id', 1).maybeSingle();
      const oldPath = current?.qris_image_path;
      const { error } = await supabaseClient.from('site_settings').update({ qris_image_path: null }).eq('id', 1);
      if (error) throw error;
      if (oldPath) await supabaseClient.storage.from('payment-assets').remove([oldPath]);
      renderQrisPreview(null);
      ARRZ.toast('QRIS dihapus.', 'success');
    } catch (e) {
      ARRZ.toast(e.message, 'error');
    }
  });

  document.querySelector('[data-payment-settings-form]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Menyimpan...';
    try {
      const minutes = Number(form.payment_expiration_minutes.value) || 30;
      const { error } = await supabaseClient
        .from('site_settings')
        .update({
          merchant_name: form.merchant_name.value.trim(),
          dana_business_name: form.dana_business_name.value.trim(),
          dana_business_number: form.dana_business_number.value.trim(),
          payment_expiration_minutes: minutes,
          payment_instruction: form.payment_instruction.value,
          payment_whatsapp_template: form.payment_whatsapp_template.value,
        })
        .eq('id', 1);
      if (error) throw error;
      ARRZ.toast('Pengaturan pembayaran disimpan.', 'success');
    } catch (e) {
      ARRZ.toast(e.message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Simpan Pengaturan Pembayaran';
    }
  });

  document.querySelector('[data-settings-form]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Menyimpan...';
    try {
      const { error } = await supabaseClient
        .from('site_settings')
        .update({
          site_name: form.site_name.value.trim(),
          admin_whatsapp: form.admin_whatsapp.value.trim(),
          footer_text: form.footer_text.value.trim(),
          wa_template_buy: form.wa_template_buy.value,
          wa_template_offer: form.wa_template_offer.value,
          wa_template_sell: form.wa_template_sell.value,
        })
        .eq('id', 1);
      if (error) throw error;
      ARRZ.toast('Pengaturan disimpan.', 'success');
    } catch (e) {
      ARRZ.toast(e.message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Simpan Pengaturan';
    }
  });

  // ══════════════════════════════════════════════════════════
  // Realtime notifikasi (dulu Socket.IO admin-room)
  // ══════════════════════════════════════════════════════════

  function initRealtime() {
    const activeTab = () => document.querySelector('[data-tab-btn].is-active')?.dataset.tabBtn;

    const channel = supabaseClient
      .channel('arrz-market-admin')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'offers' }, () => {
        ARRZ.toast('Tawaran baru masuk!', 'info');
        loadDashboard();
        if (activeTab() === 'offers') loadOffersTable();
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'offers' }, () => {
        if (activeTab() === 'offers') loadOffersTable();
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sell_requests' }, () => {
        ARRZ.toast('Pengajuan jual akun baru masuk!', 'info');
        loadDashboard();
        if (activeTab() === 'sell-requests') loadSellRequestsTable();
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sell_requests' }, () => {
        if (activeTab() === 'sell-requests') loadSellRequestsTable();
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions' }, () => {
        ARRZ.toast('Ada permintaan pembelian baru!', 'info');
        loadDashboard();
        if (activeTab() === 'transactions') loadTransactionsTable();
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'transactions' }, (payload) => {
        if (activeTab() === 'transactions') loadTransactionsTable();
        if (payload.new?.payment_status === 'PROOF_SUBMITTED') {
          ARRZ.toast('Bukti pembayaran baru masuk, perlu diverifikasi.', 'info');
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'accounts' }, () => {
        if (activeTab() === 'accounts') loadAccountsTable();
        if (activeTab() === 'dashboard') loadDashboard();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'categories' }, () => {
        if (activeTab() === 'categories') loadCategoriesTable();
      })
      .subscribe();

    window.addEventListener('beforeunload', () => {
      supabaseClient.removeChannel(channel);
    });
  }

  // ── Init ─────────────────────────────────────────────────────
  (async function init() {
    const ok = await checkAuth();
    if (!ok) return;
    switchTab('dashboard');
    initRealtime();
  })();
})();
