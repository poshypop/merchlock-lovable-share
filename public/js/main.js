(function () {
  const CART_KEY = "merchlock_cart_v1";
  const VOTE_KEY = "merchlock_vote_v1";
  const WISHLIST_KEY = "merchlock_wishlist_v1";
  const DISPATCH_KEY = "merchlock_dispatch_v1";
  const DISPATCH_MODAL_DONE_KEY = "merchlock_dispatch_modal_done_v2";
  const DISPATCH_MODAL_SESSION_KEY = "merchlock_dispatch_modal_session_v2";
  const ARTIST_CALL_KEY = "merchlock_artist_call_v1";
  const ROYALTY_RATE = 0.3;
  const CHECKOUT_PAYMENT_ENABLED = false;
  const DROP_STATUS = "in-stock";
  const VOTE_CLOSE_AT = new Date("2026-12-31T23:59:00-05:00").getTime();

  const PRODUCT_CATALOG = {
    REM: {
      sku: "REM",
      name: "Rem Plushie",
      price: 49,
      artist: "@DIECHANCE",
      ships: "Now",
      shopifyVariantId: "gid://shopify/ProductVariant/53625624002859",
    },
  };

  async function createShopifyCheckout(cart) {
    const payload = await apiJson("/api/checkout/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cart }),
    });
    if (!payload.checkoutUrl) throw new Error("Shopify did not return a checkout URL.");
    return payload.checkoutUrl;
  }


  const SHIPPING_OPTIONS = {
    standard: { id: "standard", name: "Standard", basePrice: 6, freeAt: 75 },
    express: { id: "express", name: "Express", basePrice: 14, freeAt: null },
  };

  const HEROES = [
    { id: "doorman", name: "Doorman", role: "Vanguard",   baseVotes: 398 },
    { id: "apollo",  name: "Apollo",  role: "Assassin",   baseVotes: 308 },
    { id: "viscous", name: "Viscous", role: "Guardian",   baseVotes: 245 },
    { id: "ivy",     name: "Ivy",     role: "Skirmisher", baseVotes: 193 },
    { id: "mina",    name: "Mina",    role: "Occultist",  baseVotes: 140 },
  ];

  const NEWS = [
    "first drop · rem plushie · ready to ship",
    "no preorder wait",
    "vote on the next plushie · 5 heroes",
    "30% of net sales revenue to the artist",
    "designed by @DIECHANCE · the catlock guy",
  ];

  /* ============ Cart state ============ */
  function normalizeSku(sku) {
    return String(sku || "").trim().toUpperCase();
  }

  function normalizeQty(qty) {
    const n = Number(qty);
    if (!Number.isFinite(n)) return 0;
    return Math.min(99, Math.max(0, Math.floor(n)));
  }

  function normalizeCart(cart) {
    if (!Array.isArray(cart)) return [];
    const lines = new Map();

    cart.forEach(item => {
      const sku = normalizeSku(item && item.sku);
      const product = PRODUCT_CATALOG[sku];
      const qty = normalizeQty(item && item.qty);
      if (!product || qty < 1) return;

      const existing = lines.get(sku);
      const nextQty = Math.min(99, (existing ? existing.qty : 0) + qty);
      lines.set(sku, { ...product, qty: nextQty });
    });

    return Array.from(lines.values());
  }

  function readCart() {
    try {
      const raw = localStorage.getItem(CART_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      const cart = normalizeCart(parsed);
      if (raw && JSON.stringify(parsed) !== JSON.stringify(cart)) {
        localStorage.setItem(CART_KEY, JSON.stringify(cart));
      }
      return cart;
    } catch {
      localStorage.removeItem(CART_KEY);
      return [];
    }
  }
  function writeCart(cart) {
    localStorage.setItem(CART_KEY, JSON.stringify(normalizeCart(cart)));
    updateCartCount();
  }
  function cartCount() {
    return readCart().reduce((n, it) => n + (it.qty || 0), 0);
  }
  function updateCartCount() {
    document.querySelectorAll("[data-cart-count]").forEach(el => {
      el.textContent = cartCount();
    });
  }

  function formatMoney(amount) {
    return "$" + amount.toFixed(2).replace(/\.00$/, "");
  }

  function getSelectedShippingId() {
    const active = document.querySelector("[data-ship-options] .ship-option.active");
    const id = active && active.getAttribute("data-shipping-id");
    return SHIPPING_OPTIONS[id] ? id : "standard";
  }

  function shippingCostFor(subtotal, shippingId) {
    const option = SHIPPING_OPTIONS[shippingId] || SHIPPING_OPTIONS.standard;
    if (option.freeAt !== null && subtotal >= option.freeAt) return 0;
    return option.basePrice;
  }

  function calculateCartTotals(cart, shippingId = "standard") {
    const subtotal = cart.reduce((n, it) => n + it.price * it.qty, 0);
    const shipping = cart.length ? shippingCostFor(subtotal, shippingId) : 0;
    const tax = Math.round(subtotal * 0.06);
    const total = subtotal + shipping + tax;
    return {
      subtotal,
      shipping,
      tax,
      total,
      royalty: subtotal * ROYALTY_RATE,
    };
  }

  /* ============ Vote state ============ */
  function readVote() {
    try { return localStorage.getItem(VOTE_KEY) || null; }
    catch { return null; }
  }
  function writeVote(id) {
    localStorage.setItem(VOTE_KEY, id);
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function computeVoteTotals() {
    const userVote = readVote();
    const heroes = HEROES.map(h => ({
      ...h,
      votes: h.baseVotes + (userVote === h.id ? 1 : 0),
    }));
    const total = heroes.reduce((n, h) => n + h.votes, 0);
    return { heroes, total, userVote };
  }

  function voteIsOpen() {
    return Date.now() < VOTE_CLOSE_AT;
  }

  function formatVoteCountdown() {
    const remaining = VOTE_CLOSE_AT - Date.now();
    if (remaining <= 0) return "Voting closed";
    const days = Math.floor(remaining / 86400000);
    const hours = Math.floor((remaining % 86400000) / 3600000);
    const minutes = Math.floor((remaining % 3600000) / 60000);
    return `Closes in ${days}d ${hours}h ${minutes}m`;
  }

  function renderVoteStatus() {
    const open = voteIsOpen();
    document.querySelectorAll("[data-vote-status]").forEach(el => {
      el.textContent = open ? "Voting open" : "Voting closed";
    });
    document.querySelectorAll("[data-vote-status-mini]").forEach(el => {
      el.textContent = open ? "Voting open · Round 02" : "Voting closed · Round 02";
    });
    document.querySelectorAll("[data-vote-countdown]").forEach(el => {
      el.textContent = formatVoteCountdown();
    });
  }

  /* ============ News strip ============ */
  function renderNewsStrip() {
    const host = document.getElementById("newsstrip");
    if (!host) return;
    const items = [...NEWS, ...NEWS].map(t => `<span>${t}</span>`).join("");
    host.innerHTML = items;
  }

  /* ============ Vote section ============ */
  function rankedHeroes(heroes) {
    return [...heroes].sort((a, b) => b.votes - a.votes);
  }

  function renderVoteGrid() {
    const host = document.querySelector("[data-vote-grid]");
    if (!host) return;
    const { heroes, total, userVote } = computeVoteTotals();
    const ranked = rankedHeroes(heroes);
    const leaderId = ranked[0].id;
    const open = voteIsOpen();

    host.innerHTML = HEROES.map(h => {
      const votes = heroes.find(x => x.id === h.id).votes;
      const pct = total ? Math.round((votes / total) * 100) : 0;
      const rank = ranked.findIndex(x => x.id === h.id) + 1;
      const isLeading = h.id === leaderId;
      const isVoted = userVote === h.id;
      const cls = ["hero-card"];
      if (isLeading) cls.push("leading");
      if (isVoted) cls.push("voted");
      const btnLabel = !open ? "Voting closed" : isVoted ? "✓ YOUR VOTE" : `Vote ${h.name}`;
      return `
        <div class="${cls.join(" ")}" data-hero-id="${h.id}">
          <span class="hero-rank">${String(rank).padStart(2, "0")}</span>
          <div class="hero-portrait"><img src="assets/heroes/${h.id}.png" alt="${h.name}" /></div>
          <div class="hero-name">${h.name}</div>
          <div class="hero-role">${h.role}</div>
          <div class="hero-meter"><div class="hero-meter-fill" style="width:${pct}%"></div></div>
          <div class="hero-stats"><span>${votes.toLocaleString()} votes</span><span class="pct">${pct}%</span></div>
          <button class="vote-btn" type="button" data-vote="${h.id}" ${open ? "" : "disabled"}>${btnLabel}</button>
        </div>
      `;
    }).join("");

    document.querySelectorAll("[data-total-votes]").forEach(el => {
      el.textContent = total.toLocaleString();
    });
    document.querySelectorAll("[data-total-votes-mini]").forEach(el => {
      el.textContent = total.toLocaleString();
    });

    host.querySelectorAll("[data-vote]").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        if (!voteIsOpen()) return;
        const id = btn.getAttribute("data-vote");
        const current = readVote();
        if (current === id) return;
        writeVote(id);
        renderVoteGrid();
        showVoteFeedback(id);
      });
    });
  }

  function showVoteFeedback(id) {
    const card = document.querySelector(`[data-hero-id="${id}"]`);
    if (card) {
      card.classList.remove("vote-flash");
      void card.offsetWidth;
      card.classList.add("vote-flash");
    }
    let toast = document.querySelector("[data-vote-toast]");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "vote-toast";
      toast.setAttribute("data-vote-toast", "");
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      const vote = document.querySelector(".vote .page");
      if (vote) vote.appendChild(toast);
    }
    toast.textContent = "Vote saved on this device.";
    window.clearTimeout(showVoteFeedback.timer);
    showVoteFeedback.timer = window.setTimeout(() => {
      toast.textContent = "";
    }, 2200);
  }

  /* ============ Gallery ============ */
  function wireGallery() {
    const main = document.querySelector("[data-gallery-main]");
    const tagEl = document.querySelector("[data-gallery-tag]");
    document.querySelectorAll("[data-gallery-thumb]").forEach(t => {
      t.addEventListener("click", () => {
        document.querySelectorAll("[data-gallery-thumb]").forEach(x => {
          x.classList.remove("active");
          x.setAttribute("aria-pressed", "false");
        });
        t.classList.add("active");
        t.setAttribute("aria-pressed", "true");
        const tag = t.getAttribute("data-tag");
        if (tag && tagEl) tagEl.textContent = tag;
        if (main) {
          const variant = t.getAttribute("data-gallery-variant") || "front";
          main.setAttribute("data-gallery-view", variant);
          main.setAttribute("aria-label", `Rem plushie ${variant} view`);
        }
      });
    });
  }

  /* ============ Newsletter ============ */
  function saveDispatchEmail(email) {
    const normalized = String(email || "").trim().toLowerCase();
    const saved = readJson(DISPATCH_KEY, []);
    if (!saved.includes(normalized)) saved.push(normalized);
    writeJson(DISPATCH_KEY, saved);
    return normalized;
  }

  function wireNewsletter() {
    const form = document.querySelector("[data-newsletter]");
    if (!form) return;
    const feedback = document.querySelector("[data-newsletter-feedback]");
    form.addEventListener("submit", e => {
      e.preventDefault();
      const input = form.querySelector("input");
      if (!input) return;
      const email = input.value.trim();
      if (!email || !input.checkValidity()) {
        if (feedback) feedback.textContent = "◈ enter a valid email";
        input.focus();
        return;
      }
      saveDispatchEmail(email);
      if (feedback) feedback.textContent = "◈ saved on this device · email backend not connected";
      input.value = "";
    });
  }

  function wireEmailModal() {
    const modal = document.querySelector("[data-email-modal]");
    const form = document.querySelector("[data-email-modal-form]");
    if (!modal || !form || document.body.getAttribute("data-page") !== "home") return;

    const input = form.querySelector("input");
    const feedback = document.querySelector("[data-email-modal-feedback]");
    const closers = document.querySelectorAll("[data-email-modal-close]");
    let previousFocus = null;
    let open = false;

    const markSessionClosed = () => {
      try { sessionStorage.setItem(DISPATCH_MODAL_SESSION_KEY, "1"); } catch {}
    };

    const shouldOpen = () => {
      try {
        if (localStorage.getItem(DISPATCH_MODAL_DONE_KEY) === "1") return false;
        if (sessionStorage.getItem(DISPATCH_MODAL_SESSION_KEY) === "1") return false;
      } catch {}
      return true;
    };

    function onKeydown(e) {
      if (e.key === "Escape") closeModal();
    }

    function closeModal({ submitted = false } = {}) {
      if (!open) return;
      open = false;
      modal.hidden = true;
      markSessionClosed();
      if (submitted) {
        try { localStorage.setItem(DISPATCH_MODAL_DONE_KEY, "1"); } catch {}
      }
      document.removeEventListener("keydown", onKeydown);
      if (previousFocus && typeof previousFocus.focus === "function") {
        previousFocus.focus({ preventScroll: true });
      }
    }

    function openModal() {
      if (!shouldOpen()) return;
      previousFocus = document.activeElement;
      modal.hidden = false;
      open = true;
      document.addEventListener("keydown", onKeydown);
      if (input) input.focus({ preventScroll: true });
    }

    window.setTimeout(openModal, 2400);

    closers.forEach(btn => {
      btn.addEventListener("click", () => closeModal());
    });

    form.addEventListener("submit", e => {
      e.preventDefault();
      if (!input) return;
      const email = input.value.trim();
      if (!email || !input.checkValidity()) {
        if (feedback) feedback.textContent = "Enter a valid email.";
        input.focus();
        return;
      }
      saveDispatchEmail(email);
      if (feedback) feedback.textContent = "Saved for this device. Email backend next.";
      input.value = "";
      window.setTimeout(() => closeModal({ submitted: true }), 950);
    });
  }

  function wireArtistCall() {
    const form = document.querySelector("[data-artist-call]");
    if (!form) return;
    const feedback = document.querySelector("[data-artist-call-feedback]");
    form.addEventListener("submit", e => {
      e.preventDefault();
      const [handleInput, emailInput] = form.querySelectorAll("input");
      const handle = handleInput?.value.trim();
      const email = emailInput?.value.trim();
      if (!handle || !email || !emailInput.checkValidity()) {
        if (feedback) feedback.textContent = "◈ add a handle and valid email";
        (handle ? emailInput : handleInput)?.focus();
        return;
      }
      const saved = readJson(ARTIST_CALL_KEY, []);
      saved.push({ handle, email, savedAt: new Date().toISOString() });
      writeJson(ARTIST_CALL_KEY, saved.slice(-10));
      form.reset();
      if (feedback) feedback.textContent = "◈ interest saved locally · application backend not connected";
    });
  }

  function wireNotifyDrop() {
    document.querySelectorAll("[data-notify-drop]").forEach(link => {
      link.addEventListener("click", () => {
        window.setTimeout(() => {
          const input = document.querySelector("[data-newsletter] input");
          const feedback = document.querySelector("[data-newsletter-feedback]");
          if (feedback) feedback.textContent = "◈ enter an email to save drop alerts on this device";
          if (input) input.focus({ preventScroll: true });
        }, 250);
      });
    });
  }

  /* ============ Buy / wishlist ============ */
  function wireBuyNow() {
    const btn = document.querySelector("[data-buy-now]");
    if (!btn) return;
    const label = btn.querySelector(".pt");
    if (DROP_STATUS === "sold-out") {
      btn.disabled = true;
      btn.setAttribute("aria-disabled", "true");
      if (label) label.textContent = "SOLD OUT";
      return;
    }
    btn.addEventListener("click", () => {
      const cart = readCart();
      const existing = cart.find(it => it.sku === "REM");
      if (existing) {
        existing.qty += 1;
      } else {
        cart.push({ ...PRODUCT_CATALOG.REM, qty: 1 });
      }
      writeCart(cart);
      if (label) {
        const original = label.textContent;
        btn.classList.add("is-added");
        label.textContent = "ADDED ✓";
        setTimeout(() => {
          label.textContent = original;
          btn.classList.remove("is-added");
        }, 1400);
      }
    });
  }

  function wireWishlist() {
    const btn = document.querySelector("[data-wishlist]");
    if (!btn) return;
    const saved = readJson(WISHLIST_KEY, []);
    const isSaved = saved.includes("REM");
    btn.classList.toggle("active", isSaved);
    btn.textContent = isSaved ? "♥" : "♡";
    btn.setAttribute("aria-pressed", isSaved ? "true" : "false");
    btn.setAttribute("aria-label", isSaved ? "Remove Rem from wishlist" : "Save Rem to wishlist");
    btn.addEventListener("click", () => {
      const next = !btn.classList.contains("active");
      btn.classList.toggle("active", next);
      btn.textContent = next ? "♥" : "♡";
      btn.setAttribute("aria-pressed", next ? "true" : "false");
      btn.setAttribute("aria-label", next ? "Remove Rem from wishlist" : "Save Rem to wishlist");
      writeJson(WISHLIST_KEY, next ? ["REM"] : []);
    });
  }

  /* ============ Smooth scroll ============ */
  function wireSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(a => {
      a.addEventListener("click", e => {
        const href = a.getAttribute("href");
        if (href.length <= 1) return;
        const target = document.querySelector(href);
        if (!target) return;
        e.preventDefault();
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
        history.pushState(null, "", href);
      });
    });
  }

  /* ============ Cart page rendering ============ */
  function renderCart() {
    const host = document.querySelector("[data-cart-items]");
    const summary = document.querySelector("[data-cart-summary]");
    if (!host || !summary) return;

    const cart = readCart();
    if (!cart.length) {
      host.innerHTML = `
        <div class="cart-empty">
          <div class="pulp">YOUR CART IS EMPTY</div>
          <p>Nothing in here yet. Pick up a Rem plushie or check the next vote.</p>
          <a class="jp rust jp-btn" href="index.html#first-drop" style="font-size:13px;">
            <span class="pb"></span><span class="pt">SHOP</span>
          </a>
        </div>
      `;
      summary.innerHTML = "";
      return;
    }

    host.innerHTML = cart.map((it, i) => `
      <div class="cart-item" data-sku="${it.sku}">
        <div class="thumb-img" aria-hidden="true"></div>
        <div>
          <div class="name">${it.name}</div>
          <div class="by">by <a href="index.html#artist">${it.artist}</a></div>
          <div class="sku">SKU-${it.sku} · ships ${it.ships}</div>
          <div class="actions">
            <span class="qty" data-line-qty="${i}">
              <button type="button" data-dec aria-label="decrease">−</button>
              <span class="value mono">${it.qty}</span>
              <button type="button" data-inc aria-label="increase">+</button>
            </span>
            <button type="button" class="text-link" data-remove="${i}">remove</button>
          </div>
        </div>
        <div class="price">${formatMoney(it.price * it.qty)}</div>
      </div>
    `).join("");

    const totals = calculateCartTotals(cart);
    const artist = cart[0]?.artist || "@DIECHANCE";

    summary.innerHTML = `
      <div class="summary-card">
        <div class="head">ORDER SUMMARY</div>
        <div class="line"><span class="label">Subtotal</span><span class="val">${formatMoney(totals.subtotal)}</span></div>
        <div class="line"><span class="label">Shipping</span><span class="val">${totals.shipping === 0 ? "FREE" : formatMoney(totals.shipping)}</span></div>
        <div class="line"><span class="label">Estimated tax</span><span class="val">${formatMoney(totals.tax)}</span></div>
        <div class="grand"><span class="label">Total</span><span class="val">${formatMoney(totals.total)}</span></div>
        <div class="royalty-mini">
          <div class="lab">◈ ARTIST ROYALTY</div>
          <p>Estimated at 30% of net sales revenue for <a href="index.html#artist">${artist}</a>. Final royalties exclude tax, shipping, processing fees, refunds/returns, and customs duties.</p>
        </div>
        <div class="checkout-btn">
          <button type="button" class="jp rust jp-btn" data-shopify-checkout style="font-size:14px;width:100%;display:block;text-align:center;border:0;cursor:pointer;">
            <span class="pb"></span><span class="pt">CHECKOUT WITH SHOPIFY</span>
          </button>
        </div>
        <div class="secure" data-shopify-feedback role="status" aria-live="polite">secure checkout via shopify</div>
      </div>
    `;

    const checkoutBtn = host.parentElement?.querySelector("[data-shopify-checkout]") || document.querySelector("[data-shopify-checkout]");
    if (checkoutBtn) wireShopifyCheckoutButton(checkoutBtn);

    host.querySelectorAll("[data-line-qty]").forEach(grp => {
      const i = parseInt(grp.getAttribute("data-line-qty"), 10);
      grp.querySelector("[data-dec]").addEventListener("click", () => {

        const c = readCart();
        if (!c[i]) return;
        c[i].qty = Math.max(1, c[i].qty - 1);
        writeCart(c); renderCart();
      });
      grp.querySelector("[data-inc]").addEventListener("click", () => {
        const c = readCart();
        if (!c[i]) return;
        c[i].qty += 1;
        writeCart(c); renderCart();
      });
    });
    host.querySelectorAll("[data-remove]").forEach(btn => {
      btn.addEventListener("click", () => {
        const i = parseInt(btn.getAttribute("data-remove"), 10);
        const c = readCart();
        c.splice(i, 1);
        writeCart(c); renderCart();
      });
    });
  }

  /* ============ Checkout summary ============ */
  function renderCheckoutSummary() {
    const host = document.querySelector("[data-checkout-summary]");
    if (!host) return;
    const cart = readCart();
    const shippingId = getSelectedShippingId();
    updateCheckoutAvailability(cart.length > 0);

    if (!cart.length) {
      host.innerHTML = `
        <div class="co-summary">
          <div class="head">YOUR ORDER</div>
          <p style="color:var(--dim);font-size:13px;margin:0 0 16px;">Cart is empty. Head back to add the Rem plushie.</p>
          <a class="jp rust jp-btn" href="index.html#first-drop" style="font-size:13px;">
            <span class="pb"></span><span class="pt">BROWSE</span>
          </a>
        </div>
      `;
      return;
    }

    const totals = calculateCartTotals(cart, shippingId);
    const shippingOption = SHIPPING_OPTIONS[shippingId] || SHIPPING_OPTIONS.standard;

    host.innerHTML = `
      <div class="co-summary">
        <div class="head">YOUR ORDER</div>
        ${cart.map(it => `
          <div class="line-item">
            <div class="ti"></div>
            <div class="info">
              <div class="name">${it.name}${it.qty > 1 ? ` × ${it.qty}` : ""}</div>
              <div class="by">by <a href="index.html#artist">${it.artist}</a></div>
            </div>
            <div class="v">${formatMoney(it.price * it.qty)}</div>
          </div>
        `).join("")}
        <div class="totals">
          <div class="row"><span class="label">Subtotal</span><span class="val">${formatMoney(totals.subtotal)}</span></div>
          <div class="row"><span class="label">Shipping (${shippingOption.name})</span><span class="val">${totals.shipping === 0 ? "FREE" : formatMoney(totals.shipping)}</span></div>
          <div class="row"><span class="label">Estimated tax</span><span class="val">${formatMoney(totals.tax)}</span></div>
          <div class="grand"><span class="label">Total</span><span class="val">${formatMoney(totals.total)}</span></div>
        </div>
        <div class="royalty-mini">
          <div class="lab">◈ EST. ${formatMoney(totals.royalty)} NET-SALES ROYALTY TO @DIECHANCE</div>
        </div>
      </div>
    `;
  }

  function updateCheckoutAvailability(hasCart) {
    if (document.body.getAttribute("data-page") !== "checkout") return;
    document.body.classList.toggle("checkout-empty", !hasCart);
    const form = document.querySelector("[data-checkout-form]");
    const placeOrder = document.querySelector("[data-place-order]");
    if (form) {
      form.querySelectorAll("input, button").forEach(el => {
        if (el.matches("[data-place-order]")) return;
        el.disabled = !hasCart;
      });
    }
    if (placeOrder) {
      placeOrder.disabled = !hasCart;
      placeOrder.setAttribute("aria-disabled", hasCart ? "false" : "true");
    }
  }

  /* ============ Checkout interactions ============ */
  function wireShipOptions() {
    const host = document.querySelector("[data-ship-options]");
    if (!host) return;
    const selectOption = opt => {
      if (!opt || opt.disabled) return;
      host.querySelectorAll(".ship-option").forEach(x => {
        x.classList.remove("active");
        x.setAttribute("aria-checked", "false");
        const r = x.querySelector(".radio");
        if (r) r.textContent = "○";
      });
      opt.classList.add("active");
      opt.setAttribute("aria-checked", "true");
      const r = opt.querySelector(".radio");
      if (r) r.textContent = "●";
      renderCheckoutSummary();
    };
    host.querySelectorAll(".ship-option").forEach(opt => {
      opt.addEventListener("click", () => {
        selectOption(opt);
      });
      opt.addEventListener("keydown", e => {
        const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
        if (!keys.includes(e.key)) return;
        e.preventDefault();
        const options = [...host.querySelectorAll(".ship-option")].filter(x => !x.disabled);
        const current = options.indexOf(opt);
        const last = options.length - 1;
        let next = current;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") next = current >= last ? 0 : current + 1;
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = current <= 0 ? last : current - 1;
        if (e.key === "Home") next = 0;
        if (e.key === "End") next = last;
        const nextOpt = options[next];
        selectOption(nextOpt);
        nextOpt?.focus();
      });
    });
  }

  function wireShopifyCheckoutButton(btn) {
    if (!btn || btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", async () => {
      const feedback = document.querySelector("[data-shopify-feedback]") || document.querySelector("[data-checkout-feedback]");
      const cart = readCart();
      if (!cart.length) {
        if (feedback) feedback.textContent = "Cart is empty.";
        return;
      }
      const user = await requireSteam(feedback);
      if (!user) return;
      const label = btn.querySelector(".pt");
      const original = label ? label.textContent : "";
      if (label) label.textContent = "OPENING…";
      btn.disabled = true;
      try {
        const url = await createShopifyCheckout(cart);
        window.open(url, "_blank", "noopener");
        if (feedback) feedback.textContent = "Checkout opened in a new tab.";
      } catch (err) {
        console.error(err);
        if (feedback) feedback.textContent = "Could not open checkout: " + (err.message || "unknown error");
      } finally {
        btn.disabled = false;
        if (label) label.textContent = original;
      }
    });
  }

  function wirePlaceOrder() {
    const btn = document.querySelector("[data-place-order]");
    if (!btn) return;
    const label = btn.querySelector(".pt");
    if (label) label.textContent = "CHECKOUT WITH SHOPIFY";
    btn.addEventListener("click", async () => {
      const feedback = document.querySelector("[data-checkout-feedback]");
      if (!readCart().length) {
        if (feedback) feedback.textContent = "Cart is empty. Add the Rem plushie before checkout.";
        return;
      }
      const user = await requireSteam(feedback);
      if (!user) return;
      try {
        btn.disabled = true;
        const url = await createShopifyCheckout(readCart());
        window.open(url, "_blank", "noopener");
        if (feedback) feedback.textContent = "Checkout opened in a new tab on Shopify.";
      } catch (err) {
        console.error(err);
        if (feedback) feedback.textContent = "Could not open checkout: " + (err.message || "unknown error");
      } finally {
        btn.disabled = false;
      }
    });
  }

  /* ============ Redeem / admin ============ */
  const ADMIN_TOKEN_KEY = "merchlock_redeem_admin_token_v1";

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  async function apiJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: options.headers || {},
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { ok: false, error: text || "Server returned an unreadable response." };
    }

    if (!response.ok || payload?.ok === false) {
      const error = new Error(payload?.error || `Request failed (${response.status})`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  function formatApiError(error) {
    const payload = error?.payload || {};
    const missing = Array.isArray(payload.missing) && payload.missing.length
      ? ` Missing env: ${payload.missing.join(", ")}.`
      : "";
    return `${error?.message || "Something went wrong."}${missing}`;
  }

  let sessionCache = null;
  let sessionPromise = null;

  function currentPath() {
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
  }

  function steamLoginHref(returnPath = currentPath()) {
    return `/api/auth/steam/start?return=${encodeURIComponent(returnPath)}`;
  }

  function useInventoryPreview() {
    const params = new URLSearchParams(window.location.search);
    const local = ["127.0.0.1", "localhost"].includes(window.location.hostname);
    return local && params.get("preview") === "steam-inventory";
  }

  function previewSession() {
    return {
      ok: true,
      user: {
        steamId: "76561198000000000",
        personaName: "POSHYPOP",
        avatarUrl: "assets/poshypop.png",
        profileUrl: "https://steamcommunity.com/",
      },
    };
  }

  function previewInventory() {
    return {
      ok: true,
      user: previewSession().user,
      items: [
        {
          slug: "rem_plushie",
          title: "Rem Plushie",
          kind: "item",
          description: "Ready-to-ship Merchlock plushie designed by DIECHANCE.",
          imagePath: "assets/rem-product.png",
          sourceType: "shopify_order",
          acquiredAt: new Date().toISOString(),
        },
        {
          slug: "rem_bag_skin",
          title: "Rem Bag Skin",
          kind: "item",
          description: "Unsecured Soul Container-inspired item connected to this Steam account.",
          imagePath: "assets/unsecured-soul-container.svg",
          sourceType: "shared_redeem_code",
          acquiredAt: new Date().toISOString(),
        },
      ],
    };
  }

  async function loadSession({ force = false } = {}) {
    if (useInventoryPreview()) {
      sessionCache = previewSession();
      return sessionCache;
    }
    if (sessionCache && !force) return sessionCache;
    if (sessionPromise && !force) return sessionPromise;
    sessionPromise = apiJson("/api/session")
      .then(payload => {
        sessionCache = payload;
        return payload;
      })
      .catch(error => {
        sessionCache = { ok: false, user: null, error: formatApiError(error) };
        return sessionCache;
      })
      .finally(() => {
        sessionPromise = null;
      });
    return sessionPromise;
  }

  function accountAvatar(user) {
    const image = user?.avatarUrl ? `style="background-image:url('${escapeHtml(user.avatarUrl)}')"` : "";
    return `<span class="steam-avatar" ${image} aria-hidden="true"></span>`;
  }

  function renderSteamAuth(payload) {
    document.querySelectorAll("[data-steam-auth]").forEach(host => {
      const user = payload?.user;
      if (user) {
        host.innerHTML = `
          <a class="steam-profile" href="inventory.html" title="View Merchlock inventory">
            ${accountAvatar(user)}
            <span>
              <b>${escapeHtml(user.personaName || "Steam user")}</b>
              <small>${escapeHtml(user.steamId || "")}</small>
            </span>
          </a>
          <button class="steam-logout" type="button" data-steam-logout>LOG OUT</button>
        `;
      } else {
        host.innerHTML = `
          <a class="steam-login" href="${escapeHtml(steamLoginHref())}" data-steam-login>
            <span class="steam-mark" aria-hidden="true"></span>
            <span>Sign in with Steam</span>
          </a>
        `;
      }
    });
  }

  function wireSteamAuth() {
    if (!document.querySelector("[data-steam-auth]")) return;
    renderSteamAuth({ user: null });
    loadSession().then(renderSteamAuth);
    document.addEventListener("click", async e => {
      const logout = e.target.closest?.("[data-steam-logout]");
      if (!logout) return;
      e.preventDefault();
      logout.disabled = true;
      try {
        await apiJson("/api/auth/logout", { method: "POST" });
        sessionCache = { ok: true, user: null };
        renderSteamAuth(sessionCache);
        renderInventoryPage();
      } catch (error) {
        console.error(error);
      } finally {
        logout.disabled = false;
      }
    });
  }

  async function requireSteam(feedback, message = "Sign in with Steam before checkout so the plushie can be added to your Merchlock inventory.") {
    const session = await loadSession();
    if (session?.user) return session.user;
    if (feedback) {
      feedback.innerHTML = `
        ${escapeHtml(message)}
        <a class="inline-steam-link" href="${escapeHtml(steamLoginHref())}">Sign in with Steam</a>
      `;
    }
    return null;
  }

  function inventoryItemImage(item) {
    const path = item?.imagePath || "assets/rem-detail.svg";
    return `style="background-image:url('${escapeHtml(path)}')"`;
  }

  function inventoryOwnedDate(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return "Recently";
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function inventoryPublicDescription(item) {
    if (item?.slug === "rem_bag_skin") {
      return "Unsecured Soul Container-inspired item connected to this Steam account.";
    }
    if (item?.slug === "rem_plushie") {
      return "Ready-to-ship Merchlock plushie designed by DIECHANCE.";
    }
    return item?.description || "Merchlock inventory item.";
  }

  function inventoryDetailMarkup(item) {
    if (!item) {
      return `
        <div class="merch-inv-detail-empty">
          <b>No item selected.</b>
          <span>Choose an item from the grid.</span>
        </div>
      `;
    }
    return `
      <div class="merch-inv-detail-art" ${inventoryItemImage(item)}></div>
      <div class="merch-inv-detail-body">
        <div class="merch-inv-detail-kicker">MERCHLOCK ITEM</div>
        <h2>${escapeHtml(item.title || "Inventory item")}</h2>
        <p>${escapeHtml(inventoryPublicDescription(item))}</p>
        <div class="merch-inv-props">
          <div>
            <span>Acquired</span>
            <b>${escapeHtml(inventoryOwnedDate(item.acquiredAt))}</b>
          </div>
          <div>
            <span>Collection</span>
            <b>Merchlock</b>
          </div>
          <div>
            <span>Account</span>
            <b>Steam linked</b>
          </div>
        </div>
        <div class="merch-inv-actions">
          <a class="merch-inv-action primary" href="redeem.html">Redeem code</a>
          <a class="merch-inv-action" href="index.html#first-drop">Shop drop</a>
        </div>
      </div>
    `;
  }

  function inventoryGridSlots(items) {
    const slotCount = Math.max(24, Math.ceil((items.length || 1) / 6) * 6);
    return Array.from({ length: slotCount }, (_, index) => {
      const item = items[index];
      if (!item) return `<span class="merch-inv-slot" aria-hidden="true"></span>`;
      return `
        <button class="merch-inv-item${index === 0 ? " selected" : ""}" type="button" data-inventory-select="${index}" aria-pressed="${index === 0 ? "true" : "false"}">
          <span class="merch-inv-item-art" ${inventoryItemImage(item)}></span>
          <span class="merch-inv-item-name">${escapeHtml(item.title || "Inventory item")}</span>
          <span class="merch-inv-item-type">Item</span>
        </button>
      `;
    }).join("");
  }

  function wireInventorySelection(host, items) {
    const detail = host.querySelector("[data-inventory-detail]");
    const selectItem = button => {
      const index = Number(button.getAttribute("data-inventory-select"));
      const item = items[index];
      if (!item || !detail) return;
      host.querySelectorAll("[data-inventory-select]").forEach(other => {
        other.classList.toggle("selected", other === button);
        other.setAttribute("aria-pressed", other === button ? "true" : "false");
      });
      detail.innerHTML = inventoryDetailMarkup(item);
    };
    host.querySelectorAll("[data-inventory-select]").forEach(button => {
      button.addEventListener("click", () => selectItem(button));
    });

    const search = host.querySelector("[data-inventory-search]");
    search?.addEventListener("input", () => {
      const term = search.value.trim().toLowerCase();
      let firstVisible = null;
      host.querySelectorAll("[data-inventory-select]").forEach(button => {
        const item = items[Number(button.getAttribute("data-inventory-select"))];
        const text = `${item?.title || ""} ${inventoryPublicDescription(item)}`.toLowerCase();
        const visible = !term || text.includes(term);
        button.hidden = !visible;
        if (visible && !firstVisible) firstVisible = button;
      });
      host.querySelectorAll(".merch-inv-slot").forEach(slot => {
        slot.hidden = Boolean(term);
      });
      const selected = host.querySelector("[data-inventory-select].selected:not([hidden])");
      if (selected) return;
      if (firstVisible) {
        selectItem(firstVisible);
      } else if (detail) {
        detail.innerHTML = `
          <div class="merch-inv-detail-empty">
            <b>No matches.</b>
            <span>Clear search to see every item.</span>
          </div>
        `;
      }
    });
  }

  async function renderInventoryPage() {
    const host = document.querySelector("[data-inventory]");
    if (!host) return;

    host.innerHTML = `<div class="inventory-loading">Loading inventory...</div>`;
    const session = await loadSession({ force: true });
    renderSteamAuth(session);

    if (!session?.user) {
      host.innerHTML = `
        <section class="inventory-state">
          <div class="redeem-kicker">STEAM REQUIRED</div>
          <h1>Your Merchlock inventory.</h1>
          <p>Sign in with Steam to connect Merchlock items to your account.</p>
          <a class="jp rust jp-btn" href="${escapeHtml(steamLoginHref("/inventory.html"))}">
            <span class="pb"></span>
            <span class="pt">SIGN IN WITH STEAM</span>
          </a>
        </section>
      `;
      return;
    }

    try {
      const payload = useInventoryPreview() ? previewInventory() : await apiJson("/api/inventory");
      const items = Array.isArray(payload.items) ? payload.items : [];
      host.innerHTML = `
        <section class="merch-inv">
          <div class="merch-inv-top">
            <div class="merch-inv-title">
              <b>Steam-linked Merchlock account</b>
              <span>Inventory</span>
            </div>
            <div class="merch-inv-user">
              ${accountAvatar(payload.user)}
              <span>
                <b>${escapeHtml(payload.user?.personaName || "Steam user")}</b>
                <small>${escapeHtml(payload.user?.steamId || "")}</small>
              </span>
            </div>
          </div>
          <div class="merch-inv-tabs" aria-label="Inventory filters">
            <button class="active" type="button">All items</button>
            <span>${escapeHtml(String(items.length))} owned</span>
          </div>
          <div class="merch-inv-body">
            <aside class="merch-inv-rail" aria-label="Inventory collection">
              <button class="active" type="button">
                <span>MERCHLOCK</span>
                <b>${escapeHtml(String(items.length))}</b>
              </button>
            </aside>
            <section class="merch-inv-grid-panel">
              <div class="merch-inv-toolbar">
                <div>
                  <input class="merch-inv-search" data-inventory-search type="search" placeholder="Search inventory" aria-label="Search inventory" />
                  <b>${escapeHtml(String(items.length))} item${items.length === 1 ? "" : "s"}</b>
                </div>
                <a href="redeem.html">Redeem code</a>
              </div>
              ${
                items.length
                  ? `<div class="merch-inv-grid" role="list">${inventoryGridSlots(items)}</div>`
                  : `<div class="inventory-empty">
                      <b>No items yet.</b>
                      Buy the Rem plushie while signed in, or redeem a Merchlock code to start your inventory.
                    </div>`
              }
            </section>
            <aside class="merch-inv-detail" data-inventory-detail>
              ${inventoryDetailMarkup(items[0])}
            </aside>
          </div>
        </section>
      `;
      wireInventorySelection(host, items);
    } catch (error) {
      host.innerHTML = `<div class="redeem-result error">${escapeHtml(formatApiError(error))}</div>`;
    }
  }

  function setBusyButton(button, busy, busyText = "WORKING") {
    if (!button) return () => {};
    const label = button.querySelector(".pt");
    const original = label ? label.textContent : button.textContent;
    button.disabled = busy;
    if (label) label.textContent = busy ? busyText : original;
    return () => {
      button.disabled = false;
      if (label) label.textContent = original;
    };
  }

  function wireRedeemPage() {
    const form = document.querySelector("[data-redeem-form]");
    if (!form) return;
    const input = form.querySelector("[data-redeem-code]");
    const result = document.querySelector("[data-redeem-result]");
    const account = document.querySelector("[data-redeem-account]");
    const button = form.querySelector("button[type='submit']");

    loadSession().then(session => {
      renderSteamAuth(session);
      if (!account) return;
      if (session?.user) {
        account.innerHTML = `
          ${accountAvatar(session.user)}
          <span>
            <b>Redeeming as ${escapeHtml(session.user.personaName || "Steam user")}</b>
            Code claims attach to SteamID ${escapeHtml(session.user.steamId || "")}.
          </span>
        `;
        form.classList.remove("is-disabled");
      } else {
        account.innerHTML = `
          <span class="steam-avatar" aria-hidden="true"></span>
          <span>
            <b>Steam sign-in required.</b>
            Sign in before redeeming.
          </span>
          <a class="inline-steam-link" href="${escapeHtml(steamLoginHref("/redeem.html"))}">Sign in with Steam</a>
        `;
      }
    });

    form.addEventListener("submit", async e => {
      e.preventDefault();
      const user = await requireSteam(result, "Sign in with Steam before redeeming.");
      if (!user) return;
      const code = input?.value.trim();
      if (!code) {
        if (result) {
          result.className = "redeem-result error";
          result.textContent = "Enter a code.";
        }
        input?.focus();
        return;
      }

      const resetButton = setBusyButton(button, true, "CHECKING");
      if (result) {
        result.className = "redeem-result";
        result.textContent = "Checking code...";
      }

      try {
        const payload = await apiJson("/api/redeem", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code }),
        });

        if (result) {
          result.className = "redeem-result success";
          result.innerHTML = `
            <div class="redeem-success-title">Code accepted.</div>
            <p>${payload.alreadyInInventory || payload.alreadyRedeemed ? "Already claimed on this Steam account." : "Inventory updated."}</p>
            ${payload.downloadUrl ? `
              <a class="jp teal jp-btn redeem-download" href="${escapeHtml(payload.downloadUrl)}" target="_blank" rel="noopener">
                <span class="pb"></span>
                <span class="pt">DOWNLOAD</span>
              </a>
            ` : ""}
            <a class="text-link redeem-inventory-link" href="inventory.html">view inventory</a>
            ${payload.downloadUrl ? `<div class="redeem-expiry">Link expires in about one hour.</div>` : ""}
          `;
        }
      } catch (error) {
        if (result) {
          result.className = "redeem-result error";
          result.textContent = formatApiError(error);
        }
      } finally {
        resetButton();
      }
    });
  }

  function wireAdminRedeem() {
    const root = document.querySelector("[data-admin-redeem]");
    if (!root) return;

    const tokenInput = document.querySelector("[data-admin-token]");
    const refreshBtn = document.querySelector("[data-admin-refresh]");
    const feedback = document.querySelector("[data-admin-feedback]");
    const modForm = document.querySelector("[data-admin-mod-form]");
    const codeForm = document.querySelector("[data-admin-code-form]");
    const sharedForm = document.querySelector("[data-admin-shared-form]");
    const disableForm = document.querySelector("[data-admin-disable-form]");
    const codesBody = document.querySelector("[data-admin-codes]");
    const output = document.querySelector("[data-admin-code-output]");
    const downloadCsvBtn = document.querySelector("[data-admin-download-csv]");
    let latestCsv = "";

    const savedToken = (() => {
      try { return sessionStorage.getItem(ADMIN_TOKEN_KEY) || ""; } catch { return ""; }
    })();
    if (tokenInput && savedToken) tokenInput.value = savedToken;

    function token() {
      return String(tokenInput?.value || "").trim();
    }

    function setFeedback(message, type = "") {
      if (!feedback) return;
      feedback.textContent = message;
      feedback.dataset.status = type;
    }

    function adminHeaders(extra = {}) {
      return {
        authorization: `Bearer ${token()}`,
        ...extra,
      };
    }

    function rememberToken() {
      try {
        if (token()) sessionStorage.setItem(ADMIN_TOKEN_KEY, token());
      } catch {}
    }

    function renderAdminLists(data) {
      const mods = Array.isArray(data.mods) ? data.mods : [];
      const codes = Array.isArray(data.codes) ? data.codes : [];
      const inventoryItems = Array.isArray(data.inventoryItems) ? data.inventoryItems : [];
      const claimCounts = data.claimCounts || {};
      const modNameById = new Map(mods.map(mod => [mod.id, mod.title || mod.slug || "File"]));

      document.querySelectorAll("[data-admin-mod-select]").forEach(select => {
        select.innerHTML = mods.length
          ? mods.map(mod => `<option value="${escapeHtml(mod.id)}">${escapeHtml(mod.title || mod.slug)}</option>`).join("")
          : `<option value="">No files yet</option>`;
      });

      document.querySelectorAll("[data-admin-item-select]").forEach(select => {
        select.innerHTML = inventoryItems.length
          ? inventoryItems.map(item => `<option value="${escapeHtml(item.slug)}">${escapeHtml(item.title || item.slug)}</option>`).join("")
          : `<option value="rem_bag_skin">Rem Bag Skin</option>`;
      });

      if (codesBody) {
        codesBody.innerHTML = codes.length
          ? codes.map(code => {
              const safeCode = `${code.code_prefix || "CODE"}...${code.code_suffix || "----"}`;
              const codeType = code.code_type || "one_time_download";
              const codeTypeLabel = codeType === "shared_reward_download" ? "shared code" : codeType.replace(/_/g, " ");
              const reward = code.inventory_item_slug || "-";
              const uses = codeType === "shared_reward_download"
                ? `${claimCounts[code.id] || code.shared_uses || 0} accounts`
                : (code.status === "redeemed" ? "1" : "0");
              return `
                <tr>
                  <td><button class="text-link mono" type="button" data-copy-value="${escapeHtml(code.batch_id)}">${escapeHtml(String(code.batch_id || "").slice(0, 8))}</button></td>
                  <td><span class="mono">${escapeHtml(safeCode)}</span></td>
                  <td>${escapeHtml(codeTypeLabel)}</td>
                  <td><span class="status-pill ${escapeHtml(code.status || "active")}">${escapeHtml(code.status || "active")}</span></td>
                  <td>${escapeHtml(reward)}</td>
                  <td>${escapeHtml(uses)}</td>
                  <td>${escapeHtml(modNameById.get(code.mod_file_id) || String(code.mod_file_id || "").slice(0, 8))}</td>
                </tr>
              `;
            }).join("")
          : `<tr><td colspan="7">No codes generated yet.</td></tr>`;

        codesBody.querySelectorAll("[data-copy-value]").forEach(btn => {
          btn.addEventListener("click", async () => {
            const value = btn.getAttribute("data-copy-value") || "";
            try {
              await navigator.clipboard.writeText(value);
              setFeedback("Batch ID copied.", "success");
            } catch {
              setFeedback(value, "success");
            }
          });
        });
      }
    }

    async function loadAdmin() {
      if (!token()) {
        setFeedback("Enter the admin token first.", "error");
        tokenInput?.focus();
        return;
      }
      rememberToken();
      const reset = setBusyButton(refreshBtn, true, "LOADING");
      try {
        const data = await apiJson("/api/admin/codes", {
          method: "GET",
          headers: adminHeaders(),
        });
        renderAdminLists(data);
        setFeedback("Admin data loaded.", "success");
      } catch (error) {
        setFeedback(formatApiError(error), "error");
      } finally {
        reset();
      }
    }

    refreshBtn?.addEventListener("click", loadAdmin);

    modForm?.addEventListener("submit", async e => {
      e.preventDefault();
      if (!token()) {
        setFeedback("Enter the admin token first.", "error");
        tokenInput?.focus();
        return;
      }

      const submit = modForm.querySelector("button[type='submit']");
      const reset = setBusyButton(submit, true, "SAVING");
      try {
        rememberToken();
        const data = new FormData(modForm);
        await apiJson("/api/admin/mods", {
          method: "POST",
          headers: adminHeaders(),
          body: data,
        });
        modForm.reset();
        setFeedback("File registered.", "success");
        await loadAdmin();
      } catch (error) {
        setFeedback(formatApiError(error), "error");
      } finally {
        reset();
      }
    });

    codeForm?.addEventListener("submit", async e => {
      e.preventDefault();
      if (!token()) {
        setFeedback("Enter the admin token first.", "error");
        tokenInput?.focus();
        return;
      }

      const submit = codeForm.querySelector("button[type='submit']");
      const reset = setBusyButton(submit, true, "MAKING");
      try {
        rememberToken();
        const data = new FormData(codeForm);
        const payload = await apiJson("/api/admin/codes/generate", {
          method: "POST",
          headers: adminHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({
            modFileId: data.get("modFileId"),
            quantity: data.get("quantity"),
            prefix: data.get("prefix"),
            notes: data.get("notes"),
          }),
        });
        latestCsv = payload.csv || "";
        if (output) output.value = latestCsv || (payload.codes || []).join("\n");
        if (downloadCsvBtn) downloadCsvBtn.disabled = !latestCsv;
        setFeedback(`Generated ${payload.codes?.length || 0} code(s). Export the CSV now.`, "success");
        await loadAdmin();
      } catch (error) {
        setFeedback(formatApiError(error), "error");
      } finally {
        reset();
      }
    });

    sharedForm?.addEventListener("submit", async e => {
      e.preventDefault();
      if (!token()) {
        setFeedback("Enter the admin token first.", "error");
        tokenInput?.focus();
        return;
      }

      const submit = sharedForm.querySelector("button[type='submit']");
      const reset = setBusyButton(submit, true, "SAVING");
      try {
        rememberToken();
        const data = new FormData(sharedForm);
        await apiJson("/api/admin/codes/shared", {
          method: "POST",
          headers: adminHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({
            code: data.get("code"),
            modFileId: data.get("modFileId"),
            inventoryItemSlug: data.get("inventoryItemSlug"),
            notes: data.get("notes"),
            active: data.get("active") === "on",
          }),
        });
        setFeedback("Shared code saved.", "success");
        await loadAdmin();
      } catch (error) {
        setFeedback(formatApiError(error), "error");
      } finally {
        reset();
      }
    });

    disableForm?.addEventListener("submit", async e => {
      e.preventDefault();
      if (!token()) {
        setFeedback("Enter the admin token first.", "error");
        tokenInput?.focus();
        return;
      }

      const submit = disableForm.querySelector("button[type='submit']");
      const reset = setBusyButton(submit, true, "DISABLING");
      try {
        rememberToken();
        const data = new FormData(disableForm);
        await apiJson("/api/admin/codes/disable", {
          method: "POST",
          headers: adminHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({
            codeId: data.get("codeId"),
            batchId: data.get("batchId"),
          }),
        });
        disableForm.reset();
        setFeedback("Code status updated.", "success");
        await loadAdmin();
      } catch (error) {
        setFeedback(formatApiError(error), "error");
      } finally {
        reset();
      }
    });

    downloadCsvBtn?.addEventListener("click", () => {
      if (!latestCsv) return;
      const blob = new Blob([latestCsv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `merchlock-redeem-codes-${Date.now()}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    });

    if (token()) loadAdmin();
  }


  /* ============ Init ============ */
  document.addEventListener("DOMContentLoaded", () => {
    renderNewsStrip();
    updateCartCount();
    renderVoteGrid();
    renderVoteStatus();
    if (document.querySelector("[data-vote-countdown]")) {
      window.setInterval(() => {
        const wasOpen = !document.querySelector(".vote-btn[disabled]");
        renderVoteStatus();
        if (wasOpen !== voteIsOpen()) renderVoteGrid();
      }, 60000);
    }
    wireGallery();
    wireNewsletter();
    wireEmailModal();
    wireArtistCall();
    wireNotifyDrop();
    wireSteamAuth();
    wireBuyNow();
    wireWishlist();
    wireSmoothScroll();
    renderCart();
    renderCheckoutSummary();
    wireShipOptions();
    wirePlaceOrder();
    wireRedeemPage();
    wireAdminRedeem();
    renderInventoryPage();
  });
})();
