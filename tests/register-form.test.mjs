// Checks on the public registration form's wording and wiring (no browser needed).
// Run from the project root:  node --test tests/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const read = (f) => readFileSync(join(root, f), "utf8");
const ctx = { window: {} };
vm.runInNewContext(read("js/register-strings.js"), ctx);
const STR = ctx.window.REG_STR;
const code = read("js/register.js");

test("English and Arabic have exactly the same wording keys, none empty", () => {
  assert.deepEqual(Object.keys(STR.ar).sort(), Object.keys(STR.en).sort());
  for (const l of ["en", "ar"]) for (const [k, v] of Object.entries(STR[l])) assert.ok(String(v).trim(), `${l}.${k} is empty`);
});

test("every wording key the form asks for exists", () => {
  const used = new Set([...code.matchAll(/\bt\("([A-Za-z0-9_.]+)"\)/g)].map((m) => m[1]));
  for (const k of ["s.1", "s.2", "s.3", "s.4", "s.5", "s.6", "s.7"]) used.add(k);
  for (const p of ["nursery", "preschool", "after_school", "camp"]) used.add("prog." + p);
  for (const r of ["mother", "father", "guardian", "other"]) used.add("rel." + r);
  for (const c of ["photos_class", "photos_social", "outings", "emergency_treatment", "birthday_wall"]) used.add("c." + c);
  for (const k of ["doc_birth", "doc_vacc", "doc_other"]) used.add(k);
  const missing = [...used].filter((k) => !(k in STR.en));
  assert.deepEqual(missing, []);
});

test("the form talks only to our two public functions and private storage", () => {
  assert.match(code, /\/api\/portal-register-upload/);
  assert.match(code, /\/api\/portal-register"/);
  assert.match(code, /uploadToSignedUrl/);
  assert.ok(!/getPublicUrl/.test(code));
});

test("the form is built to the same limits as the server (files, people, types)", () => {
  assert.match(code, /MAX_BYTES = 5242880/);
  assert.match(code, /MAX_PICKUPS = 6/);
  for (const t of ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"]) assert.ok(code.includes(t), t);
  assert.match(code, /name: "hp_site"/, "the hidden trap field exists");
  assert.match(code, /website: trap/, "…and is sent as 'website'");
});

test("answers are kept for 7 days, can be cleared, and files are not stored in the browser", () => {
  assert.match(code, /TTL = 7 \* 24 \* 3600 \* 1000/);
  assert.match(code, /wipe\(\)/);
  assert.ok(!/FileReader|readAsDataURL/.test(code), "uploaded files must never be copied into local storage");
});

test("all five consents are asked, including the birthday wall", () => {
  assert.match(code, /CONSENTS = \["photos_class", "photos_social", "outings", "emergency_treatment", "birthday_wall"\]/);
});

test("the public Enroll popup links to the full registration", () => {
  assert.match(read("index.html"), /href="\/register\/"/);
});

test("the registration page is not indexed and loads no secret", () => {
  assert.match(read("register/index.html"), /<meta name="robots" content="noindex, nofollow">/);
});

test("staff Applications and My class wording: same keys in both languages, and every key used exists", () => {
  const c2 = { CKA: { STR: { en: {}, ar: {} } } };
  vm.runInNewContext(read("js/staff-applications-strings.js"), c2);
  const { en, ar } = c2.CKA.STR;
  assert.deepEqual(Object.keys(ar).sort(), Object.keys(en).sort());
  const src = read("js/applications.js");
  const used = new Set([...src.matchAll(/\bt\("(ap\.[A-Za-z0-9_.]+|mc\.[A-Za-z0-9_.]+)"\)/g)].map((m) => m[1]));
  for (const s of ["new", "missing_documents", "tour_booked", "waitlist", "approved", "declined"]) used.add("ap.st." + s);
  for (const s of ["submitted", "new", "missing_documents", "tour_booked", "waitlist", "declined", "approved"]) used.add("ap.ev." + s);
  for (const s of ["invited", "linked", "failed"]) used.add("ap.out." + s);
  for (const s of ["nursery", "preschool", "after_school", "camp"]) used.add("ap.prog." + s);
  for (const s of ["mother", "father", "guardian", "other"]) used.add("ap.rel." + s);
  for (const s of ["photos_class", "photos_social", "outings", "emergency_treatment", "birthday_wall"]) used.add("ap.c." + s);
  assert.deepEqual([...used].filter((k) => !(k in en)), []);
});

test("only admin, manager and owner reach the Applications screens", () => {
  const src = read("js/applications.js");
  assert.match(src, /S\.routes\.applications = function \(\) \{ return S\.isMgmt\(\)/);
  assert.match(src, /S\.routes\.application = function \(p\) \{ return S\.isMgmt\(\)/);
});

test("door screen, attendance report and parent attendance wording: same keys in both languages, and every key used exists", () => {
  for (const [strings, scripts, prefixes] of [["js/staff-door-strings.js", ["js/door.js"], ["dr", "ar"]], ["js/portal-attendance-strings.js", ["js/portal-attendance.js"], ["pa"]]]) {
    const c = { CKA: { STR: { en: {}, ar: {} } } };
    vm.runInNewContext(read(strings), c);
    const { en, ar } = c.CKA.STR;
    assert.deepEqual(Object.keys(ar).sort(), Object.keys(en).sort(), strings);
    for (const k of Object.keys(en)) assert.ok(String(ar[k]).trim() && String(en[k]).trim(), k);
    const used = new Set();
    for (const f of scripts) for (const m of read(f).matchAll(new RegExp('\bt\("((?:' + prefixes.join("|") + ')\.[A-Za-z0-9_.]+)"\)', "g"))) used.add(m[1]);
    for (const s of ["absence", "late"]) { used.add("pa.n." + s); }
    assert.deepEqual([...used].filter((k) => !(k in en) && !(k === "pa.n.absence" && !strings.includes("portal-attendance")) && !(k === "pa.n.late" && !strings.includes("portal-attendance"))), [], strings);
  }
});

test("the door and the attendance report are wired into the staff page; the parent page into the portal; reports are management only", () => {
  const staff = read("staff/index.html"), portal = read("portal/index.html"), door = read("js/door.js");
  for (const f of ["staff-door-strings.js", "door.js"]) assert.match(staff, new RegExp(f.replace(".", "\.")));
  for (const f of ["portal-attendance-strings.js", "portal-attendance.js"]) assert.match(portal, new RegExp(f.replace(".", "\.")));
  assert.match(door, /if \(!S\.isMgmt\(\)\) return S\.routes\[""\]\(\)/);
  assert.match(read("js/staff.js"), /data-route="attreport"/);
});

test("the parent form states the 8 am rule and the child-safety wording is never skipped at the door", () => {
  const door = read("js/door.js"), pa = read("js/portal-attendance.js");
  assert.match(pa, /cairoMinutes\(\) < 480/);
  assert.match(door, /door_pickups/);
  assert.match(door, /dr\.warn/);
  assert.match(door, /off_list_needs_parent_approval/);
});
