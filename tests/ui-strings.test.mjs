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
  { name: "announcements, menu and events (staff)", strings: "js/staff-comm-strings.js", scripts: ["js/comm-admin.js"], prefixes: ["ca", "cm", "ce", "al"],
    extra: [...range("ca.a.", ["all", "class", "families"]), ...range("cm.", ["breakfast", "lunch", "snack"]), ...range("al.", ["peanuts", "tree_nuts", "milk", "eggs", "wheat", "soy", "fish", "shellfish", "sesame"]),
      ...range("ce.k.", ["event", "closure", "holiday", "session"]), "ce.yes", "ce.no"] },
  { name: "news, calendar and settings (parent)", strings: "js/portal-comm-strings.js", scripts: ["js/portal-news.js", "js/portal-calendar.js"], prefixes: ["pn", "cal", "ps"],
    extra: [...range("cal.k.", ["event", "closure", "holiday", "session"]), ...range("cal.m.", ["breakfast", "lunch", "snack"]), ...range("ps.", ["reports", "announcements", "events", "cases"])] },
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
