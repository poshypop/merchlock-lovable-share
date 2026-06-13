import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

type JsonRecord = Record<string, unknown>;

type AppConfig = {
  supabaseUrl: string;
  serviceRoleKey: string;
  adminToken: string;
  codeHashSecret: string;
  sessionSecret: string;
  publicSiteUrl: string;
  steamWebApiKey: string;
  shopifyWebhookSecret: string;
  shopifyStorePermanentDomain: string;
  shopifyStorefrontToken: string;
  shopifyApiVersion: string;
  remVariantId: string;
};

type ConfigKey = keyof AppConfig;

type SessionUser = {
  id: string;
  sessionId: string;
  steamId: string;
  personaName: string;
  avatarUrl: string;
  profileUrl: string;
};

const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";
const SESSION_COOKIE = "ml_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const DEFAULT_SHOPIFY_API_VERSION = "2025-07";
const INVENTORY_ITEMS = {
  remPlushie: "rem_plushie",
  remBagSkin: "rem_bag_skin",
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

function readEnv(env: unknown, key: string): string | undefined {
  const requestEnv =
    env && typeof env === "object" ? (env as Record<string, string | undefined>)[key] : undefined;
  const processEnv =
    typeof globalThis === "object" && "process" in globalThis
      ? (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env
      : undefined;
  return requestEnv ?? processEnv?.[key];
}

function getConfig(env: unknown, request?: Request): AppConfig {
  const requestOrigin = request ? new URL(request.url).origin : "";
  return {
    supabaseUrl: (readEnv(env, "SUPABASE_URL") || "").replace(/\/+$/, ""),
    serviceRoleKey: readEnv(env, "SUPABASE_SERVICE_ROLE_KEY") || "",
    adminToken: readEnv(env, "REDEEM_ADMIN_TOKEN") || "",
    codeHashSecret: readEnv(env, "REDEEM_CODE_HASH_SECRET") || "",
    sessionSecret: readEnv(env, "SESSION_SECRET") || "",
    publicSiteUrl: (readEnv(env, "PUBLIC_SITE_URL") || requestOrigin).replace(/\/+$/, ""),
    steamWebApiKey: readEnv(env, "STEAM_WEB_API_KEY") || "",
    shopifyWebhookSecret: readEnv(env, "SHOPIFY_WEBHOOK_SECRET") || "",
    shopifyStorePermanentDomain: readEnv(env, "SHOPIFY_STORE_PERMANENT_DOMAIN") || "",
    shopifyStorefrontToken: readEnv(env, "SHOPIFY_STOREFRONT_TOKEN") || "",
    shopifyApiVersion: readEnv(env, "SHOPIFY_API_VERSION") || DEFAULT_SHOPIFY_API_VERSION,
    remVariantId: (readEnv(env, "SHOPIFY_REM_VARIANT_ID") || "").trim(),
  };
}

function requireConfig(config: AppConfig, keys: ConfigKey[], label: string): Response | undefined {
  const missing = keys.filter((key) => !config[key]);
  if (!missing.length) return undefined;
  return jsonResponse(
    {
      ok: false,
      error: `${label} backend is not configured.`,
      missing: missing.map((key) => envNameForKey(key)),
    },
    503,
  );
}

function envNameForKey(key: ConfigKey): string {
  const names: Record<ConfigKey, string> = {
    supabaseUrl: "SUPABASE_URL",
    serviceRoleKey: "SUPABASE_SERVICE_ROLE_KEY",
    adminToken: "REDEEM_ADMIN_TOKEN",
    codeHashSecret: "REDEEM_CODE_HASH_SECRET",
    sessionSecret: "SESSION_SECRET",
    publicSiteUrl: "PUBLIC_SITE_URL",
    steamWebApiKey: "STEAM_WEB_API_KEY",
    shopifyWebhookSecret: "SHOPIFY_WEBHOOK_SECRET",
    shopifyStorePermanentDomain: "SHOPIFY_STORE_PERMANENT_DOMAIN",
    shopifyStorefrontToken: "SHOPIFY_STOREFRONT_TOKEN",
    shopifyApiVersion: "SHOPIFY_API_VERSION",
    remVariantId: "SHOPIFY_REM_VARIANT_ID",
  };
  return names[key];
}

function jsonResponse(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(headers || {}),
    },
  });
}

function redirectResponse(location: string, status = 302, headers?: HeadersInit): Response {
  return new Response(null, {
    status,
    headers: {
      location,
      "cache-control": "no-store",
      ...(headers || {}),
    },
  });
}

async function readJsonBody(request: Request): Promise<JsonRecord> {
  try {
    return (await request.json()) as JsonRecord;
  } catch {
    return {};
  }
}

function getAdminToken(request: Request): string {
  const auth = request.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return request.headers.get("x-admin-token") || "";
}

function requireAdmin(request: Request, config: AppConfig): Response | undefined {
  const configError = requireConfig(
    config,
    ["supabaseUrl", "serviceRoleKey", "adminToken", "codeHashSecret"],
    "Admin",
  );
  if (configError) return configError;
  if (getAdminToken(request) !== config.adminToken) {
    return jsonResponse({ ok: false, error: "Admin token is invalid." }, 401);
  }
  return undefined;
}

function parseCookies(request: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  const raw = request.headers.get("cookie") || "";
  raw.split(";").forEach((part) => {
    const [name, ...value] = part.trim().split("=");
    if (!name) return;
    cookies.set(name, decodeURIComponent(value.join("=") || ""));
  });
  return cookies;
}

