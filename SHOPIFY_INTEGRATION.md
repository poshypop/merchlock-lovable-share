# Shopify integration (headless)

MerchLock stays the storefront. Shopify is the payment processor and the
source of truth for paid orders. There are exactly two integration points:

1. **Checkout** — the cart on the MerchLock site calls
   `POST /api/checkout/create`, which uses the Shopify **Storefront API**
   (`cartCreate`) to build a cart and returns Shopify's hosted `checkoutUrl`.
   The buyer completes payment on Shopify. When the shopper is signed in
   with Steam, the cart is tagged with their Steam identity
   (`merchlock_steam_id`, `merchlock_user_id`); guests check out without
   Steam attributes.
2. **Fulfillment** — when the order is paid, Shopify calls the
   `orders/paid` webhook at `POST /api/webhooks/shopify/orders-paid`. The
   server verifies the HMAC signature, reads the Steam id back off the
   order's `note_attributes`, and grants the **Rem Plushie** to that Steam
   account's MerchLock inventory.

```
 MerchLock cart ──POST /api/checkout/create──▶ Shopify Storefront API (cartCreate)
                                                      │
        buyer ◀── hosted Shopify checkout URL ────────┘
          │ pays
          ▼
 Shopify ──orders/paid webhook──▶ /api/webhooks/shopify/orders-paid
                                          │ verify HMAC + shop domain
                                          │ read merchlock_steam_id
                                          ▼
                                  grant Rem Plushie → Steam inventory
```

Everything below is the one-time setup to turn this on for a real store.

---

## Prerequisites

- A Shopify store you administer (`your-store.myshopify.com`).
- The Rem Plushie created as a **product with a variant** in that store, and
  published to the **Online Store** sales channel.
- This app deployed at a public **HTTPS** URL (Shopify must be able to reach
  the webhook). For local testing, expose it with a tunnel
  (`cloudflared tunnel --url http://127.0.0.1:5174` or `ngrok http 5174`)
  and set `PUBLIC_SITE_URL` to the tunnel URL.

---

## Step 1 — Get the product variant GID

The server only ever sells the variant in `SHOPIFY_REM_VARIANT_ID`, so this
must be a real variant in **your** store (the client never picks the variant,
which prevents tampering with the checkout).

- Admin → **Products** → open the Rem product → click the variant. The URL
  ends in the numeric id: `.../variants/1234567890`.
- The GID is that number wrapped as
  `gid://shopify/ProductVariant/1234567890`.

Set it as `SHOPIFY_REM_VARIANT_ID`.

> The hardcoded `shopifyVariantId` in `public/js/main.js` is cosmetic only —
> the server is authoritative. You can leave it or update it to match.

---

## Step 2 — Create a Storefront API access token

Admin → **Settings → Apps and sales channels → Develop apps** →
**Create an app** (e.g. "MerchLock Headless").

1. **Configuration → Storefront API** → enable these scopes:
   - `unauthenticated_read_product_listings`
   - `unauthenticated_write_checkouts`
   - `unauthenticated_read_checkouts`
2. **Install app**.
3. **API credentials** → copy the **Storefront API access token**.

Set it as `SHOPIFY_STOREFRONT_TOKEN`. Set `SHOPIFY_STORE_PERMANENT_DOMAIN`
to `your-store.myshopify.com` (the permanent `*.myshopify.com` domain, not a
custom domain).

---

## Step 3 — Register the `orders/paid` webhook

**Option A — Notifications page (simplest, single store):**

Admin → **Settings → Notifications → Webhooks → Create webhook**:

- Event: **Order payment** (this is the `orders/paid` topic)
- Format: **JSON**
- URL: `https://YOUR-PUBLIC-SITE/api/webhooks/shopify/orders-paid`
- API version: match `SHOPIFY_API_VERSION` (default `2025-07`)

At the bottom of the Webhooks page Shopify shows a line like *"All your
webhooks will be signed with `xxxx…`"*. **That** value is the HMAC signing
secret — set it as `SHOPIFY_WEBHOOK_SECRET`.

**Option B — Custom app webhook:** subscribe to `orders/paid` from the same
custom app (via the Admin API `webhookSubscriptionCreate` or app config). In
that case the webhook is signed with the **app's API secret key**, so use
that as `SHOPIFY_WEBHOOK_SECRET`.

> The secret must be the exact one Shopify uses to sign the request body —
> a wrong secret produces `401 Webhook signature is invalid`.

---

## Step 4 — Set environment variables

From `.env.example`:

```
PUBLIC_SITE_URL=https://your-public-site
SHOPIFY_STORE_PERMANENT_DOMAIN=your-store.myshopify.com
SHOPIFY_STOREFRONT_TOKEN=<storefront api access token>
SHOPIFY_WEBHOOK_SECRET=<orders/paid signing secret>
SHOPIFY_API_VERSION=2025-07
SHOPIFY_REM_VARIANT_ID=gid://shopify/ProductVariant/1234567890
```

The fulfillment webhook also needs Supabase + Steam config to be set
(`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`) so it can look
up the Steam user and write inventory.

---

## Step 5 — Verify the wiring

**Config check** (no secrets are returned). Uses the existing admin token:

