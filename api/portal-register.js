// POST /api/portal-register   (public: the registration form's final "Submit")
// Checks the application, checks that every uploaded file really exists in private storage (and takes its
// type and size from storage, never from the browser), stores it, and the database emails a confirmation.
// Protections: a hidden trap field for bots, a minimum time to fill in the form, per-visitor and
// per-email limits, a body size limit, and strict validation in the database as the final backstop.
const { L, HttpError, publicEndpoint, visitorKey } = require("./_lib/portal.js");
const crypto = require("crypto");

const FRIENDLY = {
  duplicate_application: [409, "We already have an application for this child from this email address. If you need to change something, please contact the academy."],
  invalid_child_name: [400, "Please check the child's name."],
  invalid_child_dob: [400, "Please check the child's date of birth."],
  invalid_programme: [400, "Please choose a programme."],
  invalid_start_date: [400, "Please check the preferred start date."],
  invalid_parents: [400, "Please add one or two parents or guardians."],
  invalid_parent_1: [400, "Please check the first parent's name, phone number and email."],
  invalid_parent_2: [400, "Please check the second parent's name, phone number and email."],
  consents_incomplete: [400, "Please answer yes or no to every consent question."],
  invalid_doctor_phone: [400, "Please check the doctor's phone number."],
  invalid_pickups: [400, "Please check the list of people who may collect your child."],
  invalid_documents: [400, "Please check the documents you uploaded."],
  invalid_file: [400, "One of your uploaded files could not be used. Please upload it again."],
  text_too_long: [400, "One of the answers is too long."],
  bad_request: [400, "Invalid request."],
};

module.exports = publicEndpoint(async ({ req, body, client, env }) => {
  // bots: a field no person can see is filled in
  if (typeof body.website === "string" && body.website.trim() !== "") return { application_no: 0 };
  const started = Number(body.started_at);
  if (!(started > 0) || Date.now() - started < 15000) throw new HttpError(400, "Please take a moment to check your answers, then submit again.", "too_fast");

  const payload = body.application;
  if (!payload || typeof payload !== "object") throw new HttpError(400, "Invalid request.");
  const draft = String(payload.draft_id || "").toLowerCase();
  if (!L.UUID_RE.test(draft)) throw new HttpError(400, "Invalid request.");
  const email = String(payload.parents && payload.parents[0] && payload.parents[0].email || "").trim().toLowerCase();

  const ok1 = await client.call("/rest/v1/rpc/registration_rate_hit", { method: "POST", body: { p_key: visitorKey(req, env, "register"), p_limit: 5 } });
  const ok2 = await client.call("/rest/v1/rpc/registration_rate_hit", { method: "POST", body: { p_key: "email:" + crypto.createHash("sha256").update(email).digest("hex").slice(0, 24), p_limit: 3 } });
  if (ok1 === false || ok2 === false) throw new HttpError(429, "We have received several applications from you already. Please try again later, or contact the academy.", "rate");

  // every file the form mentions must really be there; take its type and size from storage
  const refs = [];
  if (payload.child && payload.child.photo_path) refs.push(payload.child.photo_path);
  for (const p of payload.pickups || []) if (p && p.id_photo_path) refs.push(p.id_photo_path);
  for (const d of payload.documents || []) if (d && d.path) refs.push(d.path);
  const folders = [...new Set(refs.map((r) => String(r).split("/").slice(0, 3).join("/")))];
  if (folders.length > 8) throw new HttpError(400, "Invalid request.");
  const found = {};
  for (const folder of folders) {
    if (!folder.startsWith(`drafts/${draft}/`)) throw new HttpError(400, "One of your uploaded files could not be used. Please upload it again.", "invalid_file");
    const listed = await client.call("/storage/v1/object/list/registrations", { method: "POST", body: { prefix: folder, limit: 50, offset: 0 } });
    for (const o of listed || []) found[`${folder}/${o.name}`] = o.metadata || {};
  }
  for (const r of refs) if (!found[r]) throw new HttpError(400, "One of your uploaded files did not arrive. Please upload it again.", "missing_file");
  const clean = JSON.parse(JSON.stringify(payload));
  clean.documents = (clean.documents || []).map((d) => ({ kind: d.kind, path: d.path, file_name: String(d.file_name || "").slice(0, 200), mime_type: found[d.path].mimetype, size_bytes: found[d.path].size }));

  try {
    const r = await client.call("/rest/v1/rpc/register_application", { method: "POST", body: { p: clean } });
    return { application_no: r && r.application_no };
  } catch (e) {
    const known = FRIENDLY[String(e.message).trim()];
    if (known) throw new HttpError(known[0], known[1], String(e.message).trim());
    throw e;
  }
}, { maxBytes: 60000 });