function buildCookie(request: Request, name: string, value: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function clearCookie(request: Request, name: string): string {
  return buildCookie(request, name, "", 0);
}

function safeReturnPath(raw: string | null | undefined, fallback = "/inventory.html"): string {
  if (!raw) return fallback;
  try {
    const decoded = decodeURIComponent(raw);
    if (!decoded.startsWith("/") || decoded.startsWith("//")) return fallback;
    if (decoded.startsWith("/api/")) return fallback;
    return decoded;
  } catch {
    return fallback;
  }
}

function cleanCode(raw: unknown): string {
  return String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function cleanSteamId(raw: unknown): string {
  const steamId = String(raw || "").trim();
  return /^\d{16,20}$/.test(steamId) ? steamId : "";
}

function randomCode(prefix = "ML"): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const body = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
  return `${prefix}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const base64 = bytesToBase64(bytes);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacBytes(value: string | Uint8Array, secret: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = typeof value === "string" ? encoder.encode(value) : value;
  const signature = await crypto.subtle.sign("HMAC", key, message);
  return new Uint8Array(signature);
}

async function hmacHex(value: string | Uint8Array, secret: string): Promise<string> {
  return bytesToHex(await hmacBytes(value, secret));
}

async function hmacBase64(value: string | Uint8Array, secret: string): Promise<string> {
  return bytesToBase64(await hmacBytes(value, secret));
}

async function hashRedeemCode(code: string, secret: string): Promise<string> {
  return hmacHex(cleanCode(code), secret);
}

async function hashSessionToken(token: string, secret: string): Promise<string> {
  return hmacHex(token, secret);
}

function timingSafeCompare(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) {
    diff |= (left[i] || 0) ^ (right[i] || 0);
  }
  return diff === 0;
}

function encodeObjectPath(path: string): string {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function safeSlug(value: unknown, fallback = "mod"): string {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function safeFileName(value: unknown): string {
  return (
    String(value || "download.zip")
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "download.zip"
  );
}

function postgrestValue(value: string): string {
  return encodeURIComponent(value);
}

async function supabaseJson(config: AppConfig, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("apikey", config.serviceRoleKey);
  headers.set("authorization", `Bearer ${config.serviceRoleKey}`);
  if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");

  const response = await fetch(`${config.supabaseUrl}${path}`, { ...init, headers });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = payload?.message || payload?.error || `Supabase request failed (${response.status})`;
    throw new Error(message);
  }
  return payload;
}

async function signStorageUrl(config: AppConfig, bucket: string, storagePath: string) {
  const payload = await supabaseJson(
    config,
    `/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodeObjectPath(storagePath)}`,
    {
      method: "POST",
      body: JSON.stringify({ expiresIn: 60 * 60 }),
    },
  );
  const signed = payload?.signedURL || payload?.signedUrl || "";
  return signed.startsWith("http") ? signed : `${config.supabaseUrl}${signed}`;
}

async function uploadStorageObject(config: AppConfig, bucket: string, storagePath: string, file: File) {
  const response = await fetch(
    `${config.supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeObjectPath(storagePath)}`,
    {
      method: "POST",
      headers: {
        apikey: config.serviceRoleKey,
        authorization: `Bearer ${config.serviceRoleKey}`,
        "content-type": file.type || "application/octet-stream",
        "x-upsert": "true",
      },
      body: await file.arrayBuffer(),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Storage upload failed (${response.status})`);
  }
}

async function getSteamProfile(config: AppConfig, steamId: string) {
  if (!config.steamWebApiKey) {
    return {
      personaName: `Steam ${steamId.slice(-4)}`,
      avatarUrl: "",
      profileUrl: `https://steamcommunity.com/profiles/${steamId}`,
    };
  }

  try {
    const url = new URL("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/");
    url.searchParams.set("key", config.steamWebApiKey);
    url.searchParams.set("steamids", steamId);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Steam profile request failed (${response.status})`);
    const payload = await response.json();
    const player = payload?.response?.players?.[0];
    return {
      personaName: player?.personaname || `Steam ${steamId.slice(-4)}`,
      avatarUrl: player?.avatarfull || player?.avatarmedium || player?.avatar || "",
      profileUrl: player?.profileurl || `https://steamcommunity.com/profiles/${steamId}`,
    };
  } catch {
    return {
      personaName: `Steam ${steamId.slice(-4)}`,
      avatarUrl: "",
      profileUrl: `https://steamcommunity.com/profiles/${steamId}`,
    };
  }
}

async function upsertSteamUser(config: AppConfig, steamId: string, profile?: Partial<SessionUser>) {
  const rows = await supabaseJson(config, "/rest/v1/steam_users?on_conflict=steam_id&select=*", {
    method: "POST",
    headers: { prefer: "return=representation,resolution=merge-duplicates" },
    body: JSON.stringify({
      steam_id: steamId,
      persona_name: profile?.personaName || `Steam ${steamId.slice(-4)}`,
      avatar_url: profile?.avatarUrl || "",
      profile_url: profile?.profileUrl || `https://steamcommunity.com/profiles/${steamId}`,
      updated_at: new Date().toISOString(),
    }),
  });
  return rows?.[0] || null;
}

