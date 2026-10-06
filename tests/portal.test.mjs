// Tests for the portal's shared rules and server functions, against a fake Supabase.
// Run from the project root:  node --test tests
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const L = require("../js/portal-logic.js");
const inviteParent = require("../api/portal-invite-parent.js");
const inviteStaff = require("../api/portal-invite-staff.js");
const setActive = require("../api/portal-set-active.js");

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ENV = { SUPABASE_URL: "https://fake.supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service-key-for-tests", SITE_URL: "https://site.test" };

// A tiny stand-in for Supabase: tokens map to users, profiles/children/classes are in memory.
function fakeSupabase({ failLinks = false } = {}) {
  const state = {
    tokens: { "tok-admin": ID(1), "tok-manager": ID(2), "tok-owner": ID(3), "tok-parent": ID(4), "tok-teacher": ID(5), "tok-gone": ID(6) },
    profiles: {
      [ID(1)]: { id: ID(1), role: "admin", active: true, full_name: "Admin" },
      [ID(2)]: { id: ID(2), role: "manager", active: true, full_name: "Manager" },
      [ID(3)]: { id: ID(3), role: "owner", active: true, full_name: "Owner" },
      [ID(4)]: { id: ID(4), role: "parent", active: true, full_name: "Parent" },
      [ID(5)]: { id: ID(5), role: "teacher", active: true, full_name: "Teacher" },
      [ID(6)]: { id: ID(6), role: "admin", active: false, full_name: "Left" },
      [ID(7)]: { id: ID(7), role: "parent", active: true, full_name: "Other parent" },
      [ID(8)]: { id: ID(8), role: "manager", active: true, full_name: "Other manager" },
      [ID(9)]: { id: ID(9), role: "admin", active: true, full_name: "Other admin" },
    },
    children: [ID(101), ID(102)],
    classes: [ID(201)],
    calls: [],
  };
  const json = (status, data) => ({ ok: status < 400, status, text: async () => (data === undefined ? "" : JSON.stringify(data)) });
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    state.calls.push({ method: opts.method, path: u.pathname + u.search, body, auth: opts.headers.Authorization });
    const p = u.pathname;
    if (p === "/auth/v1/user") {
      const id = state.tokens[opts.headers.Authorization.replace("Bearer ", "")];
      return id ? json(200, { id }) : json(401, { msg: "invalid token" });
    }
    if (p === "/rest/v1/profiles" && opts.method === "GET") {
      const id = u.searchParams.get("id").replace("eq.", "");
      return json(200, state.profiles[id] ? [state.profiles[id]] : []);
    }
    if (p === "/rest/v1/children") {
      const wanted = u.searchParams.get("id").replace(/^in\.\(|\)$/g, "").split(",");
      return json(200, wanted.filter((x) => state.children.includes(x)).map((id) => ({ id })));
    }
    if (p === "/rest/v1/classes") {
      const wanted = u.searchParams.get("id").replace(/^in\.\(|\)$/g, "").split(",");
      return json(200, wanted.filter((x) => state.classes.includes(x)).map((id) => ({ id })));
    }
    if (p === "/auth/v1/invite") {
      if (body.email === "taken@x.test") return json(422, { msg: "A user with this email address has already been registered" });
      return json(200, { id: ID(900) });
    }
    if (p === "/rest/v1/profiles" && opts.method === "POST") { state.profiles[body.id] = body; return json(201); }
    if (p === "/rest/v1/parent_children" && failLinks) return json(400, { message: "A child can have at most two parents" });
    if (p === "/rest/v1/parent_children" || p === "/rest/v1/staff_classes") return json(201);
    if (p === "/rest/v1/profiles" && opts.method === "PATCH") {
      state.profiles[u.searchParams.get("id").replace("eq.", "")].active = body.active; return json(204);
    }
    if (p === "/rest/v1/profiles" && opts.method === "DELETE") { delete state.profiles[u.searchParams.get("id").replace("eq.", "")]; return json(204); }
    if (p.startsWith("/auth/v1/admin/users/")) return json(200, {});
    return json(404, { message: "unexpected call " + p });
  };
  return { state, fetchImpl };
}

