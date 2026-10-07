// Security checks on the code and the repository itself (Prompt 10).
//   * no secret keys in any file or anywhere in the git history (this repository is PUBLIC)
//   * the browser code never builds HTML from data, never uses public photo links, never holds the service key
//   * every server function checks who is calling
// Run from the project root:  node --test tests/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const git = (args, opts = {}) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, ...opts });

// ---------------------------------------------------------------- secrets
const PATTERNS = [
  ["Supabase secret key", /sb_secret_[A-Za-z0-9_-]{10,}/],
  ["Resend API key", /\bre_[A-Za-z0-9]{20,}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["GitHub fine-grained token", /github_pat_[A-Za-z0-9_]{30,}/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Stripe live key", /\b[sr]k_live_[A-Za-z0-9]{16,}\b/],
  ["service key assigned a value", /SERVICE_ROLE_KEY["']?\s*[:=]\s*["'][A-Za-z0-9._-]{20,}["']/],
  ["OAuth client secret assigned a value", /OAUTH_CLIENT_SECRET["']?\s*[:=]\s*["'][A-Za-z0-9._-]{16,}["']/],
  ["CRON secret assigned a value", /CRON_SECRET["']?\s*[:=]\s*["'][A-Za-z0-9._-]{16,}["']/],
];
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

// Values that are plainly placeholders (used in tests and docs) are not secrets.
const FAKE = /(test|fake|example|dummy|placeholder|changeme|your[-_ ]|xxx)/i;
function findSecrets(text) {
  const found = [];
  for (const [name, re] of PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    if (/assigned a value/.test(name) && FAKE.test(m[0])) continue;
    found.push(`${name}: ${m[0].slice(0, 12)}…`);
  }
  for (const m of text.matchAll(JWT)) {
    let role = "unreadable";
    try { role = JSON.parse(Buffer.from(m[0].split(".")[1], "base64url").toString()).role || "no-role"; } catch (e) {}
    if (role !== "anon") found.push(`JWT with role "${role}": ${m[0].slice(0, 12)}…`);       // only the public "anon" key may appear
  }
  return found;
}

const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".mov", ".mp4", ".pdf", ".woff", ".woff2"]);
const files = git(["ls-files", "-co", "--exclude-standard"]).split("\n").filter(Boolean).filter((f) => !SKIP_EXT.has(extname(f).toLowerCase()) && existsSync(join(root, f)));

test("no secret keys in any file in the project", () => {
  const hits = [];
  for (const f of files) {
    let text; try { text = readFileSync(join(root, f), "utf8"); } catch (e) { continue; }
    for (const h of findSecrets(text)) hits.push(`${f} -> ${h}`);
  }
  assert.deepEqual(hits, []);
});

test("no secret keys anywhere in the git history (every commit, every branch)", () => {
  const log = git(["log", "--all", "-p", "--no-color", "--text"]);
  const added = log.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
  assert.deepEqual(findSecrets(added), []);
});

test("the only key in the website's config is the public anon key", () => {
  const cfg = readFileSync(join(root, "js", "portal-config.js"), "utf8");
  const keys = [...cfg.matchAll(JWT)];
  assert.equal(keys.length, 1);
  assert.equal(JSON.parse(Buffer.from(keys[0][0].split(".")[1], "base64url").toString()).role, "anon");
});

test("the secret-finder itself works (so a clean result means something)", () => {
  const fakeService = "eyJhbGciOiJIUzI1NiJ9." + Buffer.from(JSON.stringify({ role: "service_role", ref: "x" })).toString("base64url") + ".abcdefghijkl";
  assert.ok(findSecrets(`const k = "${fakeService}";`).length === 1);
  assert.ok(findSecrets("RESEND_API_KEY=" + "re_" + "abcdefghijklmnopqrstuvwxyz1234").length === 1);
  assert.ok(findSecrets("SUPABASE_SERVICE_ROLE_KEY = " + '"' + "kJ8s2LmQ9xT4vB7nR1wZpYc3" + '"').length === 1);
  assert.ok(findSecrets("-----BEGIN RSA PRIV" + "ATE KEY-----").length === 1);
  assert.ok(findSecrets("SUPABASE_SERVICE_ROLE_KEY: " + '"' + "service-key-for-tests" + '"').length === 0, "fake fixtures are not secrets");
  const anon = "eyJhbGciOiJIUzI1NiJ9." + Buffer.from(JSON.stringify({ role: "anon" })).toString("base64url") + ".abcdefghijkl";
  assert.equal(findSecrets(`const k = "${anon}";`).length, 0);
});