async function createSession(request: Request, config: AppConfig, steamUserId: string) {
  const token = randomToken();
  const sessionHash = await hashSessionToken(token, config.sessionSecret);
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  const rows = await supabaseJson(config, "/rest/v1/user_sessions?select=*", {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({
      session_hash: sessionHash,
      steam_user_id: steamUserId,
      expires_at: expiresAt,
      last_seen_at: new Date().toISOString(),
    }),
  });
  return {
    token,
    session: rows?.[0] || null,
    cookie: buildCookie(request, SESSION_COOKIE, token, SESSION_MAX_AGE_SECONDS),
  };
}

async function getSessionUser(request: Request, config: AppConfig): Promise<SessionUser | null> {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (!token) return null;

  const sessionHash = await hashSessionToken(token, config.sessionSecret);
  const sessions = await supabaseJson(
    config,
    `/rest/v1/user_sessions?session_hash=eq.${postgrestValue(sessionHash)}&select=id,steam_user_id,expires_at&limit=1`,
  );
  const session = sessions?.[0];
  if (!session) return null;

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await supabaseJson(config, `/rest/v1/user_sessions?id=eq.${postgrestValue(session.id)}`, {
      method: "DELETE",
    });
    return null;
  }

  const users = await supabaseJson(
    config,
    `/rest/v1/steam_users?id=eq.${postgrestValue(session.steam_user_id)}&select=*&limit=1`,
  );
  const user = users?.[0];
  if (!user) return null;

  await supabaseJson(config, `/rest/v1/user_sessions?id=eq.${postgrestValue(session.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
  });

  return {
    id: user.id,
    sessionId: session.id,
    steamId: user.steam_id,
    personaName: user.persona_name || `Steam ${String(user.steam_id).slice(-4)}`,
    avatarUrl: user.avatar_url || "",
    profileUrl: user.profile_url || `https://steamcommunity.com/profiles/${user.steam_id}`,
  };
}

async function requireSessionUser(request: Request, config: AppConfig): Promise<SessionUser | Response> {
  const configError = requireConfig(config, ["supabaseUrl", "serviceRoleKey", "sessionSecret"], "Steam session");
  if (configError) return configError;
  const user = await getSessionUser(request, config);
  if (!user) return jsonResponse({ ok: false, error: "Sign in with Steam first." }, 401);
  return user;
}

async function handleSteamStart(request: Request, config: AppConfig) {
  const configError = requireConfig(config, ["publicSiteUrl"], "Steam auth");
  if (configError) return configError;

  const url = new URL(request.url);
  const returnPath = safeReturnPath(url.searchParams.get("return"), "/inventory.html");
  const returnTo = new URL("/api/auth/steam/callback", config.publicSiteUrl);
  returnTo.searchParams.set("return", returnPath);

  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo.toString(),
    "openid.realm": config.publicSiteUrl,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });

  return redirectResponse(`${STEAM_OPENID_ENDPOINT}?${params.toString()}`);
}

async function validateSteamOpenId(callbackUrl: URL) {
  const params = new URLSearchParams(callbackUrl.search);
  params.set("openid.mode", "check_authentication");
  const response = await fetch(STEAM_OPENID_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const text = await response.text();
  if (!response.ok || !text.includes("is_valid:true")) return "";

  const claimed = callbackUrl.searchParams.get("openid.claimed_id") || "";
  const match = claimed.match(/^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{16,20})$/);
  return match?.[1] || "";
}

async function completeSteamLogin(request: Request, config: AppConfig, steamId: string, returnPath: string) {
  const configError = requireConfig(config, ["supabaseUrl", "serviceRoleKey", "sessionSecret"], "Steam session");
  if (configError) return configError;

  const profile = await getSteamProfile(config, steamId);
  const steamUser = await upsertSteamUser(config, steamId, profile);
  if (!steamUser?.id) {
    return jsonResponse({ ok: false, error: "Could not create Steam user." }, 500);
  }

  const session = await createSession(request, config, steamUser.id);
  return redirectResponse(returnPath, 302, { "set-cookie": session.cookie });
}

async function handleSteamCallback(request: Request, config: AppConfig) {
  const url = new URL(request.url);
  const returnPath = safeReturnPath(url.searchParams.get("return"), "/inventory.html");
  const steamId = await validateSteamOpenId(url);
  if (!steamId) {
    return redirectResponse(`/inventory.html?auth=failed`);
  }
  return completeSteamLogin(request, config, steamId, returnPath);
}

async function handleDevSteamLogin(request: Request, env: unknown, config: AppConfig) {
  const url = new URL(request.url);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (!local && readEnv(env, "ALLOW_DEV_STEAM_LOGIN") !== "1") {
    return jsonResponse({ ok: false, error: "Dev Steam login is only available locally." }, 403);
  }
  const steamId = cleanSteamId(url.searchParams.get("steamid")) || "76561198000000000";
  return completeSteamLogin(request, config, steamId, safeReturnPath(url.searchParams.get("return"), "/inventory.html"));
}

async function handleSession(request: Request, config: AppConfig) {
  const configError = requireConfig(config, ["supabaseUrl", "serviceRoleKey", "sessionSecret"], "Steam session");
  if (configError) return configError;
  const user = await getSessionUser(request, config);
  return jsonResponse({ ok: true, user: user ? publicUser(user) : null });
}

async function handleLogout(request: Request, config: AppConfig) {
  const configError = requireConfig(config, ["supabaseUrl", "serviceRoleKey", "sessionSecret"], "Steam session");
  if (configError) return configError;

  const token = parseCookies(request).get(SESSION_COOKIE);
  if (token) {
    const sessionHash = await hashSessionToken(token, config.sessionSecret);
    await supabaseJson(config, `/rest/v1/user_sessions?session_hash=eq.${postgrestValue(sessionHash)}`, {
      method: "DELETE",
    });
  }

  return jsonResponse({ ok: true }, 200, { "set-cookie": clearCookie(request, SESSION_COOKIE) });
}

