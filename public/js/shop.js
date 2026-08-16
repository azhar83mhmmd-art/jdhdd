/* ============================================================
   ARRZ MARKET — shop.js
   Halaman Beli Akun: filter kategori/harga/status, search, sort,
   pagination, dan render grid akun. Migrasi: query langsung ke
   Supabase, bukan lagi fetch /api/accounts.
   ============================================================ */

(function () {
  const grid = document.querySelector('[data-shop-grid]');
  if (!grid) return; // bukan halaman shop

  const PLATFORMS = [
    { key: 'Mobile Legends', label: 'Mobile Legends' },
    { key: 'Free Fire', label: 'Free Fire' },
    { key: 'PUBG', label: 'PUBG Mobile' },
    { key: 'Genshin Impact', label: 'Genshin Impact' },
    { key: 'eFootball', label: 'eFootball' },
    { key: 'Valorant', label: 'Valorant' },
    { key: 'Instagram', label: 'Instagram' },
    { key: 'Netflix', label: 'Netflix' },
  ];

  const countEl = document.querySelector('[data-shop-count]');
  const sortSelect = document.querySelector('[data-sort-select]');
  const searchInput = document.querySelector('[data-shop-search]');
  const categoryList = document.querySelector('[data-category-filter-list]');
  const platformList = document.querySelector('[data-platform-filter-list]');
  const platformBanner = document.querySelector('[data-platform-banner]');
  const minPriceInput = document.querySelector('[data-min-price]');
  const maxPriceInput = document.querySelector('[data-max-price]');
  const applyPriceBtn = document.querySelector('[data-apply-price]');
  const resetBtn = document.querySelector('[data-reset-filters]');
  const loadMoreBtn = document.querySelector('[data-load-more]');
  const filterPanel = document.querySelector('[data-filter-panel]');
  const filterToggle = document.querySelector('[data-filter-toggle]');
  const filterClose = document.querySelector('[data-filter-close]');
  const filterBackdrop = document.querySelector('[data-filter-backdrop]');
  const soldSection = document.querySelector('[data-sold-section]');
  const soldGrid = document.querySelector('[data-sold-grid]');
  const soldToggle = document.querySelector('[data-sold-toggle]');

  const params = new URLSearchParams(window.location.search);
  const state = {
    category: params.get('category') || '',
    platform: params.get('platform') || '',
    search: params.get('search') || '',
    minPrice: '',
    maxPrice: '',
    sort: 'newest',
    page: 1,
    limit: 12,
    accumulated: [],
  };

  if (searchInput && state.search) searchInput.value = state.search;

  function updateUrl() {
    const qp = new URLSearchParams();
    if (state.category) qp.set('category', state.category);
    if (state.platform) qp.set('platform', state.platform);
    if (state.search) qp.set('search', state.search);
    const qs = qp.toString();
    window.history.replaceState({}, '', qs ? `?${qs}` : window.location.pathname);
  }

  function renderPlatformBanner() {
    if (!platformBanner) return;
    platformBanner.innerHTML = `
      <button type="button" class="platform-chip ${!state.platform ? 'is-active' : ''}" data-platform-value="">Semua Platform</button>
      ${PLATFORMS.map(
        (p) => `<button type="button" class="platform-chip ${state.platform === p.key ? 'is-active' : ''}" data-platform-value="${ARRZ.escapeAttr(p.key)}">${ARRZ.escapeAttr(p.label)}</button>`
      ).join('')}`;

    platformBanner.querySelectorAll('[data-platform-value]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.platform = btn.dataset.platformValue;
        state.page = 1;
        state.accumulated = [];
        updateUrl();
        renderPlatformBanner();
        syncPlatformFilterList();
        fetchAccounts();
      });
    });
  }

  function syncPlatformFilterList() {
    platformList?.querySelectorAll('input[name="platform"]').forEach((input) => {
      input.checked = input.value === state.platform;
    });
  }

  function renderPlatformFilterList() {
    if (!platformList) return;
    platformList.innerHTML = `
      <label>
        <input type="radio" name="platform" value="" ${!state.platform ? 'checked' : ''} />
        Semua Platform
      </label>
      ${PLATFORMS.map(
        (p) => `
      <label>
        <input type="radio" name="platform" value="${ARRZ.escapeAttr(p.key)}" ${state.platform === p.key ? 'checked' : ''} />
        ${ARRZ.escapeAttr(p.label)}
      </label>`
      ).join('')}`;

    platformList.querySelectorAll('input[name="platform"]').forEach((input) => {
      input.addEventListener('change', () => {
        state.platform = input.value;
        state.page = 1;
        state.accumulated = [];
        updateUrl();
        renderPlatformBanner();
        fetchAccounts();
      });
    });
  }

  async function loadCategories() {
    if (!categoryList) return;
    try {
      const { data, error } = await supabaseClient.from('categories').select('*').order('name', { ascending: true });
      if (error) throw error;
      categoryList.innerHTML = `
        <label>
          <input type="radio" name="category" value="" ${!state.category ? 'checked' : ''} />
          Semua Kategori
        </label>
        ${(data || [])
          .map(
            (cat) => `
          <label>
            <input type="radio" name="category" value="${cat.id}" ${state.category === cat.id ? 'checked' : ''} />
            ${ARRZ.escapeAttr(cat.name)}
          </label>`
          )
          .join('')}`;

      categoryList.querySelectorAll('input[name="category"]').forEach((input) => {
        input.addEventListener('change', () => {
          state.category = input.value;
          state.page = 1;
          state.accumulated = [];
          updateUrl();
          fetchAccounts();
        });
      });
    } catch (e) {
      categoryList.innerHTML = '';
    }
  }

  // ── Bangun query Supabase sesuai filter aktif ────────────────
  function buildAccountsQuery(status) {
    let query = supabaseClient
      .from('accounts')
      .select('*, account_images(id, image_url, is_primary), categories(name)', { count: 'exact' })
      .eq('status', status);

    if (state.category) query = query.eq('category_id', state.category);
    if (state.platform) query = query.ilike('platform', `%${state.platform}%`);
    if (state.minPrice) query = query.gte('price', Number(state.minPrice));
    if (state.maxPrice) query = query.lte('price', Number(state.maxPrice));
    if (state.search) {
      const s = state.search.replace(/[%,]/g, '');
      query = query.or(
        `name.ilike.%${s}%,platform.ilike.%${s}%,username.ilike.%${s}%,description.ilike.%${s}%`
      );
    }

    switch (state.sort) {
      case 'price_asc':
        query = query.order('price', { ascending: true });
        break;
      case 'price_desc':
        query = query.order('price', { ascending: false });
        break;
      case 'popular':
        query = query.order('featured', { ascending: false }).order('created_at', { ascending: false });
        break;
      case 'newest':
      default:
        query = query.order('created_at', { ascending: false });
    }
    return query;
  }

  async function fetchAccounts(append = false) {
    grid.setAttribute('aria-busy', 'true');
    if (!append) {
      grid.innerHTML = ARRZ.skeletonCards(6);
    }
    try {
      const from = (state.page - 1) * state.limit;
      const to = from + state.limit - 1;
      const { data, error, count } = await buildAccountsQuery('AVAILABLE').range(from, to);
      if (error) throw error;

      if (append) {
        state.accumulated = state.accumulated.concat(data || []);
      } else {
        state.accumulated = data || [];
      }

      renderGrid(state.accumulated);

      if (countEl) {
        countEl.textContent = `${count || 0} akun ditemukan`;
      }

      const loaded = state.accumulated.length;
      if (loadMoreBtn) {
        loadMoreBtn.style.display = loaded < (count || 0) ? 'inline-flex' : 'none';
      }
    } catch (e) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column: 1/-1;">
          <h3>Terjadi Kesalahan</h3>
          <p>Data belum dapat dimuat. Silakan coba lagi.</p>
        </div>`;
      if (loadMoreBtn) loadMoreBtn.style.display = 'none';
    } finally {
      grid.setAttribute('aria-busy', 'false');
    }
  }

  function renderGrid(accounts) {
    if (!accounts || accounts.length === 0) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column: 1/-1;">
          <h3>Akun Tidak Ditemukan</h3>
          <p>Coba ubah kata kunci atau filter pencarianmu.</p>
        </div>`;
      return;
    }
    grid.innerHTML = accounts.map(ARRZ.renderAccountCard).join('');
  }

  // ── Bagian "Akun Terjual" (SOLD) — terpisah dari listing utama ──────
  async function fetchSoldAccounts() {
    if (!soldGrid) return;
    soldGrid.innerHTML = ARRZ.skeletonCards(3);
    try {
      const { data, error, count } = await supabaseClient
        .from('accounts')
        .select('*, account_images(id, image_url, is_primary), categories(name)', { count: 'exact' })
        .eq('status', 'SOLD')
        .order('created_at', { ascending: false })
        .range(0, 23);
      if (error) throw error;
      if (!data || data.length === 0) {
        soldSection.style.display = 'none';
        return;
      }
      soldSection.style.display = '';
      soldGrid.innerHTML = data.map(ARRZ.renderAccountCard).join('');
      const countBadge = document.querySelector('[data-sold-count]');
      if (countBadge) countBadge.textContent = count || data.length;
    } catch (e) {
      soldSection.style.display = 'none';
    }
  }

  soldToggle?.addEventListener('click', () => {
    soldGrid.classList.toggle('is-collapsed');
    soldToggle.setAttribute('aria-expanded', soldGrid.classList.contains('is-collapsed') ? 'false' : 'true');
    soldToggle.textContent = soldGrid.classList.contains('is-collapsed') ? 'Tampilkan' : 'Sembunyikan';
  });

  // ── Event bindings ──────────────────────────────────────────
  let searchDebounce;
  searchInput?.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      state.search = searchInput.value.trim();
      state.page = 1;
      state.accumulated = [];
      updateUrl();
      fetchAccounts();
    }, 400);
  });

  sortSelect?.addEventListener('change', () => {
    state.sort = sortSelect.value;
    state.page = 1;
    state.accumulated = [];
    fetchAccounts();
  });

  applyPriceBtn?.addEventListener('click', () => {
    state.minPrice = minPriceInput?.value || '';
    state.maxPrice = maxPriceInput?.value || '';
    state.page = 1;
    state.accumulated = [];
    fetchAccounts();
  });

  resetBtn?.addEventListener('click', () => {
    state.category = '';
    state.platform = '';
    state.search = '';
    state.minPrice = '';
    state.maxPrice = '';
    state.sort = 'newest';
    state.page = 1;
    state.accumulated = [];
    if (searchInput) searchInput.value = '';
    if (minPriceInput) minPriceInput.value = '';
    if (maxPriceInput) maxPriceInput.value = '';
    if (sortSelect) sortSelect.value = 'newest';
    categoryList?.querySelectorAll('input[name="category"]').forEach((i) => (i.checked = i.value === ''));
    syncPlatformFilterList();
    renderPlatformBanner();
    updateUrl();
    fetchAccounts();
  });

  loadMoreBtn?.addEventListener('click', () => {
    state.page += 1;
    fetchAccounts(true);
  });

  filterToggle?.addEventListener('click', () => {
    filterPanel?.classList.add('is-open');
    filterBackdrop?.classList.add('is-open');
  });
  filterClose?.addEventListener('click', closeFilterDrawer);
  filterBackdrop?.addEventListener('click', closeFilterDrawer);
  function closeFilterDrawer() {
    filterPanel?.classList.remove('is-open');
    filterBackdrop?.classList.remove('is-open');
  }

  renderPlatformBanner();
  renderPlatformFilterList();
  loadCategories();
  fetchAccounts();
  fetchSoldAccounts();
})();