test(".env files and node_modules are ignored by git", () => {
  const ignore = readFileSync(join(root, ".gitignore"), "utf8");
  for (const p of [".env", "node_modules/"]) assert.ok(ignore.includes(p), p + " must be in .gitignore");
  assert.equal(files.filter((f) => /(^|\/)\.env/.test(f)).length, 0);
});

// ---------------------------------------------------------------- browser code
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", "vendor", "images", "content", "admin"].includes(name)) continue;
    const p = join(dir, name);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}
const portalJs = ["js/login.js", "js/portal-core.js", "js/portal-parent.js", "js/portal-parent-strings.js", "js/staff.js", "js/owner.js", "js/routine.js", "js/owner-charts.js",
  "js/staff-strings.js", "js/staff-investigation-strings.js", "js/staff-report-strings.js", "js/staff-owner-strings.js", "js/staff-routine-strings.js", "js/applications.js", "js/door.js", "js/absences.js", "js/absences-strings.js", "js/payments.js", "js/payments-strings.js", "js/receipt.js", "js/portal-payments.js", "js/birthdays.js", "js/transport.js", "js/transport-strings.js", "js/portal-transport.js", "js/portal-messages.js", "js/portal-messages-strings.js", "js/birthday-wall.js","js/portal-ask.js", "js/portal-home.js", "js/portal-home-strings.js", "js/admin.js", "js/admin-strings.js", "js/photos.js", "js/photos-strings.js", "js/portal-photos.js", "js/comm-admin.js", "js/staff-comm-strings.js", "js/portal-news.js", "js/portal-calendar.js", "js/portal-comm-strings.js", "js/pwa.js", "js/daily.js", "js/staff-daily-strings.js", "js/portal-daily.js", "js/portal-daily-strings.js", "js/staff-door-strings.js", "js/portal-child.js", "js/portal-attendance.js", "js/portal-attendance-strings.js", "js/portal-child-strings.js", "js/staff-applications-strings.js", "js/portal-logic.js"];