function publicUser(user: SessionUser) {
  return {
    steamId: user.steamId,
    personaName: user.personaName,
    avatarUrl: user.avatarUrl,
    profileUrl: user.profileUrl,
  };
}

async function grantInventoryItem(
  config: AppConfig,
  steamUserId: string,
  itemSlug: string,
  sourceType: string,
  sourceRef = "",
  metadata: JsonRecord = {},
) {
  const rows = await supabaseJson(config, "/rest/v1/rpc/grant_inventory_item", {
    method: "POST",
    body: JSON.stringify({
      target_steam_user_id: steamUserId,
      target_item_slug: itemSlug,
      target_source_type: sourceType,
      target_source_ref: sourceRef,
      target_metadata: metadata,
    }),
  });
  const grant = Array.isArray(rows) ? rows[0] : rows;
  if (!grant?.inventory_id || !grant?.item_id) {
    throw new Error(`Inventory item not granted: ${itemSlug}`);
  }

  await supabaseJson(config, "/rest/v1/inventory_events", {
    method: "POST",
    body: JSON.stringify({
      steam_user_id: steamUserId,
      item_id: grant.item_id,
      event_type: grant.already_owned ? "already_owned" : "granted",
      source_type: sourceType,
      source_ref: sourceRef,
      metadata: {
        ...metadata,
        editionNumber: grant.edition_number,
        publicUid: grant.public_uid,
      },
    }),
  });

  return {
    item: {
      id: grant.item_id,
      slug: grant.item_slug,
      title: grant.item_title,
      kind: grant.item_kind,
      description: grant.item_description,
      image_path: grant.item_image_path,
      edition_number: grant.edition_number,
      public_uid: grant.public_uid,
    },
    inventoryId: grant.inventory_id,
    editionNumber: grant.edition_number,
    publicUid: grant.public_uid,
    alreadyOwned: Boolean(grant.already_owned),
  };
}

async function handleInventory(request: Request, config: AppConfig) {
  const user = await requireSessionUser(request, config);
  if (user instanceof Response) return user;

  const rows = await supabaseJson(
    config,
    `/rest/v1/user_inventory?steam_user_id=eq.${postgrestValue(user.id)}&select=id,source_type,source_ref,acquired_at,edition_number,public_uid,inventory_items(slug,title,kind,description,image_path)&order=acquired_at.desc`,
  );

  const items = (Array.isArray(rows) ? rows : []).map((row) => ({
    id: row.id,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    acquiredAt: row.acquired_at,
    editionNumber: row.edition_number,
    publicUid: row.public_uid,
    slug: row.inventory_items?.slug,
    title: row.inventory_items?.title,
    kind: row.inventory_items?.kind,
    description: row.inventory_items?.description,
    imagePath: row.inventory_items?.image_path,
  }));

  return jsonResponse({ ok: true, user: publicUser(user), items });
}

function normalizeCheckoutCart(rawCart: unknown) {
  const cart = Array.isArray(rawCart) ? rawCart : [];
  const rem = cart.find((item) => String(item?.sku || "").toUpperCase() === "REM");
  if (!rem) return [];
  const quantity = Math.min(99, Math.max(1, Math.floor(Number(rem?.qty) || 1)));
  return [{ quantity }];
}

function formatCheckoutUrl(url: string) {
  try {
    const checkoutUrl = new URL(url);
    checkoutUrl.searchParams.set("channel", "online_store");
    return checkoutUrl.toString();
  } catch {
    return url;
  }
}

async function handleCreateCheckout(request: Request, config: AppConfig) {
  const shopifyError = requireConfig(
    config,
    ["shopifyStorePermanentDomain", "shopifyStorefrontToken", "remVariantId"],
    "Checkout",
  );
  if (shopifyError) return shopifyError;

  // Steam sign-in is optional at checkout. Signed-in buyers get the digital
  // grant via the orders/paid webhook; guest orders are recorded "unlinked"
  // with no grant. If the session backend isn't configured, treat as guest.
  const sessionError = requireConfig(config, ["supabaseUrl", "serviceRoleKey", "sessionSecret"], "Steam session");
  const sessionUser = sessionError ? null : await getSessionUser(request, config);

  const body = await readJsonBody(request);
  const lines = normalizeCheckoutCart(body.cart).map((line) => ({
    merchandiseId: config.remVariantId,
    quantity: line.quantity,
  }));
  if (!lines.length) return jsonResponse({ ok: false, error: "No purchasable items in cart." }, 400);

  const mutation = `mutation cartCreate($input: CartInput!) {
    cartCreate(input: $input) {
      cart { id checkoutUrl }
      userErrors { field message }
    }
  }`;
  const response = await fetch(
    `https://${config.shopifyStorePermanentDomain}/api/${config.shopifyApiVersion}/graphql.json`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-storefront-access-token": config.shopifyStorefrontToken,
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          input: {
            lines,
            attributes: sessionUser
              ? [
                  { key: "merchlock_steam_id", value: sessionUser.steamId },
                  { key: "merchlock_user_id", value: sessionUser.id },
                  { key: "merchlock_source", value: "merchlock" },
                ]
              : [{ key: "merchlock_source", value: "merchlock" }],
          },
        },
      }),
    },
  );

  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    throw new Error(payload.errors?.map((err: JsonRecord) => err.message).join(", ") || "Checkout failed.");
  }

  const userErrors = payload?.data?.cartCreate?.userErrors || [];
  if (userErrors.length) {
    return jsonResponse({ ok: false, error: userErrors.map((err: JsonRecord) => err.message).join(", ") }, 400);
  }

  const checkoutUrl = payload?.data?.cartCreate?.cart?.checkoutUrl;
  if (!checkoutUrl) return jsonResponse({ ok: false, error: "Checkout service did not return a checkout URL." }, 502);
  return jsonResponse({ ok: true, checkoutUrl: formatCheckoutUrl(checkoutUrl) });
}

