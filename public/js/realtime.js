/* ============================================================
   ARRZ MARKET — realtime.js
   Dulu Socket.IO publik. Sekarang Supabase Realtime (postgres_changes)
   mendengarkan tabel accounts agar homepage/shop/product ikut update
   tanpa reload, persis seperti event account:statusChanged/deleted lama.
   ============================================================ */

(function () {
  if (typeof supabaseClient === 'undefined') return;

  function markCardSold(accountId) {
    document.querySelectorAll(`.account-card[data-account-id="${accountId}"]`).forEach((card) => {
      const inMainGrid = card.closest('[data-shop-grid], [data-featured-accounts]');
      if (inMainGrid) {
        card.remove();
        return;
      }
      card.classList.add('is-sold');
      const badge = card.querySelector('[data-card-status-badge], .badge--available');
      if (badge) {
        badge.textContent = 'Sold';
        badge.classList.remove('badge--available');
        badge.classList.add('badge--sold');
      }
      card.querySelectorAll('[data-card-buy], [data-card-offer]').forEach((btn) => {
        btn.disabled = true;
      });
    });
  }

  function addToSoldSection(account) {
    const soldGrid = document.querySelector('[data-sold-grid]');
    const soldSection = document.querySelector('[data-sold-section]');
    if (!soldGrid || !account) return;
    if (soldGrid.querySelector(`[data-account-id="${account.id}"]`)) return;
    if (typeof ARRZ === 'undefined' || !ARRZ.renderAccountCard) return;

    soldGrid.insertAdjacentHTML('afterbegin', ARRZ.renderAccountCard(account));
    if (soldSection) soldSection.style.display = '';
    const countBadge = document.querySelector('[data-sold-count]');
    if (countBadge) countBadge.textContent = String((Number(countBadge.textContent) || 0) + 1);
  }

  // payload.new / payload.old menggantikan payload lama Socket.IO.
  // Karena Realtime tidak menyertakan relasi (account_images/categories),
  // kita fetch ulang data lengkap sebelum render ke bagian "Akun Terjual".
  async function handleAccountChange(payload) {
    if (payload.eventType === 'DELETE') {
      const id = payload.old?.id;
      if (id) {
        document.querySelectorAll(`.account-card[data-account-id="${id}"]`).forEach((card) => card.remove());
      }
      return;
    }

    const row = payload.new;
    if (!row || !row.id) return;

    if (row.status === 'SOLD') {
      const cardOnPage = document.querySelector(`.account-card[data-account-id="${row.id}"]`);
      markCardSold(row.id);

      const { data: fullAccount } = await supabaseClient
        .from('accounts')
        .select('*, account_images(id, image_url, is_primary), categories(name)')
        .eq('id', row.id)
        .maybeSingle();
      addToSoldSection(fullAccount);

      if (cardOnPage && !(window.ARRZ_PRODUCT_ID && window.ARRZ_PRODUCT_ID === row.id)) {
        ARRZ.toast('Sebuah akun baru saja terjual.', 'info');
      }
      if (window.ARRZ_PRODUCT_ID && window.ARRZ_PRODUCT_ID === row.id) {
        ARRZ.toast('Akun ini baru saja terjual.', 'info');
        const badge = document.querySelector('[data-product-status-badge]');
        if (badge) {
          badge.textContent = 'Sold';
          badge.classList.remove('badge--available', 'badge--reserved');
          badge.classList.add('badge--sold');
        }
        document.querySelectorAll('[data-buy-btn], [data-offer-btn]').forEach((btn) => {
          btn.disabled = true;
        });
        const buyBtn = document.querySelector('[data-buy-btn]');
        if (buyBtn) buyBtn.textContent = 'Sudah Terjual';
      }
    } else if (row.status === 'RESERVED') {
      // Akun sedang diproses pembelian orang lain — perlakukan seperti
      // tidak tersedia di listing (tapi jangan masukkan ke "Akun Terjual").
      const cardOnPage = document.querySelector(`.account-card[data-account-id="${row.id}"]`);
      const inMainGrid = cardOnPage?.closest('[data-shop-grid], [data-featured-accounts]');
      if (inMainGrid) {
        cardOnPage.remove();
      } else if (cardOnPage) {
        cardOnPage.classList.add('is-sold');
        cardOnPage.querySelectorAll('[data-card-buy], [data-card-offer]').forEach((btn) => (btn.disabled = true));
      }
      if (window.ARRZ_PRODUCT_ID && window.ARRZ_PRODUCT_ID === row.id) {
        const badge = document.querySelector('[data-product-status-badge]');
        if (badge) {
          badge.textContent = 'Diproses';
          badge.classList.remove('badge--available');
          badge.classList.add('badge--reserved');
        }
        document.querySelectorAll('[data-buy-btn], [data-offer-btn]').forEach((btn) => (btn.disabled = true));
      }
    } else if (row.status === 'AVAILABLE') {
      document.querySelectorAll(`[data-sold-grid] .account-card[data-account-id="${row.id}"]`).forEach((card) => card.remove());
    }
  }

  // Satu channel per tab, nama unik agar tidak bentrok dengan channel admin.
  const channel = supabaseClient
    .channel('arrz-market-public')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'accounts' }, handleAccountChange)
    .subscribe();

  window.addEventListener('beforeunload', () => {
    supabaseClient.removeChannel(channel);
  });
})();