test("portal pages never turn text into HTML (no innerHTML, eval or document.write)", () => {
  const bad = [];
  for (const f of portalJs) {
    const text = readFileSync(join(root, f), "utf8");
    for (const re of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write\(/, /\beval\(/, /new Function\(/, /dangerouslySetInnerHTML/])
      if (re.test(text)) bad.push(`${f}: ${re}`);
  }
  assert.deepEqual(bad, []);
});

test("photos are only shown through short-lived signed links, never public links", () => {
  const bad = [];
  for (const f of portalJs) {
    const text = readFileSync(join(root, f), "utf8");
    if (/getPublicUrl/.test(text)) bad.push(f + ": getPublicUrl");
    for (const m of text.matchAll(/createSignedUrl\(([^)]*)\)/g)) {
      const secs = Number((m[1].split(",")[1] || "").trim());
      if (!(secs > 0 && secs <= 600)) bad.push(`${f}: signed link lifetime "${m[1]}"`);
    }
  }
  assert.deepEqual(bad, []);
  assert.ok(portalJs.some((f) => /createSignedUrl/.test(readFileSync(join(root, f), "utf8"))), "the signed-link code must exist");
});

test("uploads are limited to images under 5 MB in the browser as well", () => {
  const text = readFileSync(join(root, "js", "portal-parent.js"), "utf8");
  assert.match(text, /5242880/);
  assert.match(text, /accept: "image\/\*"/);
  assert.match(text, /contentType: "image\/jpeg"/);
});

test("the secret service key never appears in browser code", () => {
  const bad = [];
  for (const f of walk(root).map((p) => relative(root, p).replace(/\\/g, "/"))) {
    if (!/\.(js|html)$/.test(f) || f.startsWith("api/") || f.startsWith("tests/") || f.startsWith("supabase/")) continue;
    if (/SERVICE_ROLE|service_role/i.test(readFileSync(join(root, f), "utf8"))) bad.push(f);
  }
  assert.deepEqual(bad, []);
});

test("portal pages ask search engines not to index them", () => {
  for (const f of ["login/index.html", "portal/index.html", "staff/index.html"]) {
    assert.match(readFileSync(join(root, f), "utf8"), /<meta name="robots" content="noindex, nofollow">/, f);
  }
});

test("the logout and inactivity timeout exist and last 30 minutes", () => {
  const logic = readFileSync(join(root, "js", "portal-logic.js"), "utf8");
  assert.match(logic, /INACTIVITY_MS = 30 \* 60 \* 1000/);
  assert.match(readFileSync(join(root, "js", "portal-core.js"), "utf8"), /watchInactivity\(\)/);
});

// ---------------------------------------------------------------- server functions
test("every server function checks who is calling", () => {
  const dir = join(root, "api");
  const unchecked = [];
  for (const f of readdirSync(dir)) {
    if (f.startsWith("_") || !f.endsWith(".js")) continue;
    const text = readFileSync(join(dir, f), "utf8");
    const oauth = f === "auth.js" || f === "callback.js";        // the CMS login handshake (no secrets exposed)
    if (/publicEndpoint\(/.test(text)) continue;                  // public forms are held to a stricter test below
    if (!oauth && !/\bendpoint\(/.test(text) && !/CRON_SECRET/.test(text)) unchecked.push(f);
  }
  assert.deepEqual(unchecked, []);
});

test("the scheduled-job endpoint compares its secret in constant time", () => {
  assert.match(readFileSync(join(root, "api", "portal-send-emails.js"), "utf8"), /timingSafeEqual/);
});

test("server functions never print secrets or stack traces to the caller", () => {
  for (const f of readdirSync(join(root, "api")).filter((x) => x.endsWith(".js"))) {
    const text = readFileSync(join(root, "api", f), "utf8");
    assert.ok(!/res\.end\([^)]*\.stack/.test(text), f);
    assert.ok(!/console\.(log|error)\([^)]*(KEY|SECRET|token)/i.test(text), f);
  }
});

test("public endpoints (the registration form) are rate-limited, size-limited and never show database text", () => {
  const dir = join(root, "api");
  const publics = readdirSync(dir).filter((f) => f.endsWith(".js") && !f.startsWith("_") && /publicEndpoint\(/.test(readFileSync(join(dir, f), "utf8")));
  assert.deepEqual(publics.sort(), ["birthday-wall.js", "portal-register-upload.js", "portal-register.js"], "a new public function must be added here on purpose");
  for (const f of publics) {
    const text = readFileSync(join(dir, f), "utf8");
    assert.match(text, /registration_rate_hit/, f + " must count and limit requests");
    assert.match(text, /visitorKey\(/, f + " must count visitors without storing their address");
    assert.ok(!/res\.end\(/.test(text), f + " must only answer through publicEndpoint (which hides database errors)");
  }
  const lib = readFileSync(join(dir, "_lib", "portal.js"), "utf8");
  assert.match(lib, /upstream/, "database error text must be flagged so it never reaches a stranger");
  assert.match(lib, /maxBytes/, "public bodies are size-limited");
});

test("the registration page never builds HTML from text and holds no secret", () => {
  const f = join(root, "js", "register.js");
  if (!existsSync(f)) return;
  const text = readFileSync(f, "utf8");
  for (const re of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write\(/, /\beval\(/, /new Function\(/]) assert.ok(!re.test(text), String(re));
  assert.ok(!/service_role|SERVICE_ROLE/i.test(text));
});