async function verifyShopifyWebhook(request: Request, config: AppConfig, rawBody: Uint8Array) {
  const hmac = request.headers.get("x-shopify-hmac-sha256") || "";
  if (!hmac) return false;
  const expected = await hmacBase64(rawBody, config.shopifyWebhookSecret);
  return timingSafeCompare(expected, hmac);
}

function findOrderAttribute(payload: JsonRecord, key: string): string {
  const candidates = [
    payload.note_attributes,
    payload.custom_attributes,
    payload.customAttributes,
    payload.attributes,
    (payload.cart as JsonRecord | undefined)?.attributes,
    (payload.checkout as JsonRecord | undefined)?.attributes,
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const attr of candidate) {
      if (!attr || typeof attr !== "object") continue;
      const record = attr as JsonRecord;
      if (String(record.key || record.name || "").toLowerCase() === key.toLowerCase()) {
        return String(record.value || "");
      }
    }
  }
  return "";
}

function orderContainsRem(payload: JsonRecord, config: AppConfig): boolean {
  const lineItems = Array.isArray(payload.line_items) ? payload.line_items : [];
  const variantTail = config.remVariantId.split("/").pop();
  if (!lineItems.length) return true;
  return lineItems.some((line) => {
    const record = line as JsonRecord;
    const sku = String(record.sku || "").toUpperCase();
    const title = String(record.title || record.name || "").toLowerCase();
    const variantId = String(record.variant_id || record.variantId || "");
    const adminVariantId = String(record.admin_graphql_api_id || "");
    return (
      sku === "REM" ||
      title.includes("rem plush") ||
      (variantTail && variantId === variantTail) ||
      (variantTail && adminVariantId.endsWith(`/${variantTail}`))
    );
  });
}

async function insertShopifyOrderEvent(config: AppConfig, row: JsonRecord) {
  await supabaseJson(config, "/rest/v1/shopify_order_events", {
    method: "POST",
    body: JSON.stringify(row),
  });
}

async function handleShopifyPaidWebhook(request: Request, config: AppConfig) {
  const configError = requireConfig(
    config,
    ["supabaseUrl", "serviceRoleKey", "shopifyWebhookSecret"],
    "Shopify webhook",
  );
  if (configError) return configError;

  const rawBodyBytes = new Uint8Array(await request.arrayBuffer());
  if (!(await verifyShopifyWebhook(request, config, rawBodyBytes))) {
    return jsonResponse({ ok: false, error: "Webhook signature is invalid." }, 401);
  }

  // Defense in depth: the HMAC already proves authenticity, but rejecting a
  // mismatched shop domain catches a webhook pointed at the wrong store and
  // keeps a single endpoint from granting inventory for an unrelated shop.
  const shopDomain = (request.headers.get("x-shopify-shop-domain") || "").toLowerCase();
  if (
    config.shopifyStorePermanentDomain &&
    shopDomain &&
    shopDomain !== config.shopifyStorePermanentDomain.toLowerCase()
  ) {
    return jsonResponse({ ok: true, status: "ignored_wrong_shop" });
  }

  const rawBody = new TextDecoder().decode(rawBodyBytes);

  const webhookId = request.headers.get("x-shopify-webhook-id") || request.headers.get("webhook-id") || "";
  const eventId = request.headers.get("x-shopify-event-id") || "";
  const dedupeId = webhookId || eventId;
  if (dedupeId) {
    const existing = await supabaseJson(
      config,
      `/rest/v1/shopify_order_events?webhook_id=eq.${postgrestValue(dedupeId)}&select=id&limit=1`,
    );
    if (existing?.[0]) return jsonResponse({ ok: true, duplicate: true });
  }

  const payload = JSON.parse(rawBody) as JsonRecord;
  const orderId = String(payload.admin_graphql_api_id || payload.id || "");
  const steamId = cleanSteamId(findOrderAttribute(payload, "merchlock_steam_id"));
  const containsRem = orderContainsRem(payload, config);

  const eventBase = {
    webhook_id: dedupeId || crypto.randomUUID(),
    event_id: eventId,
    order_id: orderId,
    steam_id: steamId || null,
    payload,
  };

  if (!containsRem) {
    await insertShopifyOrderEvent(config, { ...eventBase, status: "ignored_non_rem" });
    return jsonResponse({ ok: true, status: "ignored_non_rem" });
  }

  if (!steamId) {
    await insertShopifyOrderEvent(config, { ...eventBase, status: "unlinked" });
    return jsonResponse({ ok: true, status: "unlinked" });
  }

  const profile = await getSteamProfile(config, steamId);
  const user = await upsertSteamUser(config, steamId, profile);
  if (!user?.id) throw new Error("Could not upsert Steam user for paid order.");
  const grant = await grantInventoryItem(config, user.id, INVENTORY_ITEMS.remPlushie, "shopify_order", orderId, {
    webhookId: dedupeId,
  });
  await insertShopifyOrderEvent(config, {
    ...eventBase,
    status: grant.alreadyOwned ? "already_granted" : "granted",
    inventory_item_slug: INVENTORY_ITEMS.remPlushie,
  });

  return jsonResponse({ ok: true, status: grant.alreadyOwned ? "already_granted" : "granted" });
}

