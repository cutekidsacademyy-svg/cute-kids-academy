// Tests for the portal's shared rules and server functions, against a fake Supabase.
// Run from the project root:  node --test tests/*.test.mjs
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
  assert.equal(L.whenText("2026-10-10T08:00:00Z", now, "en"), "yesterday at 11:00 am");
  assert.equal(L.whenText("2026-10-08T08:00:00Z", now, "en"), "Thursday at 11:00 am");
  // 22:30 UTC on Sunday is already Monday 01:30 in Cairo
  assert.equal(L.whenText("2026-10-11T22:30:00Z", now, "en"), "tomorrow at 1:30 am");
});

test("reference numbers and the ratings month", () => {
  assert.equal(L.refLabel(7), "CKA-0007");
  assert.equal(L.refLabel(12345), "CKA-12345");
  assert.equal(L.monthKey(Date.parse("2026-10-31T22:30:00Z")), "2026-11-01");   // already November in Cairo
  assert.equal(L.monthKey(Date.parse("2026-10-15T10:00:00Z")), "2026-10-01");
});

test("queue colours: overdue, due within 2 hours, on track, done", () => {
  const now = Date.parse("2026-10-11T10:00:00Z");
  assert.equal(L.dueState("2026-10-11T09:59:00Z", now), "overdue");
  assert.equal(L.dueState("2026-10-11T11:59:00Z", now), "soon");
  assert.equal(L.dueState("2026-10-11T12:00:00Z", now), "soon");
  assert.equal(L.dueState("2026-10-11T12:01:00Z", now), "ok");
  assert.equal(L.dueState(null, now), "done");
});

test("manager overview counts", () => {
  const now = Date.parse("2026-10-11T10:00:00Z");
  const rows = [
    { status: "received", escalation_level: 1, next_due: "2026-10-11T09:00:00Z" },       // overdue
    { status: "in_progress", escalation_level: 3, next_due: "2026-10-12T09:00:00Z" },
    { status: "acknowledged", escalation_level: 3, next_due: "2026-10-11T09:30:00Z" },   // overdue
    { status: "resolved", escalation_level: 2, next_due: null, resolved_at: "2026-10-09T10:00:00Z" },  // this week
    { status: "closed", escalation_level: 1, next_due: null, resolved_at: "2026-09-01T10:00:00Z" },    // old
  ];
  const o = L.overview(rows, now);
  assert.deepEqual(o.byLevel, { 1: 1, 2: 0, 3: 2, 4: 0 });
  assert.equal(o.overdue, 2);
  assert.equal(o.closedThisWeek, 1);
  assert.equal(o.open, 3);
});

test("queue filters", () => {
  const rows = [
    { id: 1, type: "complaint", urgency: "urgent", status: "received", class_id: "A", assigned_to: "me" },
    { id: 2, type: "safety_concern", urgency: "critical", status: "in_progress", class_id: "B", assigned_to: "other" },
    { id: 3, type: "complaint", urgency: "can_wait", status: "resolved", class_id: "A", assigned_to: null },
  ];
  const ids = (f) => L.filterQueue(rows, f, "me").map((r) => r.id);
  assert.deepEqual(ids({}), [1, 2]);                              // default: open only
  assert.deepEqual(ids({ status: "all" }), [1, 2, 3]);
  assert.deepEqual(ids({ status: "resolved" }), [3]);
  assert.deepEqual(ids({ type: "safety_concern" }), [2]);
  assert.deepEqual(ids({ urgency: "urgent" }), [1]);
  assert.deepEqual(ids({ classId: "A", status: "all" }), [1, 3]);
  assert.deepEqual(ids({ mine: true, status: "all" }), [1]);
});

test("report periods: this week starts on Sunday, this month on the 1st, in Cairo time", () => {
  assert.deepEqual(L.periodFor("week", Date.parse("2026-10-14T10:00:00Z")), { from: "2026-10-11", to: "2026-10-14" });   // Wednesday
  assert.deepEqual(L.periodFor("week", Date.parse("2026-10-11T10:00:00Z")), { from: "2026-10-11", to: "2026-10-11" });   // Sunday itself
  assert.deepEqual(L.periodFor("week", Date.parse("2026-10-16T10:00:00Z")), { from: "2026-10-11", to: "2026-10-16" });   // Friday
  assert.deepEqual(L.periodFor("month", Date.parse("2026-10-14T10:00:00Z")), { from: "2026-10-01", to: "2026-10-14" });
  // 22:30 UTC on Saturday is already Sunday in Cairo
  assert.deepEqual(L.periodFor("week", Date.parse("2026-10-17T22:30:00Z")), { from: "2026-10-18", to: "2026-10-18" });
  assert.deepEqual(L.periodFor("week", Date.parse("2026-01-01T10:00:00Z")), { from: "2025-12-28", to: "2026-01-01" });   // across a year end
});

