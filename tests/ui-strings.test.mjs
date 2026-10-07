// Wording checks for the newer portal screens: both languages have the same keys, nothing is empty, and every
// wording key a screen asks for exists. Run from the project root:  node --test tests/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const read = (f) => readFileSync(join(root, f), "utf8");
const range = (prefix, list) => list.map((x) => prefix + x);

const SETS = [
  { name: "parent home, ask forms and More", strings: "js/portal-home-strings.js", scripts: ["js/portal-home.js", "js/portal-ask.js"], prefixes: ["hm", "pq", "mo"], extra: range("pq.t.", ["fees", "schedule", "food", "my_childs_day", "other"]) },
  { name: "admin area and job titles", strings: "js/admin-strings.js", scripts: ["js/admin.js"], prefixes: ["ad", "jt", "staff"],
    extra: [...range("ad.access.", ["active", "invited", "off"]), ...range("ad.c.", ["photos_class", "photos_social", "outings", "emergency_treatment", "birthday_wall"]), ...range("ad.log.", ["created", "health", "pickup", "consent", "contact", "class", "withdrawn", "reinstated"]),
      ...range("ad.cl.r.", ["head", "teacher", "co_teacher", "assistant"]), ...range("ad.tab.", ["today", "children", "classes", "settings", "people"]), ...range("jt.", ["teacher", "co_teacher", "assistant", "admin", "manager", "owner", "finance_assistant", "finance_manager"])] },
  { name: "photos (staff and parent)", strings: "js/photos-strings.js", scripts: ["js/photos.js", "js/portal-photos.js"], prefixes: ["ph", "pp"], extra: ["ph.a.delete", "ph.a.archive"] },
  { name: "announcements, menu and events (staff)", strings: "js/staff-comm-strings.js", scripts: ["js/comm-admin.js"], prefixes: ["ca", "cm", "ce", "al"],
    extra: [...range("ca.a.", ["all", "class", "families"]), ...range("cm.", ["breakfast", "lunch", "snack"]), ...range("al.", ["peanuts", "tree_nuts", "milk", "eggs", "wheat", "soy", "fish", "shellfish", "sesame"]),
      ...range("ce.k.", ["event", "closure", "holiday", "session"]), "ce.yes", "ce.no"] },
  { name: "news, calendar and settings (parent)", strings: "js/portal-comm-strings.js", scripts: ["js/portal-news.js", "js/portal-calendar.js"], prefixes: ["pn", "cal", "ps"],
    extra: [...range("cal.k.", ["event", "closure", "holiday", "session"]), ...range("cal.m.", ["breakfast", "lunch", "snack"]), ...range("ps.", ["reports", "announcements", "events", "cases"])] },
  { name: "payments (parent, finance and receipts)", strings: "js/payments-strings.js", scripts: ["js/payments.js", "js/portal-payments.js", "js/receipt.js"], prefixes: ["pay", "py", "rc"],
    extra: [...range("pay.k.", ["tuition", "overtime", "event", "transport", "late_fee", "other"]), ...range("pay.method.", ["instapay", "cash", "bank_transfer"]), ...range("pay.st.", ["waiting", "confirmed", "rejected"]),
      ...range("py.s.", ["paid", "waiting", "due", "overdue", "none"]), ...range("py.prog.", ["nursery", "preschool", "after_school", "camp"])] },
  { name: "messages (parent)", strings: "js/portal-messages-strings.js", scripts: ["js/portal-messages.js"], prefixes: ["ms"], extra: range("ms.k.", ["followup", "birthday", "academy"]) },
  { name: "birthdays, transport (staff) and the school bus (parent)", strings: "js/transport-strings.js", scripts: ["js/birthdays.js", "js/transport.js", "js/portal-transport.js"], prefixes: ["bd", "tr", "pt"],
    extra: [...range("tr.st.", ["on_board", "absent", "dropped_off"]), ...range("pt.st.", ["on_board", "absent", "dropped_off", "none"])] },
];

for (const set of SETS) {
  test(`wording: ${set.name}: same keys in both languages, none empty, all used keys exist`, () => {
    const c = { CKA: { STR: { en: {}, ar: {} } } };
    vm.runInNewContext(read(set.strings), c);
    const { en, ar } = c.CKA.STR;
    assert.deepEqual(Object.keys(ar).sort(), Object.keys(en).sort());
    for (const k of Object.keys(en)) assert.ok(String(en[k]).trim() && String(ar[k]).trim(), k);
    const used = new Set(set.extra);
    for (const f of set.scripts) for (const m of read(f).matchAll(new RegExp('\\bt\\("((?:' + set.prefixes.join("|") + ')\\.[A-Za-z0-9_.]+)"\\)', "g"))) used.add(m[1]);
    assert.deepEqual([...used].filter((k) => !(k in en)), []);
  });
}

