// Tests for the registration server functions (public form uploads and submit, staff approval),
// against a fake Supabase. Run from the project root:  node --test tests/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const upload = require("../api/portal-register-upload.js");
const register = require("../api/portal-register.js");
const approve = require("../api/portal-approve.js");

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DRAFT = ID(900), OTHER = ID(901);
const ENV = { SUPABASE_URL: "https://fake.supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service-key-for-tests", CRON_SECRET: "salt-for-tests", SITE_URL: "https://site.test" };

function world(o = {}) {
  const state = {
    calls: [], rate: {}, files: o.files || {}, registerResult: o.registerResult || { id: ID(1), application_no: 42 }, registerError: o.registerError || null,
    users: o.users || {}, inviteFails: o.inviteFails || [], linked: [], invited: [], approveError: o.approveError || null, getResult: o.getResult,
    approveResult: o.approveResult || { child_id: ID(500), language: "ar", parents: [{ position: 1, full_name: "Mona", phone: "+20 100 111 2222", email: "mona@x.test" }, { position: 2, full_name: "Omar", phone: "+20 100 111 3333", email: "omar@x.test" }] },
    profiles: { [ID(1)]: { id: ID(1), role: "admin", active: true, full_name: "Admin" }, [ID(2)]: { id: ID(2), role: "teacher", active: true, full_name: "Teacher" }, [ID(3)]: { id: ID(3), role: "parent", active: true, full_name: "Parent" } },
    tokens: { "tok-admin": ID(1), "tok-teacher": ID(2), "tok-parent": ID(3) },
  };
  const json = (status, data) => ({ ok: status < 400, status, text: async () => (data === undefined ? "" : JSON.stringify(data)) });
  const fetchImpl = async (url, opts) => {
    const u = new URL(url), body = opts.body ? JSON.parse(opts.body) : undefined, p = u.pathname;
    state.calls.push({ method: opts.method, path: p + u.search, body, auth: opts.headers.Authorization });
    if (p === "/rest/v1/rpc/registration_rate_hit") { const n = (state.rate[body.p_key] = (state.rate[body.p_key] || 0) + 1); return json(200, n <= body.p_limit); }
    if (p.startsWith("/storage/v1/object/upload/sign/registrations/")) return json(200, { url: `/object/upload/sign/registrations/${p.split("/registrations/")[1]}?token=TOKEN123` });
    if (p === "/storage/v1/object/list/registrations") {
      const out = Object.entries(state.files).filter(([k]) => k.startsWith(body.prefix + "/")).map(([k, v]) => ({ name: k.slice(body.prefix.length + 1), metadata: v }));
      return json(200, out);
    }
    if (p === "/rest/v1/rpc/register_application") return state.registerError ? json(400, { message: state.registerError }) : json(200, state.registerResult);
    if (p === "/auth/v1/user") { const id = state.tokens[opts.headers.Authorization.replace("Bearer ", "")]; return id ? json(200, { id }) : json(401, { msg: "bad token" }); }
    if (p === "/rest/v1/profiles" && opts.method === "GET") { const id = u.searchParams.get("id").replace("eq.", ""); return json(200, state.profiles[id] ? [state.profiles[id]] : []); }
    if (p === "/rest/v1/rpc/approve_registration") return state.approveError ? json(400, { message: state.approveError }) : json(200, state.approveResult);
    if (p === "/rest/v1/rpc/registration_get") return state.getResult === undefined ? json(200, { id: body.p_id, status: "approved", child_id: ID(500), language: "en", parents: state.approveResult.parents }) : json(200, state.getResult);
    if (p === "/rest/v1/rpc/find_user_by_email") { const x = state.users[body.p_email]; return json(200, x ? [x] : []); }
    if (p === "/auth/v1/invite") { if (state.inviteFails.includes(body.email)) return json(500, { msg: "Error sending invite email" }); state.invited.push(body.email); return json(200, { id: ID(700 + state.invited.length) }); }
    if (p === "/rest/v1/profiles" && opts.method === "POST") return json(201);
    if (p === "/rest/v1/parent_children") { state.linked.push(body[0]); return json(201); }
    if (p.startsWith("/auth/v1/admin/users/") || (p === "/rest/v1/profiles" && opts.method === "DELETE")) return json(204);
    return json(404, { message: "unexpected " + p });
  };
  return { state, fetchImpl };
}