async function insertRedeemEvent(
  config: AppConfig,
  codeId: string | null,
  modFileId: string | null,
  eventType: string,
  reason: string,
  request: Request,
  steamUserId?: string,
) {
  await supabaseJson(config, "/rest/v1/redeem_events", {
    method: "POST",
    body: JSON.stringify({
      code_id: codeId,
      mod_file_id: modFileId,
      steam_user_id: steamUserId || null,
      event_type: eventType,
      reason,
      user_agent: request.headers.get("user-agent") || "",
    }),
  });
}

async function getRedeemCode(config: AppConfig, codeHash: string) {
  const rows = await supabaseJson(
    config,
    `/rest/v1/redeem_codes?code_hash=eq.${postgrestValue(codeHash)}&select=*&limit=1`,
  );
  return rows?.[0] || null;
}

async function getModFile(config: AppConfig, modFileId: string) {
  const rows = await supabaseJson(
    config,
    `/rest/v1/mod_files?id=eq.${postgrestValue(modFileId)}&select=*&limit=1`,
  );
  return rows?.[0] || null;
}

async function handleRedeem(request: Request, config: AppConfig) {
  const configError = requireConfig(config, ["supabaseUrl", "serviceRoleKey", "codeHashSecret"], "Redeem");
  if (configError) return configError;

  const body = await readJsonBody(request);
  const code = cleanCode(body.code);
  if (!code || code.length < 8) {
    return jsonResponse({ ok: false, error: "Enter a valid code." }, 400);
  }

  const codeRow = await getRedeemCode(config, await hashRedeemCode(code, config.codeHashSecret));
  if (!codeRow) {
    await insertRedeemEvent(config, null, null, "failed", "Code is invalid.", request);
    return jsonResponse({ ok: false, error: "Code is invalid." }, 400);
  }

  if (codeRow.status === "disabled") {
    await insertRedeemEvent(config, codeRow.id, codeRow.mod_file_id, "failed", "Code is disabled.", request);
    return jsonResponse({ ok: false, error: "Code is disabled." }, 400);
  }

  const modFile = await getModFile(config, codeRow.mod_file_id);
  if (!modFile?.active) {
    await insertRedeemEvent(config, codeRow.id, codeRow.mod_file_id, "failed", "Download is not available yet.", request);
    return jsonResponse({ ok: false, error: "Download is not available yet." }, 400);
  }

  const codeType = codeRow.code_type || "one_time_download";
  let alreadyRedeemed = false;
  let inventoryGrant = null;
  let user: SessionUser | null = null;

  if (codeType === "shared_reward_download") {
    const sessionUser = await requireSessionUser(request, config);
    if (sessionUser instanceof Response) return sessionUser;
    user = sessionUser;

    const existingClaims = await supabaseJson(
      config,
      `/rest/v1/redeem_code_claims?code_id=eq.${postgrestValue(codeRow.id)}&steam_user_id=eq.${postgrestValue(user.id)}&select=*&limit=1`,
    );
    alreadyRedeemed = Boolean(existingClaims?.[0]);

    if (!alreadyRedeemed) {
      await supabaseJson(config, "/rest/v1/redeem_code_claims", {
        method: "POST",
        body: JSON.stringify({
          code_id: codeRow.id,
          steam_user_id: user.id,
          status: "redeemed",
          user_agent: request.headers.get("user-agent") || "",
        }),
      });

      await supabaseJson(config, `/rest/v1/redeem_codes?id=eq.${postgrestValue(codeRow.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ shared_uses: Number(codeRow.shared_uses || 0) + 1 }),
      });
    }

    const itemSlug = codeRow.inventory_item_slug || INVENTORY_ITEMS.remBagSkin;
    inventoryGrant = await grantInventoryItem(
      config,
      user.id,
      itemSlug,
      "shared_redeem_code",
      codeRow.id,
      { codePrefix: codeRow.code_prefix, codeSuffix: codeRow.code_suffix },
    );
    await insertRedeemEvent(
      config,
      codeRow.id,
      codeRow.mod_file_id,
      alreadyRedeemed ? "already_redeemed" : "redeemed",
      alreadyRedeemed ? "Shared code already claimed by this Steam account." : "Shared code redeemed.",
      request,
      user.id,
    );
  } else {
    if (codeRow.status === "redeemed") {
      await insertRedeemEvent(config, codeRow.id, codeRow.mod_file_id, "failed", "Code was already redeemed.", request);
      return jsonResponse({ ok: false, error: "Code was already redeemed." }, 400);
    }

    await supabaseJson(config, `/rest/v1/redeem_codes?id=eq.${postgrestValue(codeRow.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "redeemed",
        redeemed_at: new Date().toISOString(),
      }),
    });
    await insertRedeemEvent(config, codeRow.id, codeRow.mod_file_id, "redeemed", "Code redeemed.", request);
  }

  const downloadUrl = await signStorageUrl(config, modFile.storage_bucket, modFile.storage_path);
  return jsonResponse({
    ok: true,
    title: modFile.title,
    description: modFile.description,
    fileName: modFile.file_name,
    downloadUrl,
    expiresInSeconds: 60 * 60,
    codeType,
    alreadyRedeemed,
    alreadyInInventory: Boolean(inventoryGrant?.alreadyOwned),
    inventoryItem: inventoryGrant?.item
      ? {
          slug: inventoryGrant.item.slug,
          title: inventoryGrant.item.title,
          kind: inventoryGrant.item.kind,
          description: inventoryGrant.item.description,
        }
      : null,
    user: user ? publicUser(user) : null,
  });
}