test("the menu allergen list in the database, the staff screen and the wording are the same nine allergens", () => {
  const sql = read("supabase/migrations/20261006121800_menu_events.sql");
  const fromSql = [...sql.match(/allergens   text\[\][^;]*?array\[([^\]]+)\]/)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const fromScreen = [...read("js/comm-admin.js").match(/var ALLERGENS = \[([^\]]+)\]/)[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(fromScreen, fromSql);
  assert.equal(fromSql.length, 9);
});

test("the announcement and calendar pages are wired into the staff page and the portal", () => {
  const staff = read("staff/index.html"), portal = read("portal/index.html");
  for (const f of ["staff-comm-strings.js", "comm-admin.js"]) assert.match(staff, new RegExp(f.replace(".", "\\.")));
  for (const f of ["portal-comm-strings.js", "portal-news.js", "portal-calendar.js", "pwa.js"]) assert.match(portal, new RegExp(f.replace(".", "\\.")));
  for (const r of ["announcements", "menu", "events"]) assert.match(read("js/staff.js"), new RegExp(`'${r}'`));
});

test("the parent calendar and news pages only ever read through the database (no direct writes)", () => {
  for (const f of ["js/portal-news.js", "js/portal-calendar.js"]) assert.ok(!/\.(insert|update|delete)\(/.test(read(f)), f);
});

test("photos: links are short-lived, never public, videos are limited to 60 seconds and 50 MB", () => {
  for (const f of ["js/photos.js", "js/portal-photos.js"]) {
    const text = read(f);
    assert.ok(!/getPublicUrl/.test(text), f);
    const calls = [...text.matchAll(/createSignedUrls?\(([^\n]*)/g)];
    assert.ok(calls.length > 0, f);
    for (const m of calls) { const secs = [...m[1].matchAll(/,\s*(\d+)/g)].map((x) => Number(x[1])).filter((n) => n >= 60); assert.ok(secs.length && secs.every((n) => n <= 600), f + ": " + m[1].slice(0, 80)); }
  }
  const staff = read("js/photos.js");
  assert.match(staff, /MAX_VIDEO_SECONDS = 60/);
  assert.match(staff, /MAX_BYTES = 52428800/);
  assert.match(staff, /media_consent_check/);
  assert.match(read("supabase/migrations/20261006121900_media.sql"), /video_too_long/);
});
test("the photos screens are wired in", () => {
  assert.match(read("staff/index.html"), /photos\.js/);
  assert.match(read("portal/index.html"), /portal-photos\.js/);
});

test("the parent home shows the four quick actions, no accident-reporting button, and the bottom menu exists", () => {
  const home = read("js/portal-home.js"), portal = read("portal/index.html"), ask = read("js/portal-ask.js");
  for (const href of ['"#/ask"', '"#/attendance"', '"#/ask/missing"', '"#/new"']) assert.ok(home.includes(href), href);
  assert.ok(!/report an accident/i.test(home), "parents do not report accidents; staff do");
  assert.match(portal, /class="p-bottom"/);
  assert.match(portal, /data-route="more"/);
  assert.ok(ask.includes("https://wa.me/"));
  assert.ok(ask.includes('urgency: urgent.checked ? "urgent" : "can_wait"'));
});

test("payments, messages, birthdays and transport are wired into the staff page and the portal; money screens never show to teachers", () => {
  const staff = read("staff/index.html"), portal = read("portal/index.html"), js = read("js/staff.js");
  for (const f of ["payments-strings.js", "payments.js", "receipt.js", "birthdays.js", "transport.js", "transport-strings.js"]) assert.match(staff, new RegExp(f.replace(".", "\.")), f);
  for (const f of ["payments-strings.js", "receipt.js", "portal-payments.js", "portal-messages.js", "portal-transport.js", "transport-strings.js", "portal-messages-strings.js"]) assert.match(portal, new RegExp(f.replace(".", "\.")), f);
  assert.match(js, /\["attreport", "payments", "receipt"\]/, "a finance login may only open attendance reports, payments and receipts");
  assert.match(js, /data-route="payments"\]'\)\.hidden = me\.role !== "finance" && me\.role !== "owner"/);
  assert.match(read("js/payments.js"), /if \(!allowed\(\)\)/);
  // bottom menu: Home, Report, Calendar, Photos, Payments; four quick buttons with Payments last
  const bottom = portal.slice(portal.indexOf('class="p-bottom"'), portal.indexOf("</nav>", portal.indexOf('class="p-bottom"')));
  assert.deepEqual([...bottom.matchAll(/data-route="(\w+)"/g)].map((m) => m[1]), ["home", "daily", "calendar", "photos", "payments"]);
  assert.match(read("js/portal-home.js"), /big\("#\/ask", .*big\("#\/attendance", .*big\("#\/ask\/missing", .*big\("#\/payments"/);
});

test("the birthday wall page shows only text from the server and holds no secret", () => {
  const page = read("js/birthday-wall.js");
  for (const re of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write\(/, /\beval\(/, /service_role|SERVICE_ROLE|supabase/i]) assert.ok(!re.test(page), String(re));
  assert.match(read("birthdays/index.html"), /noindex/);
  assert.match(read("api/birthday-wall.js"), /first_name[^]*initial[^]*turning/);
  assert.ok(!/full_name|date_of_birth|child_id/.test(read("api/birthday-wall.js")), "the public function never passes more than the first name, an initial and the age");
});