async function call(handler, { method = "POST", body = {}, headers = {}, w = world() } = {}) {
  const req = { method, headers: { host: "site.test", "x-forwarded-for": "203.0.113.7", ...headers }, body };
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s) { this.payload = JSON.parse(s); } };
  await handler(req, res, ENV, w.fetchImpl);
  return { status: res.statusCode, ...res.payload, w };
}

// ------------------------------ upload links ------------------------------
const up = (o = {}) => ({ draft_id: DRAFT, kind: "birth_certificate", mime_type: "application/pdf", size_bytes: 120000, ...o });

test("upload: only POST, and only sensible requests", async () => {
  assert.equal((await call(upload, { method: "GET" })).status, 405);
  for (const bad of [{ draft_id: "nope" }, { kind: "passwords" }, { mime_type: "application/x-msdownload" }, { mime_type: "text/html" }, { size_bytes: 0 }, { size_bytes: "big" }, { size_bytes: 6 * 1024 * 1024 }]) {
    const w = world();
    const r = await call(upload, { body: up(bad), w });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(w.state.calls.some((c) => c.path.includes("/upload/sign/")), false, "no link is issued for " + JSON.stringify(bad));
  }
});

test("upload: a good request gets a short-lived link into the visitor's own draft folder", async () => {
  const w = world();
  const r = await call(upload, { body: up({ kind: "pickup_id", mime_type: "image/jpeg" }), w });
  assert.equal(r.status, 200);
  assert.match(r.path, new RegExp(`^drafts/${DRAFT}/pickup_id/[0-9a-f-]{36}\\.jpg$`));
  assert.equal(r.token, "TOKEN123");
  const sign = w.state.calls.find((c) => c.path.includes("/upload/sign/"));
  assert.ok(sign.path.includes(r.path));
  assert.match(sign.auth, /service-key-for-tests/);                         // signed by the server, never the browser
  assert.equal(JSON.stringify({ ...r, w: undefined }).includes("service-key-for-tests"), false);
});

test("upload: a form may upload only a limited number of files, and visitors are counted without storing their address", async () => {
  const w = world();
  let last;
  for (let i = 0; i < 16; i++) last = await call(upload, { body: up(), w });
  assert.equal(last.status, 429);
  const keys = Object.keys(w.state.rate);
  assert.ok(keys.some((k) => k.startsWith("upload:")) && keys.some((k) => k.startsWith("draft:")));
  assert.equal(keys.some((k) => k.includes("203.0.113.7")), false, "the IP address itself is never stored");
  const other = await call(upload, { body: up({ draft_id: OTHER }), w });
  assert.equal(other.status, 200, "another form is not blocked");
});

// ------------------------------ submitting ------------------------------
const PRE = `drafts/${DRAFT}/`;
const app = (o = {}) => ({
  draft_id: DRAFT, language: "en", child: { name: "Nour", dob: "2025-02-02", programme: "nursery", photo_path: PRE + "child_photo/c.jpg" },
  parents: [{ full_name: "Mona", phone: "+20 100 111 2222", email: "Mona@X.test", relationship: "mother" }], health: {},
  pickups: [{ full_name: "Aunt", relationship: "aunt", phone: "+20 100 333 4444", id_photo_path: PRE + "pickup_id/p.png" }],
  consents: { photos_class: true, photos_social: false, outings: true, emergency_treatment: true, birthday_wall: false },
  documents: [{ kind: "birth_certificate", path: PRE + "birth_certificate/b.pdf", file_name: "b.pdf", mime_type: "application/pdf", size_bytes: 10 }], ...o });
const FILES = { [PRE + "child_photo/c.jpg"]: { mimetype: "image/jpeg", size: 2000 }, [PRE + "pickup_id/p.png"]: { mimetype: "image/png", size: 3000 }, [PRE + "birth_certificate/b.pdf"]: { mimetype: "application/pdf", size: 4000 } };
const sub = (o = {}) => ({ started_at: Date.now() - 60000, website: "", application: app(), ...o });

test("submit: bots that fill the hidden field get a quiet success and nothing is stored", async () => {
  const w = world({ files: FILES });
  const r = await call(register, { body: sub({ website: "http://spam.test" }), w });
  assert.equal(r.status, 200);
  assert.equal(w.state.calls.some((c) => c.path.includes("register_application")), false);
});

test("submit: too fast is refused, and so is a missing application", async () => {
  assert.equal((await call(register, { body: sub({ started_at: Date.now() - 2000 }), w: world({ files: FILES }) })).status, 400);
  assert.equal((await call(register, { body: sub({ started_at: undefined }), w: world({ files: FILES }) })).status, 400);
  assert.equal((await call(register, { body: { started_at: Date.now() - 60000 }, w: world() })).status, 400);
  assert.equal((await call(register, { method: "GET" })).status, 405);
});