```bash
curl -s https://YOUR-SITE/api/admin/shopify/status \
  -H "Authorization: Bearer $REDEEM_ADMIN_TOKEN" | jq
```

You want `checkoutReady: true` and `webhookReady: true`.

**Checkout check:** on the MerchLock site, add the Rem plushie and click
**SECURE CHECKOUT** (signed in, or via "Continue as guest"). A real Shopify
checkout URL should open. If you get *"Checkout backend is not configured"*,
the named env var is missing.

**Webhook check:** on the Notifications page use **Send test notification**.
The sample order has no Steam id, so it is recorded in `shopify_order_events`
with `status: "unlinked"` — that's the expected result and confirms the
endpoint + HMAC are correct. A real signed‑in purchase records `granted`.

---

## How the Steam ↔ order link works

Steam sign-in is **optional** at checkout: the cart/checkout UI offers
"Sign in with Steam" (to receive the digital item) or "Continue as guest".
For signed-in shoppers, `cartCreate` attaches `merchlock_steam_id` as a cart
attribute, which Shopify carries onto the paid order as a `note_attribute`.
The webhook reads it back and grants the plushie.

Guest orders carry only `merchlock_source` — they land in
`shopify_order_events` with `status: "unlinked"` and `steam_id: null`, and
no inventory is granted, **by design**. You can reconcile one manually from
`shopify_order_events` if a guest buyer later asks for the digital item.

---

## White-label: hide Shopify from buyers

The site's own copy is Shopify-free (buttons say **SECURE CHECKOUT**). The
payment page itself is Shopify-hosted, but you can make it carry your brand
and your domain so buyers never see "myshopify.com":

1. **Custom checkout domain** (the big one). In Shopify admin:
   **Settings → Domains → Connect existing domain** → enter a subdomain of
   your site, e.g. `shop.your-domain.com`. At your DNS host add a CNAME:
   `shop` → `shops.myshopify.com`. Verify in Shopify, wait for the TLS cert,
   then click **Set as primary**. From that moment `cartCreate` returns
   checkout URLs on `shop.your-domain.com` — no code changes needed (the
   server passes Shopify's `checkoutUrl` straight through).
2. **Keep the env var on the permanent domain.**
   `SHOPIFY_STORE_PERMANENT_DOMAIN` must STAY `<store>.myshopify.com` even
   after the custom domain is primary — the Storefront API endpoint and the
   webhook's `x-shopify-shop-domain` check both use the permanent domain.
3. **Checkout appearance.** **Settings → Checkout → Customize** opens the
   checkout editor: upload the MerchLock logo, set background/button colors to
   the site palette, pick a matching font. **Settings → Brand** holds the
   shared brand assets Shopify reuses across checkout and emails.
4. **Order emails.** **Settings → Notifications**: customize the Order
   confirmation / Shipping confirmation templates with your logo, and set the
   **sender email** to an address on your domain (complete the SPF/DKIM
   domain-verification steps Shopify shows so mail doesn't say "via
   shopifyemail.com").
5. **Reduce remaining tells (optional).** Shop Pay is the most visibly
   Shopify-branded element at payment; you can turn it off under
   **Settings → Payments → Shopify Payments → Manage**. Honest limit: the
   hosted checkout's fine print and card statements may still reference
   Shopify; a fully custom checkout requires Shopify Plus.

---

## Troubleshooting

Inspect the `shopify_order_events` table — every webhook call is logged with a
`status`:

| Symptom / status | Cause | Fix |
| --- | --- | --- |
| `401 Webhook signature is invalid` | `SHOPIFY_WEBHOOK_SECRET` ≠ Shopify's signing secret, or a proxy altered the raw body | Copy the exact secret (Step 3); ensure nothing rewrites the request body before this server |
| Checkout error: *backend is not configured* | A required env var is unset | Set the var named in the `missing` list |
| Checkout opens but Shopify shows a line‑item / `userErrors` error | `SHOPIFY_REM_VARIANT_ID` isn't a real variant in this store, or the product isn't on the Online Store channel | Fix the GID (Step 1); publish the product |
| `status: "unlinked"` | Buyer checked out as a guest (or a test notification) | Expected for guest checkouts and test notifications; reconcile manually if the buyer wanted the digital item |
| `status: "ignored_non_rem"` | Order line items didn't match the Rem variant/SKU/title | Confirm the purchased variant matches `SHOPIFY_REM_VARIANT_ID` |
| `status: "ignored_wrong_shop"` | `x-shopify-shop-domain` ≠ `SHOPIFY_STORE_PERMANENT_DOMAIN` | Point the webhook at the correct store / fix the domain env |
| `503` from the webhook | Supabase or webhook secret not configured | Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SHOPIFY_WEBHOOK_SECRET` |

---

## Endpoint reference

| Method & path | Purpose | Auth |
| --- | --- | --- |
| `POST /api/checkout/create` | Create a Shopify cart, return `checkoutUrl` | Optional Steam session cookie (guests allowed) |
| `POST /api/webhooks/shopify/orders-paid` | Grant inventory on paid order | Shopify HMAC |
| `GET /api/admin/shopify/status` | Report Shopify config readiness (no secrets) | `REDEEM_ADMIN_TOKEN` |