async function run(handler, { method = "POST", token, body, fake = fakeSupabase() }) {
  const req = { method, headers: { host: "site.test", ...(token ? { authorization: "Bearer " + token } : {}) }, body };
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s) { this.payload = JSON.parse(s); } };
  await handler(req, res, ENV, fake.fetchImpl);
  return { status: res.statusCode, ...res.payload, fake };
}

const parentBody = { email: "New.Parent@Example.com", full_name: "New Parent", phone: "+20 100 000 0000", language: "ar", child_ids: [ID(101)] };

// ------------------------------ shared rules ------------------------------
test("guard sends each role to its own area", () => {
  assert.deepEqual(L.guard("portal", { role: "parent", active: true }), { action: "stay" });
  assert.deepEqual(L.guard("staff", { role: "parent", active: true }), { action: "redirect", to: "/portal/" });
  assert.deepEqual(L.guard("portal", { role: "teacher", active: true }), { action: "redirect", to: "/staff/" });
  assert.deepEqual(L.guard("staff", { role: "owner", active: true }), { action: "stay" });
  assert.deepEqual(L.guard("staff", { role: "admin", active: false }), { action: "login" });
  assert.deepEqual(L.guard("portal", null), { action: "login" });
  assert.deepEqual(L.guard("staff", { role: "mystery", active: true }), { action: "redirect", to: "/login/" });
});

test("sessions expire after 30 minutes of inactivity", () => {
  const now = 10_000_000_000;
  assert.equal(L.isExpired(now - 29 * 60_000, now), false);
  assert.equal(L.isExpired(now - 31 * 60_000, now), true);
  assert.equal(L.isExpired(null, now), false);
});

test("who may create which staff roles", () => {
  assert.deepEqual(L.staffRolesCallerCanCreate("owner"), ["teacher", "admin", "manager", "owner"]);
  assert.deepEqual(L.staffRolesCallerCanCreate("manager"), ["teacher", "admin"]);
  assert.deepEqual(L.staffRolesCallerCanCreate("admin"), []);
  assert.deepEqual(L.staffRolesCallerCanCreate("parent"), []);
});

test("who may switch access on or off", () => {
  assert.equal(L.canChangeActive("admin", "parent"), true);
  assert.equal(L.canChangeActive("admin", "teacher"), true);
  assert.equal(L.canChangeActive("admin", "admin"), false);
  assert.equal(L.canChangeActive("admin", "manager"), false);
  assert.equal(L.canChangeActive("manager", "admin"), true);
  assert.equal(L.canChangeActive("manager", "owner"), false);
  assert.equal(L.canChangeActive("owner", "manager"), true);
  assert.equal(L.canChangeActive("teacher", "parent"), false);
  assert.equal(L.canChangeActive("parent", "parent"), false);
});

test("deadlines are described in plain words in Cairo time", () => {
  const now = Date.parse("2026-10-11T07:00:00Z");            // Sunday 10:00 in Cairo
  assert.equal(L.whenText("2026-10-11T08:00:00Z", now, "en"), "today at 11:00 am");
  assert.equal(L.whenText("2026-10-12T06:00:00Z", now, "en"), "tomorrow at 9:00 am");
  assert.equal(L.whenText("2026-10-15T11:00:00Z", now, "en"), "Thursday at 2:00 pm");
  assert.match(L.whenText("2026-10-30T11:00:00Z", now, "en"), /^30 October at /);
  assert.match(L.whenText("2026-10-11T08:00:00Z", now, "ar"), /^اليوم الساعة /);
  assert.match(L.whenText("2026-10-12T06:00:00Z", now, "ar"), /^غداً الساعة /);
  // 22:30 UTC on Sunday is already Monday 01:30 in Cairo
  assert.equal(L.whenText("2026-10-11T22:30:00Z", now, "en"), "tomorrow at 1:30 am");
});

test("reference numbers and the ratings month", () => {
  assert.equal(L.refLabel(7), "CKA-0007");
  assert.equal(L.refLabel(12345), "CKA-12345");
  assert.equal(L.monthKey(Date.parse("2026-10-31T22:30:00Z")), "2026-11-01");   // already November in Cairo
  assert.equal(L.monthKey(Date.parse("2026-10-15T10:00:00Z")), "2026-10-01");
});