test("submit: a good application is stored; the type and size of every file come from storage, not from the browser", async () => {
  const w = world({ files: FILES });
  const r = await call(register, { body: sub(), w });
  assert.equal(r.status, 200);
  assert.equal(r.application_no, 42);
  const rpc = w.state.calls.find((c) => c.path.includes("register_application"));
  const doc = rpc.body.p.documents[0];
  assert.equal(doc.mime_type, "application/pdf");
  assert.equal(doc.size_bytes, 4000, "the size is storage's 4000, not the browser's claimed 10");
  const liar = await call(register, { body: sub({ application: app({ documents: [{ kind: "birth_certificate", path: PRE + "child_photo/c.jpg", mime_type: "application/pdf", size_bytes: 1 }] }) }), w: world({ files: FILES }) });
  assert.equal(liar.w.state.calls.find((c) => c.path.includes("register_application")).body.p.documents[0].mime_type, "image/jpeg", "a lie about the type is corrected");
});

test("submit: files that never arrived, or belong to someone else's form, are refused", async () => {
  const missing = await call(register, { body: sub(), w: world({ files: { [PRE + "child_photo/c.jpg"]: FILES[PRE + "child_photo/c.jpg"] } }) });
  assert.equal(missing.status, 400);
  assert.equal(missing.code, "missing_file");
  const foreign = await call(register, { body: sub({ application: app({ documents: [{ kind: "other", path: `drafts/${OTHER}/other/x.pdf`, mime_type: "application/pdf", size_bytes: 1 }] }) }), w: world({ files: { ...FILES, [`drafts/${OTHER}/other/x.pdf`]: { mimetype: "application/pdf", size: 1 } } }) });
  assert.equal(foreign.status, 400);
  assert.equal(foreign.w.state.calls.some((c) => c.path.includes("register_application")), false);
});

test("submit: a duplicate gets a friendly message, other database errors never leak", async () => {
  const dup = await call(register, { body: sub(), w: world({ files: FILES, registerError: "duplicate_application" }) });
  assert.equal(dup.status, 409);
  assert.match(dup.error, /already have an application/);
  const bad = await call(register, { body: sub(), w: world({ files: FILES, registerError: "consents_incomplete" }) });
  assert.equal(bad.status, 400);
  assert.match(bad.error, /yes or no/);
  const weird = await call(register, { body: sub(), w: world({ files: FILES, registerError: 'relation "secret_table" does not exist' }) });
  assert.ok(weird.status >= 400);
  assert.equal(/secret_table/.test(JSON.stringify({ ...weird, w: undefined })), false);
});

test("submit: one visitor and one email can only submit a few times an hour; huge bodies are refused", async () => {
  const w = world({ files: FILES });
  let last;
  for (let i = 0; i < 4; i++) last = await call(register, { body: sub(), w });
  assert.equal(last.status, 429);
  const keys = Object.keys(w.state.rate);
  assert.ok(keys.some((k) => k.startsWith("register:")) && keys.some((k) => k.startsWith("email:")));
  assert.equal(keys.some((k) => /203\.0\.113\.7|mona@x\.test/i.test(k)), false, "neither the IP address nor the email is stored in a counter");
  const big = await call(register, { body: sub({ application: app({ health: { allergies: "x".repeat(70000) } }) }), w: world({ files: FILES }) });
  assert.equal(big.status, 413);
});

// ------------------------------ approving ------------------------------
const ap = (o = {}) => ({ application_id: ID(5), class_id: ID(6), ...o });
const as = (token) => ({ authorization: "Bearer " + token });

test("approve: only staff who may invite parents, and it needs a login", async () => {
  assert.equal((await call(approve, { body: ap() })).status, 401);
  assert.equal((await call(approve, { body: ap(), headers: as("tok-parent") })).status, 403);
  assert.equal((await call(approve, { body: ap(), headers: as("tok-teacher") })).status, 403);
  assert.equal((await call(approve, { body: ap({ class_id: "x" }), headers: as("tok-admin") })).status, 400);
});