async function handleAdminCreateMod(request: Request, config: AppConfig) {
  const contentType = request.headers.get("content-type") || "";
  let title = "";
  let slug = "";
  let description = "";
  let bucket = "redeem-mods";
  let storagePath = "";
  let fileName = "";
  let fileType = "application/octet-stream";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    title = String(form.get("title") || "").trim();
    slug = safeSlug(form.get("slug"), safeSlug(title, "mod"));
    description = String(form.get("description") || "").trim();
    bucket = String(form.get("bucket") || "redeem-mods").trim() || "redeem-mods";
    storagePath = String(form.get("storagePath") || "").trim();
    const file = form.get("file");

    if (file instanceof File && file.size > 0) {
      fileName = safeFileName(file.name);
      fileType = file.type || "application/octet-stream";
      storagePath = `mods/${slug}/${Date.now()}-${fileName}`;
      await uploadStorageObject(config, bucket, storagePath, file);
    }
  } else {
    const body = await readJsonBody(request);
    title = String(body.title || "").trim();
    slug = safeSlug(body.slug, safeSlug(title, "mod"));
    description = String(body.description || "").trim();
    bucket = String(body.bucket || "redeem-mods").trim() || "redeem-mods";
    storagePath = String(body.storagePath || "").trim();
    fileName = safeFileName(body.fileName || storagePath.split("/").pop());
    fileType = String(body.contentType || "application/octet-stream");
  }

  if (!title || !storagePath) {
    return jsonResponse({ ok: false, error: "Add a title and either a file or private storage path." }, 400);
  }

  const inserted = await supabaseJson(config, "/rest/v1/mod_files?select=*", {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({
      title,
      slug,
      description,
      storage_bucket: bucket,
      storage_path: storagePath,
      file_name: fileName || safeFileName(storagePath.split("/").pop()),
      content_type: fileType,
      active: true,
    }),
  });

  return jsonResponse({ ok: true, mod: inserted?.[0] || null });
}

async function handleAdminGenerateCodes(request: Request, config: AppConfig) {
  const body = await readJsonBody(request);
  const modFileId = String(body.modFileId || "").trim();
  const quantity = Math.min(500, Math.max(1, Number(body.quantity) || 1));
  const prefix = safeSlug(body.prefix || "ML", "ML").toUpperCase().slice(0, 10);
  const notes = String(body.notes || "").trim();
  const batchId = crypto.randomUUID();

  if (!modFileId) {
    return jsonResponse({ ok: false, error: "Choose a mod file first." }, 400);
  }

  const codes = Array.from({ length: quantity }, () => randomCode(prefix));
  const rows = await Promise.all(
    codes.map(async (code) => ({
      batch_id: batchId,
      mod_file_id: modFileId,
      code_hash: await hashRedeemCode(code, config.codeHashSecret),
      code_prefix: code.slice(0, 7),
      code_suffix: code.slice(-4),
      code_type: "one_time_download",
      status: "active",
      notes,
    })),
  );

  await supabaseJson(config, "/rest/v1/redeem_codes", {
    method: "POST",
    body: JSON.stringify(rows),
  });

  return jsonResponse({
    ok: true,
    batchId,
    codes,
    csv: `code,batch_id,mod_file_id\n${codes.map((code) => `${code},${batchId},${modFileId}`).join("\n")}`,
  });
}

async function handleAdminUpsertSharedCode(request: Request, config: AppConfig) {
  const body = await readJsonBody(request);
  const code = cleanCode(body.code);
  const modFileId = String(body.modFileId || "").trim();
  const inventoryItemSlug = safeSlug(body.inventoryItemSlug || INVENTORY_ITEMS.remBagSkin, INVENTORY_ITEMS.remBagSkin);
  const notes = String(body.notes || "").trim();
  const active = body.active !== false && body.active !== "false";

  if (!code || code.length < 8) return jsonResponse({ ok: false, error: "Add a shared code." }, 400);
  if (!modFileId) return jsonResponse({ ok: false, error: "Choose a mod file." }, 400);
  if (!inventoryItemSlug) return jsonResponse({ ok: false, error: "Choose an inventory reward." }, 400);

  const codeHash = await hashRedeemCode(code, config.codeHashSecret);
  const existing = await getRedeemCode(config, codeHash);
  const row = {
    batch_id: existing?.batch_id || crypto.randomUUID(),
    mod_file_id: modFileId,
    code_hash: codeHash,
    code_prefix: code.slice(0, 7),
    code_suffix: code.slice(-4),
    code_type: "shared_reward_download",
    inventory_item_slug: inventoryItemSlug,
    max_uses_per_user: 1,
    status: active ? "active" : "disabled",
    notes,
    disabled_at: active ? null : new Date().toISOString(),
  };

  const saved = existing?.id
    ? await supabaseJson(config, `/rest/v1/redeem_codes?id=eq.${postgrestValue(existing.id)}&select=*`, {
        method: "PATCH",
        headers: { prefer: "return=representation" },
        body: JSON.stringify(row),
      })
    : await supabaseJson(config, "/rest/v1/redeem_codes?select=*", {
        method: "POST",
        headers: { prefer: "return=representation" },
        body: JSON.stringify(row),
      });

  return jsonResponse({ ok: true, code: saved?.[0] || null });
}