test("percentages and changes", () => {
  assert.equal(L.pct(2, 5), 40); assert.equal(L.pct(1, 3), 33); assert.equal(L.pct(0, 0), null);
  assert.equal(L.change(4, 2), 2); assert.equal(L.change(3.5, 4), -0.5); assert.equal(L.change(4, null), ""); assert.equal(L.change(null, 2), "");
});

test("CSV cells are quoted when needed and can never run as spreadsheet formulas", () => {
  assert.equal(L.csvCell("plain"), "plain");
  assert.equal(L.csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(L.csvCell("line1\nline2"), '"line1\nline2"');
  assert.equal(L.csvCell(7), "7");
  assert.equal(L.csvCell(null), "");
  assert.equal(L.csvCell("=HYPERLINK(\"http://evil\")"), '"\'=HYPERLINK(""http://evil"")"');
  assert.equal(L.csvCell("+1 555"), "'+1 555");
  assert.equal(L.csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(L.csvCell("-2.5"), "-2.5");                       // a plain negative number stays a number
  assert.equal(L.csvCell("يوسف، علي"), "يوسف، علي");
});

const SAMPLE_REPORT = {
  period: { from: "2025-03-01", to: "2025-03-31" },
  totals: { received: 5, open_now: 4, overdue_now: 3 },
  by_type_urgency: [{ type: "complaint", urgency: "urgent", count: 2 }, { type: "safety_concern", urgency: "critical", count: 1 }],
  on_time: { acknowledged: { due: 5, on_time: 2 }, resolved: { due: 0, on_time: 0 } },
  avg_resolve_hours: 43.5,
  escalations: { cases: 3, moves: 3, by_level: [{ level: 2, count: 2 }, { level: 4, count: 1 }] },
  satisfaction: { yes: 1, no: 1, waiting: 0 },
  incidents: { total: 3, open_investigations: 2, by_class: [{ name: "Butterflies", count: 2 }], by_location: [{ name: "Garden", count: 2 }], by_severity: [{ name: "minor", count: 2 }] },
  ratings: { month: "2025-03-01", previous_month: "2025-02-01",
    classes: [{ name: "Butterflies", count: 2, care: 4, communication: 4, daily: 4, prev_count: 1, prev_care: 2, prev_communication: 2, prev_daily: 2 },
              { name: "Ducklings", count: 1, care: 2, communication: 2, daily: 2, prev_count: 0, prev_care: null, prev_communication: null, prev_daily: null }],
    compliments: [{ staff: "Hana", count: 1, items: [{ month: "2025-03-01", text: "=SUM(1)" }] }] },
};

test("report sections hold every number the plan asks for", () => {
  const sec = L.reportSections(SAMPLE_REPORT, (k) => k);
  const byId = Object.fromEntries(sec.map((x) => [x.id, x]));
  const summary = Object.fromEntries(byId.summary.rows);
  assert.equal(summary["rp.ack_on_time"], "2 / 5 (40%)");
  assert.equal(summary["rp.res_on_time"], "0 / 0");
  assert.equal(summary["rp.overdue_now"], 3);
  assert.equal(summary["rp.avg_resolve"], 43.5);
  assert.equal(summary["rp.open_inv"], 2);
  assert.deepEqual(byId.types.rows[0], ["rp.type.complaint", "rp.urg.urgent", 2]);
  assert.deepEqual(byId.levels.rows, [["rp.level 2", 2], ["rp.level 4", 1]]);
  assert.deepEqual(byId.ratings.rows[0].slice(0, 5), ["Butterflies", 2, 4, 4, 4]);
  assert.deepEqual(byId.ratings.rows[0].slice(9), [2, 2, 2]);                      // improved by 2 on each score
  assert.deepEqual(byId.ratings.rows[1].slice(9), ["", "", ""]);                   // nothing to compare with
  assert.match(byId.ratings.title, /2025-03 vs 2025-02/);
});

test("the CSV holds the same sections, and defuses formulas in compliments", () => {
  const csv = L.toCsv(L.reportSections(SAMPLE_REPORT, (k) => k));
  assert.match(csv, /^rp\.summary\r\nrp\.metric,rp\.value\r\n/);
  assert.match(csv, /rp\.ack_on_time,2 \/ 5 \(40%\)/);
  assert.match(csv, /Hana,1,'=SUM\(1\)/);
  assert.ok(csv.includes("Butterflies,2,4,4,4,1,2,2,2,2,2,2"));
  assert.equal(csv.split("\r\n").filter((l) => l === "").length, 8);              // a blank line after each of the 8 sections
});

test("owner dashboard: 'last 3 months' is this month and the two before", () => {
  assert.deepEqual(L.periodFor("quarter", Date.parse("2026-10-14T10:00:00Z")), { from: "2026-08-01", to: "2026-10-14" });
  assert.deepEqual(L.periodFor("quarter", Date.parse("2026-01-14T10:00:00Z")), { from: "2025-11-01", to: "2026-01-14" });   // across a year end
});

test("chart axes get a friendly top", () => {
  assert.equal(L.niceMax(0), 5);
  assert.equal(L.niceMax(3), 5);
  assert.equal(L.niceMax(5), 5);
  assert.equal(L.niceMax(6), 10);
  assert.equal(L.niceMax(11), 20);
  assert.equal(L.niceMax(37), 50);
  assert.equal(L.niceMax(101), 200);
  assert.equal(L.niceMax(undefined), 5);
});

test("tile trends: rising problems are bad news, rising happy comments are good news", () => {
  assert.deepEqual(L.trend("accidents", 3, 1), { diff: 2, dir: "up", good: false });
  assert.deepEqual(L.trend("accidents", 1, 3), { diff: -2, dir: "down", good: true });
  assert.deepEqual(L.trend("happy_comments", 5, 2), { diff: 3, dir: "up", good: true });
  assert.deepEqual(L.trend("happy_comments", 2, 5), { diff: -3, dir: "down", good: false });
  assert.deepEqual(L.trend("late_minutes", 7, 7), { diff: 0, dir: "same", good: null });
});

const SAMPLE_OWNER = {
  period: { from: "2025-03-01", to: "2025-03-31", days: 31 },
  tiles: { accidents: { value: 3, previous: 1 }, complaints: { value: 3, previous: 1 }, happy_comments: { value: 2, previous: 1 },
           absence_days: { value: 12, previous: 1 }, late_minutes: { value: 30, previous: 5 }, open_hr: { value: 1, opened: 2, previous_opened: 0 } },
  weekly: [{ week_start: "2025-03-02", accidents: 2, complaints: 1, happy_comments: 0 }],
  latest_accidents: [{ occurred_at: "2025-03-09T08:00:00+00:00", child: "Youssef", class: "Ducklings", location: "Classroom", severity: "serious", note: "Fell", parent_read: false, investigation: "open" }],
  mistakes: [{ category: "Phone in class", critical: false, count: 3 }, { category: "Allergy check missed", critical: true, count: 1 }],
  staff: [{ name: "Hana", absence_days: 4, late_minutes: 30, class_accidents: 2, confirmed_faults: 4, complaints_about: 1, status: "action" }],
  hr_log: [{ staff: "Hana", type: "written_warning", date: "2025-03-10", note: "=cmd", follow_up_date: null, awaiting: true, decided_at: null }],
  staff_concerns: { recent: [{ date: "2025-03-10", category: "workload", status: "open", anonymous: true, raised_by: null, description: "Too many children" }] },
  families: [{ parent: "Parent A", complaints: 2, happy: 1, latest_message: "Lunch: hungry" }],
};

test("owner dashboard sections: the screen tables and the CSV come from one place", () => {
  const sec = L.ownerSections(SAMPLE_OWNER, (k) => k);
  assert.deepEqual(sec.map((x) => x.id), ["tiles", "weekly", "accidents", "mistakes", "staff", "hr", "concerns", "families"]);
  const byId = Object.fromEntries(sec.map((x) => [x.id, x]));
  assert.deepEqual(byId.tiles.rows[0], ["od.accidents", 3, 1, 2]);
  assert.deepEqual(byId.tiles.rows[5], ["od.open_hr", 1, "", 2]);
  assert.deepEqual(byId.mistakes.rows[1], ["Allergy check missed", "od.yes", 1]);
  assert.equal(byId.staff.rows[0][6], "od.status.action");
  assert.equal(byId.hr.rows[0][5], "od.awaiting");
  assert.equal(byId.concerns.rows[0][3], "od.anonymous");              // an anonymous concern never shows a name
  assert.equal(byId.accidents.rows[0][0], "2025-03-09");
  const csv = L.toCsv([byId.hr]);
  assert.match(csv, /'=cmd/);                                         // HR notes cannot run as spreadsheet formulas
  for (const s of sec) for (const row of s.rows) assert.equal(row.length, s.header.length, s.id + " row width");
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