test("approve: the database approves AS THE CALLER, then both parents are invited and linked to the child", async () => {
  const w = world();
  const r = await call(approve, { body: ap(), headers: as("tok-admin"), w });
  assert.equal(r.status, 200);
  assert.equal(r.child_id, ID(500));
  assert.deepEqual(r.results.map((x) => x.outcome), ["invited", "invited"]);
  const rpc = w.state.calls.find((c) => c.path.includes("approve_registration"));
  assert.equal(rpc.auth, "Bearer tok-admin", "the caller's own login is used, so the database checks the role");
  assert.deepEqual(w.state.invited.sort(), ["mona@x.test", "omar@x.test"]);
  assert.equal(w.state.linked.length, 2);
  assert.ok(w.state.linked.every((l) => l.child_id === ID(500)));
  const invite = w.state.calls.find((c) => c.path.startsWith("/auth/v1/invite"));
  assert.equal(invite.body.data.language, "ar", "the invitation is in the family's language");
});

test("approve: a parent who already has a login is linked to the new child, not invited again", async () => {
  const w = world({ users: { "mona@x.test": { id: ID(88), role: "parent", active: true } } });
  const r = await call(approve, { body: ap(), headers: as("tok-admin"), w });
  assert.deepEqual(r.results.map((x) => [x.email, x.outcome]), [["mona@x.test", "linked"], ["omar@x.test", "invited"]]);
  assert.ok(w.state.linked.some((l) => l.parent_id === ID(88)));
  assert.deepEqual(w.state.invited, ["omar@x.test"]);
});

test("approve: an email that belongs to staff is never turned into a parent", async () => {
  const w = world({ users: { "mona@x.test": { id: ID(89), role: "teacher", active: true } } });
  const r = await call(approve, { body: ap(), headers: as("tok-admin"), w });
  assert.equal(r.results[0].outcome, "failed");
  assert.equal(w.state.linked.some((l) => l.parent_id === ID(89)), false);
});

test("approve: if an invitation cannot be sent, the approval stands and the failure is reported", async () => {
  const w = world({ inviteFails: ["mona@x.test"] });
  const r = await call(approve, { body: ap(), headers: as("tok-admin"), w });
  assert.equal(r.status, 200);
  assert.deepEqual(r.results.map((x) => [x.email, x.outcome]), [["mona@x.test", "failed"], ["omar@x.test", "invited"]]);
  assert.ok(r.results[0].error.length > 0);
});

test("approve: the same email twice is invited once; a database refusal stops everything", async () => {
  const dup = world({ approveResult: { child_id: ID(500), language: "en", parents: [{ full_name: "A", phone: "+20 100 111 2222", email: "same@x.test" }, { full_name: "B", phone: "+20 100 111 3333", email: "SAME@x.test" }] } });
  const r = await call(approve, { body: ap(), headers: as("tok-admin"), w: dup });
  assert.equal(r.results.length, 1);
  assert.equal(dup.state.invited.length, 1);
  const refused = world({ approveError: "This application is already approved" });
  const x = await call(approve, { body: ap(), headers: as("tok-admin"), w: refused });
  assert.ok(x.status >= 400);
  assert.equal(refused.state.invited.length, 0);
});

test("approve retry: tries the invitations again for an application that is already approved, without approving twice", async () => {
  const w = world();
  const r = await call(approve, { body: { application_id: ID(300), retry: true }, headers: as("tok-admin"), w });
  assert.equal(r.status, 200);
  assert.equal(w.state.calls.some((c) => c.path.includes("approve_registration")), false, "must not approve a second time");
  const get = w.state.calls.find((c) => c.path.includes("registration_get"));
  assert.equal(get.auth, "Bearer tok-admin", "the application is read as the caller");
  assert.deepEqual(w.state.invited.sort(), ["mona@x.test", "omar@x.test"]);
  assert.equal(r.child_id, ID(500));
});

test("approve retry: refused for staff who may not invite, and for an application that is not approved", async () => {
  assert.equal((await call(approve, { body: { application_id: ID(300), retry: true }, headers: as("tok-teacher") })).status, 403);
  assert.equal((await call(approve, { body: { application_id: ID(300), retry: true }, headers: as("tok-parent") })).status, 403);
  const notYet = world({ getResult: { id: ID(300), status: "new", child_id: null, language: "en", parents: [] } });
  const r = await call(approve, { body: { application_id: ID(300), retry: true }, headers: as("tok-admin"), w: notYet });
  assert.equal(r.status, 400);
  assert.equal(notYet.state.invited.length, 0);
  assert.equal((await call(approve, { body: { application_id: "nope", retry: true }, headers: as("tok-admin") })).status, 400);
});