async function handleAdminList(config: AppConfig) {
  const [mods, codes, items, claims] = await Promise.all([
    supabaseJson(config, "/rest/v1/mod_files?select=*&order=created_at.desc"),
    supabaseJson(
      config,
      "/rest/v1/redeem_codes?select=id,batch_id,mod_file_id,code_prefix,code_suffix,code_type,inventory_item_slug,status,created_at,redeemed_at,disabled_at,notes,shared_uses&order=created_at.desc&limit=250",
    ),
    supabaseJson(config, "/rest/v1/inventory_items?select=*&order=title.asc"),
    supabaseJson(config, "/rest/v1/redeem_code_claims?select=code_id&limit=10000"),
  ]);

  const claimCounts = (Array.isArray(claims) ? claims : []).reduce<Record<string, number>>((acc, claim) => {
    const id = String(claim.code_id || "");
    if (id) acc[id] = (acc[id] || 0) + 1;
    return acc;
  }, {});

  return jsonResponse({ ok: true, mods, codes, inventoryItems: items, claimCounts });
}

async function handleAdminDisableCodes(request: Request, config: AppConfig) {
  const body = await readJsonBody(request);
  const codeId = String(body.codeId || "").trim();
  const batchId = String(body.batchId || "").trim();
  const filter = codeId ? `id=eq.${postgrestValue(codeId)}` : `batch_id=eq.${postgrestValue(batchId)}`;
  if (!codeId && !batchId) {
    return jsonResponse({ ok: false, error: "Provide a code ID or batch ID." }, 400);
  }

  const updated = await supabaseJson(config, `/rest/v1/redeem_codes?${filter}&select=*`, {
    method: "PATCH",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({
      status: "disabled",
      disabled_at: new Date().toISOString(),
    }),
  });
  return jsonResponse({ ok: true, updated });
}

function handleAdminShopifyStatus(config: AppConfig): Response {
  const variantId = config.remVariantId;
  const remVariantIdValid = /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variantId);
  const checkoutReady = Boolean(
    config.shopifyStorePermanentDomain && config.shopifyStorefrontToken && remVariantIdValid,
  );
  const webhookReady = Boolean(
    config.supabaseUrl && config.serviceRoleKey && config.shopifyWebhookSecret,
  );
  return jsonResponse({
    ok: true,
    shopify: {
      storeDomain: config.shopifyStorePermanentDomain || null,
      apiVersion: config.shopifyApiVersion,
      remVariantId: variantId || null,
      remVariantIdValid,
      storefrontTokenConfigured: Boolean(config.shopifyStorefrontToken),
      webhookSecretConfigured: Boolean(config.shopifyWebhookSecret),
      checkoutReady,
      webhookReady,
      ordersPaidWebhookPath: "/api/webhooks/shopify/orders-paid",
    },
  });
}

async function handleApiRequest(request: Request, env: unknown): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return undefined;

  const config = getConfig(env, request);

  try {
    if (url.pathname === "/api/auth/steam/start" && request.method === "GET") {
      return await handleSteamStart(request, config);
    }
    if (url.pathname === "/api/auth/steam/callback" && request.method === "GET") {
      return await handleSteamCallback(request, config);
    }
    if (url.pathname === "/api/auth/steam/dev" && request.method === "GET") {
      return await handleDevSteamLogin(request, env, config);
    }
    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      return await handleLogout(request, config);
    }
    if (url.pathname === "/api/session" && request.method === "GET") {
      return await handleSession(request, config);
    }
    if (url.pathname === "/api/inventory" && request.method === "GET") {
      return await handleInventory(request, config);
    }
    if (url.pathname === "/api/checkout/create" && request.method === "POST") {
      return await handleCreateCheckout(request, config);
    }
    if (url.pathname === "/api/webhooks/shopify/orders-paid" && request.method === "POST") {
      return await handleShopifyPaidWebhook(request, config);
    }
    if (url.pathname === "/api/redeem" && request.method === "POST") {
      return await handleRedeem(request, config);
    }

    if (url.pathname.startsWith("/api/admin/")) {
      const adminError = requireAdmin(request, config);
      if (adminError) return adminError;

      if (url.pathname === "/api/admin/mods" && request.method === "POST") {
        return await handleAdminCreateMod(request, config);
      }
      if (url.pathname === "/api/admin/codes/generate" && request.method === "POST") {
        return await handleAdminGenerateCodes(request, config);
      }
      if (url.pathname === "/api/admin/codes/shared" && request.method === "POST") {
        return await handleAdminUpsertSharedCode(request, config);
      }
      if (url.pathname === "/api/admin/codes" && request.method === "GET") {
        return await handleAdminList(config);
      }
      if (url.pathname === "/api/admin/codes/disable" && request.method === "POST") {
        return await handleAdminDisableCodes(request, config);
      }
      if (url.pathname === "/api/admin/shopify/status" && request.method === "GET") {
        return handleAdminShopifyStatus(config);
      }
    }

    return jsonResponse({ ok: false, error: "API route not found." }, 404);
  } catch (error) {
    console.error(error);
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : "Unknown API error." }, 500);
  }
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} - try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!body.includes('"unhandled":true') || !body.includes('"message":"HTTPError"')) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const apiResponse = await handleApiRequest(request, env);
      if (apiResponse) return apiResponse;

      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