// ------------------------------ invite parent ------------------------------
test("invite parent: needs a login token", async () => {
  const r = await run(inviteParent, { body: parentBody });
  assert.equal(r.status, 401);
});

test("invite parent: GET is refused", async () => {
  const r = await run(inviteParent, { method: "GET", token: "tok-admin" });
  assert.equal(r.status, 405);
});

test("invite parent: parents, teachers and switched-off staff are refused", async () => {
  for (const [token, status] of [["tok-parent", 403], ["tok-teacher", 403], ["tok-gone", 403], ["bad-token", 401]]) {
    const r = await run(inviteParent, { token, body: parentBody });
    assert.equal(r.status, status, token);
    assert.equal(r.ok, false);
  }
});

test("invite parent: admin invites and links the child", async () => {
  const fake = fakeSupabase();
  const r = await run(inviteParent, { token: "tok-admin", body: parentBody, fake });
  assert.equal(r.status, 200);
  assert.equal(r.user_id, ID(900));
  const invite = fake.state.calls.find((c) => c.path.startsWith("/auth/v1/invite"));
  assert.equal(invite.body.email, "new.parent@example.com");
  assert.ok(invite.path.includes(encodeURIComponent("https://site.test/login/?mode=set-password")));
  const profile = fake.state.calls.find((c) => c.path === "/rest/v1/profiles" && c.method === "POST");
  assert.equal(profile.body.role, "parent");
  assert.equal(profile.body.language, "ar");
  const link = fake.state.calls.find((c) => c.path === "/rest/v1/parent_children");
  assert.deepEqual(link.body, [{ parent_id: ID(900), child_id: ID(101) }]);
});

test("invite parent: a caller cannot make the new account a staff role", async () => {
  const fake = fakeSupabase();
  await run(inviteParent, { token: "tok-admin", body: { ...parentBody, role: "owner" }, fake });
  const profile = fake.state.calls.find((c) => c.path === "/rest/v1/profiles" && c.method === "POST");
  assert.equal(profile.body.role, "parent");
});

test("invite parent: bad input is rejected before anything is created", async () => {
  for (const body of [
    { ...parentBody, email: "not-an-email" },
    { ...parentBody, full_name: "  " },
    { ...parentBody, child_ids: [] },
    { ...parentBody, child_ids: ["x') or true--"] },
    { ...parentBody, child_ids: [ID(101), ID(999)] },
  ]) {
    const fake = fakeSupabase();
    const r = await run(inviteParent, { token: "tok-admin", body, fake });
    assert.equal(r.status, 400, JSON.stringify(body.child_ids));
    assert.equal(fake.state.calls.some((c) => c.path.startsWith("/auth/v1/invite")), false);
  }
});

test("invite parent: an email that already has an account gives a clear conflict", async () => {
  const r = await run(inviteParent, { token: "tok-admin", body: { ...parentBody, email: "taken@x.test" } });
  assert.equal(r.status, 409);
});

test("invite parent: if linking the child fails, the new login is rolled back", async () => {
  const fake = fakeSupabase({ failLinks: true });
  const r = await run(inviteParent, { token: "tok-admin", body: parentBody, fake });
  assert.equal(r.status, 400);
  assert.ok(fake.state.calls.some((c) => c.method === "DELETE" && c.path.startsWith("/rest/v1/profiles")));
  assert.ok(fake.state.calls.some((c) => c.method === "DELETE" && c.path === `/auth/v1/admin/users/${ID(900)}`));
  assert.equal(fake.state.profiles[ID(900)], undefined);
});

test("the service key is never sent back to the browser", async () => {
  const { fake, ...response } = await run(inviteParent, { token: "tok-admin", body: parentBody });
  assert.equal(response.ok, true);
  assert.equal(JSON.stringify(response).includes("service-key-for-tests"), false);
});

// ------------------------------ invite staff ------------------------------
const staffBody = { email: "teacher@example.com", full_name: "New Teacher", language: "en", role: "teacher", class_ids: [ID(201)] };

