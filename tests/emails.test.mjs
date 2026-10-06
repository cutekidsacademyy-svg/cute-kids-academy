// Tests for the email wording and the email sender, against fake Supabase and Resend servers.
// Run from the project root:  node --test tests
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { render, TEMPLATES } = require("../api/_lib/email.js");
const sender = require("../api/portal-send-emails.js");

const SITE = "https://site.test";
const NOW = Date.parse("2026-10-11T07:00:00Z");           // Sunday 10:00 in Cairo
const CASE = {
  id: "11111111-1111-4111-8111-111111111111", ref_no: 7, title: "Lunch concern", urgency: "urgent", old_urgency: "can_wait",
  level: 2, done: 2, total: 6, late_tasks: 3, step: "parent_called", kind: "ack", reason: "Child was hungry two days running",
  acknowledge_by: "2026-10-11T09:00:00Z", resolve_by: "2026-10-12T07:00:00Z", deadline: "2026-10-11T08:00:00Z",
};

// ------------------------------ wording ------------------------------
test("every template renders in English and Arabic with a subject, a link and no 'undefined'", () => {
  assert.ok(TEMPLATES.length >= 17);
  for (const t of TEMPLATES) for (const lang of ["en", "ar"]) {
    const m = render(t, CASE, lang, { site: SITE, now: NOW });
    assert.ok(m.subject.length > 3, `${t}/${lang} subject`);
    assert.ok(m.html.includes(SITE + "/"), `${t}/${lang} has a link`);
    assert.ok(m.text.includes(SITE + "/"), `${t}/${lang} text has a link`);
    for (const part of [m.subject, m.html, m.text]) assert.ok(!/undefined|\[object|null/.test(part), `${t}/${lang} has no placeholder junk: ${part.slice(0, 80)}`);
  }
});

test("Arabic emails are right-to-left and English ones left-to-right", () => {
  assert.match(render("received", CASE, "ar", { site: SITE, now: NOW }).html, /dir="rtl"/);
  assert.match(render("received", CASE, "ar", { site: SITE, now: NOW }).html, /lang="ar"/);
  assert.match(render("received", CASE, "en", { site: SITE, now: NOW }).html, /dir="ltr"/);
});

test("the received email states the deadline in plain words, and critical cases promise a call", () => {
  const en = render("received", CASE, "en", { site: SITE, now: NOW });
  assert.match(en.text, /We will get back to you by today at 12:00 pm/);
  const crit = render("received", { ...CASE, urgency: "critical", acknowledge_by: "2026-10-11T08:00:00Z" }, "en", { site: SITE, now: NOW });
  assert.match(crit.text, /A manager will call you within 1 hour, by today at 11:00 am/);
  assert.match(render("received", CASE, "ar", { site: SITE, now: NOW }).text, /سنعود إليك قبل اليوم الساعة/);
});

test("parent emails link to the portal and staff emails to the staff area", () => {
  assert.match(render("acknowledged", CASE, "en", { site: SITE }).text, new RegExp(`${SITE}/portal/#/case/${CASE.id}`));
  assert.match(render("accident_report", CASE, "en", { site: SITE }).text, new RegExp(`${SITE}/portal/#/reports`));
  assert.match(render("escalated", CASE, "en", { site: SITE }).text, new RegExp(`${SITE}/staff/#/case/${CASE.id}`));
  assert.match(render("serious_accident", CASE, "en", { site: SITE }).text, new RegExp(`${SITE}/staff/#/investigations`));
});

test("the urgency-change email carries the reason, as the plan asks", () => {
  const m = render("urgency_changed", CASE, "en", { site: SITE });
  assert.match(m.text, /Can wait.*Urgent/);
  assert.match(m.text, /Reason: Child was hungry two days running/);
});

test("anything typed by a person is escaped, so an email can never carry markup", () => {
  const m = render("assigned", { ...CASE, title: `<script>alert(1)</script> & "x"` }, "en", { site: SITE, now: NOW });
  assert.ok(!m.html.includes("<script>"));
  assert.ok(m.html.includes("&lt;script&gt;"));
  const r = render("urgency_changed", { ...CASE, reason: "<img src=x onerror=alert(1)>" }, "en", { site: SITE });
  assert.ok(!r.html.includes("<img"));
});

test("parent emails do not contain case text; an unknown template is rejected", () => {
  for (const t of ["received", "acknowledged", "update_added", "resolved", "investigation_step", "accident_report"]) {
    const m = render(t, { ...CASE, title: "SECRET TITLE" }, "en", { site: SITE, now: NOW });
    assert.ok(!/SECRET TITLE/.test(m.html + m.text), t);
  }
  assert.throws(() => render("nope", {}, "en", {}), /Unknown email template/);
});

// ------------------------------ sender ------------------------------
function world({ resendOk = true, claimRace = false, rows } = {}) {
  const state = {
    outbox: rows || [
      { id: "a1", user_id: "u1", to_email: "parent@x.test", language: "en", template: "received", payload: CASE, status: "pending", attempts: 0 },
      { id: "a2", user_id: "u2", to_email: "owner@x.test", language: "ar", template: "critical_alert", payload: CASE, status: "pending", attempts: 0 },
    ],
    resend: [], calls: [],
  };
  const json = (status, data) => ({ ok: status < 400, status, text: async () => (data === undefined ? "" : JSON.stringify(data)) });
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    state.calls.push({ method: opts.method, path: u.pathname + u.search, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (u.hostname === "api.resend.com") {
      state.resend.push({ headers: opts.headers, body: JSON.parse(opts.body) });
      return resendOk ? json(200, { id: "re_1" }) : json(422, { message: "domain not verified" });
    }
    if (u.pathname === "/rest/v1/rpc/cka_run_owner_reminders") return json(200, { sent: 1, working_day: true, late_tasks: 2 });
    if (u.pathname === "/rest/v1/rpc/cka_run_deadline_check") return json(200, { warned: 1, escalated: 0, overdue_at_top: 0, requeued: 0, in_working_hours: true });
    if (u.pathname === "/rest/v1/email_outbox" && opts.method === "GET") return json(200, state.outbox.filter((r) => r.status === "pending"));
    if (u.pathname === "/rest/v1/email_outbox" && opts.method === "PATCH") {
      const id = u.searchParams.get("id").replace("eq.", ""), row = state.outbox.find((r) => r.id === id), b = JSON.parse(opts.body);
      if (u.searchParams.get("status") && (claimRace || row.status !== "pending")) return json(200, []);
      Object.assign(row, b);
      return opts.headers.Prefer === "return=representation" ? json(200, [row]) : json(204);
    }
    return json(404, { message: "unexpected " + u.pathname });
  };
  return { state, fetchImpl };
}
const ENV = { SUPABASE_URL: "https://fake.supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service-key", CRON_SECRET: "s3cret", RESEND_API_KEY: "re_key", RESEND_FROM: "Cute Kids Academy <n@academy.test>", SITE_URL: SITE };

async function call({ method = "POST", secret = "s3cret", body = {}, env = ENV, w = world() }) {
  const req = { method, headers: secret === null ? {} : { authorization: "Bearer " + secret }, body };
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s) { this.payload = JSON.parse(s); } };
  await sender(req, res, env, w.fetchImpl, NOW);
  return { status: res.statusCode, ...res.payload, w };
}

