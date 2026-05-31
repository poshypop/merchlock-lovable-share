(function () {
  const CART_KEY = "merchlock_cart_v1";
  const VOTE_KEY = "merchlock_vote_v1";
  const WISHLIST_KEY = "merchlock_wishlist_v1";
  const DISPATCH_KEY = "merchlock_dispatch_v1";
  const ARTIST_CALL_KEY = "merchlock_artist_call_v1";
  const CHECKOUT_PAYMENT_ENABLED = false;
  const DROP_STATUS = "preorder";
  const VOTE_CLOSE_AT = new Date("2026-05-05T23:59:00-04:00").getTime();

  const PRODUCT_CATALOG = {
    REM: {
      sku: "REM",
      name: "Rem Plushie",
      price: 49,
      artist: "@daichance",
      ships: "May 2026",
      shopifyVariantId: "gid://shopify/ProductVariant/53625624002859",
    },
  };

  /* ============ Shopify Storefront API ============ */
  const SHOPIFY_API_VERSION = "2025-07";
  const SHOPIFY_STORE_PERMANENT_DOMAIN = "perfect-pixel-project-i3n6p.myshopify.com";
  const SHOPIFY_STOREFRONT_URL = `https://${SHOPIFY_STORE_PERMANENT_DOMAIN}/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const SHOPIFY_STOREFRONT_TOKEN = "4b06363f9a7e41aea066d4466000e6fa";

  async function storefrontApiRequest(query, variables) {
    const res = await fetch(SHOPIFY_STOREFRONT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": SHOPIFY_STOREFRONT_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error("Shopify HTTP " + res.status);
    const json = await res.json();
    if (json.errors) throw new Error(json.errors.map(e => e.message).join(", "));
    return json;
  }

  function formatCheckoutUrl(url) {
    try {
      const u = new URL(url);
      u.searchParams.set("channel", "online_store");
      return u.toString();
    } catch { return url; }
  }

  async function createShopifyCheckout(cart) {
    const lines = cart
      .map(it => {
        const p = PRODUCT_CATALOG[it.sku];
        return p && p.shopifyVariantId
          ? { quantity: it.qty, merchandiseId: p.shopifyVariantId }
          : null;
      })
      .filter(Boolean);
    if (!lines.length) throw new Error("No purchasable items in cart.");
    const mutation = `mutation cartCreate($input: CartInput!) {
      cartCreate(input: $input) {
        cart { id checkoutUrl }
        userErrors { field message }
      }
    }`;
    const data = await storefrontApiRequest(mutation, { input: { lines } });
    const errs = data?.data?.cartCreate?.userErrors || [];
    if (errs.length) throw new Error(errs.map(e => e.message).join(", "));
    const checkoutUrl = data?.data?.cartCreate?.cart?.checkoutUrl;
    if (!checkoutUrl) throw new Error("Shopify did not return a checkout URL.");
    return formatCheckoutUrl(checkoutUrl);
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
    "first drop · rem plushie · preorder open",
    "ships may 2026 worldwide",
    "vote on the next plushie · 5 heroes",
    "20% royalty to artist on every unit",
    "designed by @daichance · the catlock guy",
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
      royalty: subtotal * 0.2,
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
      const saved = readJson(DISPATCH_KEY, []);
      if (!saved.includes(email)) saved.push(email);
      writeJson(DISPATCH_KEY, saved);
      if (feedback) feedback.textContent = "◈ saved on this device · email backend not connected";
      input.value = "";
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

  /* ============ Preorder / wishlist ============ */
  function wirePreorder() {
    const btn = document.querySelector("[data-preorder]");
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
            <span class="pb"></span><span class="pt">SHOP THE DROP</span>
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
    const artist = cart[0]?.artist || "@daichance";

    summary.innerHTML = `
      <div class="summary-card">
        <div class="head">ORDER SUMMARY</div>
        <div class="line"><span class="label">Subtotal</span><span class="val">${formatMoney(totals.subtotal)}</span></div>
        <div class="line"><span class="label">Shipping</span><span class="val">${totals.shipping === 0 ? "FREE" : formatMoney(totals.shipping)}</span></div>
        <div class="line"><span class="label">Estimated tax</span><span class="val">${formatMoney(totals.tax)}</span></div>
        <div class="grand"><span class="label">Total</span><span class="val">${formatMoney(totals.total)}</span></div>
        <div class="royalty-mini">
          <div class="lab">◈ ARTIST ROYALTY</div>
          <p>~${formatMoney(totals.royalty)} of this order goes directly to <a href="index.html#artist">${artist}</a>.</p>
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
          <div class="lab">◈ ${formatMoney(totals.royalty)} TO @daichance</div>
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
    wireArtistCall();
    wireNotifyDrop();
    wirePreorder();
    wireWishlist();
    wireSmoothScroll();
    renderCart();
    renderCheckoutSummary();
    wireShipOptions();
    wirePlaceOrder();
  });
})();
