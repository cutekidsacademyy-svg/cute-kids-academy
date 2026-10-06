// Shared helpers for the portal's server functions (invite parent, invite staff, switch access).
// These run on Vercel and use the Supabase SERVICE key, which exists only in Vercel's
// environment variables (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY). Files starting with "_"
// are not exposed as web endpoints.
//
// Every request must carry the caller's own login token (Authorization: Bearer ...). We ask
// Supabase who that is, load their profile, and only then decide what they may do.
const crypto = require("crypto");
const L = require("../../js/portal-logic.js");

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

function makeClient(env, fetchImpl) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new HttpError(500, "The portal is not set up yet: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are missing in Vercel.");
  }
  const base = env.SUPABASE_URL.replace(/\/+$/, "");
  const service = env.SUPABASE_SERVICE_ROLE_KEY;

  async function call(path, { method = "GET", body, headers = {}, token = service } = {}) {
    const res = await fetchImpl(base + path, {
      method,
      headers: { apikey: service, Authorization: "Bearer " + token, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok) {
      const msg = (data && (data.msg || data.message || data.error_description || data.error)) || "Request failed";
      throw Object.assign(new HttpError(res.status >= 500 ? 502 : (res.status === 422 || res.status === 409 ? 409 : 400), String(msg)), { upstream: true });   // upstream = text written by Supabase, not by us
    }
    return data;
  }
  return { call };
}

// Who is calling? Returns { id, role, active, full_name } or throws 401 / 403.
async function authenticate(req, client) {
  const header = req.headers && (req.headers.authorization || req.headers.Authorization) || "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) throw new HttpError(401, "Please sign in.");
  let user;
  try { user = await client.call("/auth/v1/user", { token: m[1] }); }
  catch (e) { throw new HttpError(401, "Your session has expired. Please sign in again."); }
  if (!user || !user.id) throw new HttpError(401, "Please sign in.");
  const rows = await client.call(`/rest/v1/profiles?id=eq.${user.id}&select=id,role,active,full_name`);
  const profile = rows && rows[0];
  if (!profile || !profile.active) throw new HttpError(403, "This account is not active.");
  return profile;
}

function origin(req, env) {
  if (env.SITE_URL) return env.SITE_URL.replace(/\/+$/, "");
  const proto = (req.headers && req.headers["x-forwarded-proto"]) || "https";
  return `${proto}://${req.headers.host}`;
}

// Wraps a handler: method check, JSON errors, never leaks stack traces.
function endpoint(handler) {
  return async function (req, res, env = process.env, fetchImpl = globalThis.fetch) {
    const send = (status, body) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method !== "POST") throw new HttpError(405, "Use POST.");
      const client = makeClient(env, fetchImpl);
      const caller = await authenticate(req, client);
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const result = await handler({ req, body, client, caller, env });
      send(200, Object.assign({ ok: true }, result));
    } catch (e) {
      if (e instanceof HttpError) send(e.status, { ok: false, error: e.message });
      else send(500, { ok: false, error: "Something went wrong. Please try again." });
    }
  };
}

// For forms anyone on the internet may use (the registration form): no login, but a strict body size,
// JSON errors only, and no stack traces. Callers must rate-limit with visitorKey().
function publicEndpoint(handler, { maxBytes = 60000 } = {}) {
  return async function (req, res, env = process.env, fetchImpl = globalThis.fetch) {
    const send = (status, body) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method !== "POST") throw new HttpError(405, "Use POST.");
      const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
      if (raw.length > maxBytes) throw new HttpError(413, "That is too much data in one go.");
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      if (body === null || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Invalid request.");
      const client = makeClient(env, fetchImpl);
      const result = await handler({ req, body, client, env });
      send(200, Object.assign({ ok: true }, result));
    } catch (e) {
      if (e instanceof HttpError && !e.upstream) send(e.status, { ok: false, error: e.message, code: e.code });   // only messages WE wrote reach a stranger
      else if (e instanceof SyntaxError) send(400, { ok: false, error: "Invalid request." });
      else send(500, { ok: false, error: "Something went wrong. Please try again." });
    }
  };
}

// A one-way fingerprint of the visitor (so we can count requests without ever storing an IP address).
function visitorKey(req, env, label) {
  const fwd = (req.headers && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"])) || "";
  const ip = String(fwd).split(",")[0].trim() || "unknown";
  return label + ":" + crypto.createHash("sha256").update(ip + "|" + (env.CRON_SECRET || env.SUPABASE_SERVICE_ROLE_KEY || "salt")).digest("hex").slice(0, 32);
}

function cleanText(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max || 200) : "";
}

// Create an invited login + its profile; undo the login if anything after it fails.
async function inviteUser({ client, req, env, email, fullName, phone, language, role, after }) {
  const redirect = encodeURIComponent(origin(req, env) + "/login/?mode=set-password");
  const invited = await client.call(`/auth/v1/invite?redirect_to=${redirect}`, {
    method: "POST",
    body: { email, data: { full_name: fullName, language } },
  });
  const userId = invited && (invited.id || (invited.user && invited.user.id));
  if (!userId) throw new HttpError(502, "The invitation could not be created.");
  try {
    await client.call("/rest/v1/profiles", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: { id: userId, full_name: fullName, phone: phone || null, language, role },
    });
    if (after) await after(userId);
  } catch (e) {
    // Roll back so the email can be invited again.
    try { await client.call(`/rest/v1/profiles?id=eq.${userId}`, { method: "DELETE" }); } catch (_) {}
    try { await client.call(`/auth/v1/admin/users/${userId}`, { method: "DELETE" }); } catch (_) {}
    throw e;
  }
  return userId;
}

module.exports = { L, HttpError, makeClient, authenticate, endpoint, publicEndpoint, visitorKey, cleanText, inviteUser, origin };