test("sender: only the scheduler (with the shared secret) may call it", async () => {
  assert.equal((await call({ secret: null })).status, 401);
  assert.equal((await call({ secret: "wrong" })).status, 401);
  assert.equal((await call({ secret: "" })).status, 401);
  assert.equal((await call({ method: "GET" })).status, 405);
  assert.equal((await call({ env: { ...ENV, CRON_SECRET: undefined } })).status, 500);
});

test("sender: without a Resend key emails wait safely in the queue", async () => {
  const w = world();
  const r = await call({ env: { ...ENV, RESEND_API_KEY: undefined }, w });
  assert.equal(r.status, 200);
  assert.equal(r.emails.configured, false);
  assert.equal(r.emails.waiting, 2);
  assert.equal(w.state.resend.length, 0);
  assert.ok(w.state.outbox.every((x) => x.status === "pending"));
});

test("sender: sends each queued email through Resend and marks it sent", async () => {
  const w = world();
  const r = await call({ w });
  assert.equal(r.emails.sent, 2);
  assert.equal(w.state.resend.length, 2);
  const first = w.state.resend[0];
  assert.equal(first.body.from, ENV.RESEND_FROM);
  assert.deepEqual(first.body.to, ["parent@x.test"]);
  assert.match(first.body.subject, /We received your message \(CKA-0007\)/);
  assert.equal(first.headers["Idempotency-Key"], "a1");
  assert.match(first.headers.Authorization, /^Bearer re_key$/);
  assert.match(w.state.resend[1].body.html, /dir="rtl"/);                // the Arabic recipient
  assert.ok(w.state.outbox.every((x) => x.status === "sent"));
  const { w: _calls, ...response } = r;
  assert.equal(JSON.stringify(response).includes("re_key"), false);
});

test("sender: a failed send is kept for retry, and given up on after 5 attempts", async () => {
  const w = world({ resendOk: false });
  let r = await call({ w });
  assert.equal(r.emails.failed, 2);
  assert.ok(w.state.outbox.every((x) => x.status === "pending" && x.attempts === 1 && /domain not verified/.test(x.last_error)));
  for (let i = 0; i < 4; i++) await call({ w });
  assert.ok(w.state.outbox.every((x) => x.status === "failed" && x.attempts === 5));
  const after = w.state.resend.length;
  await call({ w });
  assert.equal(w.state.resend.length, after, "no more attempts once it has failed 5 times");
});

test("sender: if another run already claimed an email, it is not sent twice", async () => {
  const w = world({ claimRace: true });
  const r = await call({ w });
  assert.equal(r.emails.sent, 0);
  assert.equal(w.state.resend.length, 0);
});

test("sender: with check=true it runs the deadline clock first and reports it", async () => {
  const w = world();
  const r = await call({ w, body: { check: true } });
  assert.equal(r.deadlines.warned, 1);
  assert.equal(r.owner_reminders.sent, 1);
  assert.ok(w.state.calls.findIndex((c) => c.path.includes("cka_run_deadline_check")) < w.state.calls.findIndex((c) => c.path.startsWith("/rest/v1/email_outbox")));
  const plain = await call({ w: world(), body: {} });
  assert.equal(plain.deadlines, undefined);
  assert.equal(plain.owner_reminders, undefined);
});

test("owner reminder emails state the numbers and link to the checklist or dashboard", () => {
  const am = render("checklist_morning", CASE, "en", { site: SITE });
  assert.match(am.subject, /Morning walk: 2 of 6 checks done/);
  assert.match(am.text, new RegExp(SITE + "/staff/#/routine"));
  assert.match(render("checklist_afternoon", CASE, "ar", { site: SITE }).subject, /أُنجز 2 من 6/);
  assert.match(render("review_thursday", CASE, "en", { site: SITE }).text, /Late tasks: 3/);
  assert.match(render("review_monthly", CASE, "en", { site: SITE }).text, new RegExp(SITE + "/staff/#/owner"));
});
