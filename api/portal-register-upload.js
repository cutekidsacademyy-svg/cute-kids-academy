// POST /api/portal-register-upload   (public: families filling in the registration form, no login)
// Hands out ONE short-lived upload link for ONE file, so the file goes straight into private storage.
// Nothing is readable by the public: only admin, manager and owner can ever open these files.
// Body: { draft_id, kind, mime_type, size_bytes }
// Protections: allowed types only, 5 MB, a limited number of files per form and per visitor per hour.
const crypto = require("crypto");
const { L, HttpError, publicEndpoint, visitorKey } = require("./_lib/portal.js");

const KINDS = ["child_photo", "pickup_id", "birth_certificate", "vaccination_record", "other"];
const TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "application/pdf": "pdf" };
const MAX = 5 * 1024 * 1024;

module.exports = publicEndpoint(async ({ req, body, client, env }) => {
  const { draft_id: draft, kind, mime_type: mime, size_bytes: size } = body;
  if (!L.UUID_RE.test(String(draft || ""))) throw new HttpError(400, "Invalid request.");
  if (!KINDS.includes(kind)) throw new HttpError(400, "Invalid request.");
  if (!TYPES[mime]) throw new HttpError(400, "Please choose a photo (JPG, PNG, WebP, HEIC) or a PDF.", "bad_type");
  if (!Number.isInteger(size) || size < 1) throw new HttpError(400, "Invalid request.");
  if (size > MAX) throw new HttpError(400, "That file is bigger than 5 MB. Please choose a smaller one.", "too_big");

  const perVisitor = await client.call("/rest/v1/rpc/registration_rate_hit", { method: "POST", body: { p_key: visitorKey(req, env, "upload"), p_limit: 40 } });
  const perForm = await client.call("/rest/v1/rpc/registration_rate_hit", { method: "POST", body: { p_key: "draft:" + String(draft).toLowerCase(), p_limit: 15 } });
  if (perVisitor === false || perForm === false) throw new HttpError(429, "That is a lot of files. Please try again in a little while.", "rate");

  const path = `drafts/${String(draft).toLowerCase()}/${kind}/${crypto.randomUUID()}.${TYPES[mime]}`;
  const signed = await client.call(`/storage/v1/object/upload/sign/registrations/${path}`, { method: "POST", body: {} });
  const token = signed && (signed.token || (signed.url && new URL(signed.url, "http://x").searchParams.get("token")));
  if (!token) throw new HttpError(502, "Could not prepare the upload. Please try again.");
  return { path, token, bucket: "registrations" };
});