test("invite staff: admin, teacher and parent cannot add staff", async () => {
  for (const token of ["tok-admin", "tok-teacher", "tok-parent"]) {
    const r = await run(inviteStaff, { token, body: staffBody });
    assert.equal(r.status, 403, token);
  }
});

test("invite staff: manager adds a teacher with a class", async () => {
  const fake = fakeSupabase();
  const r = await run(inviteStaff, { token: "tok-manager", body: staffBody, fake });
  assert.equal(r.status, 200);
  const link = fake.state.calls.find((c) => c.path === "/rest/v1/staff_classes");
  assert.deepEqual(link.body, [{ staff_id: ID(900), class_id: ID(201) }]);
});

test("invite staff: a manager cannot create an owner or another manager", async () => {
  for (const role of ["owner", "manager", "parent", "superuser"]) {
    const r = await run(inviteStaff, { token: "tok-manager", body: { ...staffBody, role } });
    assert.equal(r.status, 403, role);
  }
});

test("invite staff: the owner can create a manager", async () => {
  const r = await run(inviteStaff, { token: "tok-owner", body: { ...staffBody, role: "manager", class_ids: [] } });
  assert.equal(r.status, 200);
});

test("invite staff: unknown class is rejected", async () => {
  const r = await run(inviteStaff, { token: "tok-owner", body: { ...staffBody, class_ids: [ID(999)] } });
  assert.equal(r.status, 400);
});

// ------------------------------ switch access ------------------------------
test("set active: manager switches a parent off, which also bans the login", async () => {
  const fake = fakeSupabase();
  const r = await run(setActive, { token: "tok-manager", body: { user_id: ID(7), active: false }, fake });
  assert.equal(r.status, 200);
  assert.equal(fake.state.profiles[ID(7)].active, false);
  const ban = fake.state.calls.find((c) => c.path === `/auth/v1/admin/users/${ID(7)}`);
  assert.equal(ban.body.ban_duration, "876000h");
});

test("set active: switching back on lifts the ban", async () => {
  const fake = fakeSupabase();
  await run(setActive, { token: "tok-manager", body: { user_id: ID(7), active: false }, fake });
  await run(setActive, { token: "tok-manager", body: { user_id: ID(7), active: true }, fake });
  const bans = fake.state.calls.filter((c) => c.path === `/auth/v1/admin/users/${ID(7)}`);
  assert.equal(bans[1].body.ban_duration, "none");
  assert.equal(fake.state.profiles[ID(7)].active, true);
});

test("set active: nobody can switch themselves off", async () => {
  const r = await run(setActive, { token: "tok-owner", body: { user_id: ID(3), active: false } });
  assert.equal(r.status, 400);
});

test("set active: an admin cannot switch off a manager or another admin; a manager cannot switch off an owner", async () => {
  assert.equal((await run(setActive, { token: "tok-admin", body: { user_id: ID(8), active: false } })).status, 403);
  assert.equal((await run(setActive, { token: "tok-admin", body: { user_id: ID(9), active: false } })).status, 403);
  assert.equal((await run(setActive, { token: "tok-manager", body: { user_id: ID(3), active: false } })).status, 403);
});

test("set active: parents and teachers cannot change access", async () => {
  for (const token of ["tok-parent", "tok-teacher"]) {
    const r = await run(setActive, { token, body: { user_id: ID(7), active: false } });
    assert.equal(r.status, 403, token);
  }
});

test("set active: malformed requests are refused", async () => {
  assert.equal((await run(setActive, { token: "tok-owner", body: { user_id: "not-a-uuid", active: false } })).status, 400);
  assert.equal((await run(setActive, { token: "tok-owner", body: { user_id: ID(7), active: "no" } })).status, 400);
  assert.equal((await run(setActive, { token: "tok-owner", body: { user_id: ID(404), active: false } })).status, 404);
});

test("a missing Supabase setting gives a clear setup message, not a crash", async () => {
  const req = { method: "POST", headers: { host: "x", authorization: "Bearer t" }, body: {} };
  const res = { setHeader() {}, end(s) { this.payload = JSON.parse(s); } };
  await inviteParent(req, res, {}, async () => { throw new Error("should not be called"); });
  assert.equal(res.statusCode, 500);
  assert.match(res.payload.error, /not set up yet/);
});
