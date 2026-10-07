// Tests for web push (api/_lib/push.js) and for the service worker and app manifest.
// Run from the project root:  node --test tests/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const push = require("../api/_lib/push.js");
const root = join(fileURLToPath(import.meta.url), "..", "..");

function keys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pj = publicKey.export({ format: "jwk" }), dj = privateKey.export({ format: "jwk" });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(pj.x, "base64url"), Buffer.from(pj.y, "base64url")]).toString("base64url");
  return { env: { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: dj.d, VAPID_SUBJECT: "mailto:test@example.test" }, publicKey };
}
const NOW = Date.parse("2026-10-11T09:00:00Z");

test("without VAPID keys push does nothing and never touches the queue", async () => {
  assert.equal(push.configured({}), false);
  const r = await push.sendPushes({ call: async () => { throw new Error("must not be called"); } }, {}, async () => { throw new Error("no"); }, NOW);
  assert.deepEqual(r, { configured: false, pushed: 0, removed: 0 });
});

test("the VAPID proof is a valid ES256 signature for the push service's own address, valid for 12 hours", () => {
  const { env, publicKey } = keys();
  const h = push.vapidHeader("https://fcm.googleapis.com/fcm/send/abc", env, NOW);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h);
  assert.ok(m, h);
  const claims = JSON.parse(Buffer.from(m[2], "base64url").toString());
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.exp, Math.floor(NOW / 1000) + 12 * 3600);
  assert.equal(m[4], env.VAPID_PUBLIC_KEY);
  assert.ok(crypto.verify("sha256", Buffer.from(m[1] + "." + m[2]), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url")), "signature verifies");
});

function world(statusFor = () => 201) {
  const state = { calls: [], posts: [], outbox: [{ id: "o1", user_id: "u1" }, { id: "o2", user_id: "u2" }, { id: "o3", user_id: "u1" }], subs: [{ id: "s1", user_id: "u1", endpoint: "https://push.test/a" }, { id: "s2", user_id: "u1", endpoint: "https://gone.test/b" }] };
  const client = { call: async (path, opts = {}) => {
    state.calls.push({ path, method: opts.method || "GET", body: opts.body });
    if (path.startsWith("/rest/v1/email_outbox?pushed_at")) return state.outbox;
    if (path.startsWith("/rest/v1/push_subscriptions?user_id")) return state.subs;
    return null;
  } };
  const fetchImpl = async (url, opts) => { state.posts.push({ url, headers: opts.headers, body: opts.body }); return { status: statusFor(url) }; };
  return { state, client, fetchImpl };
}

test("a push is empty (no text at all), signed, and sent to each device of the person; the notification is then marked as pushed", async () => {
  const { env } = keys();
  const w = world((u) => 201);
  const r = await push.sendPushes(w.client, env, w.fetchImpl, NOW);
  assert.equal(r.pushed, 4);                                   // u1 has two devices and two notifications
  for (const p of w.state.posts) { assert.equal(p.body, undefined); assert.match(p.headers.Authorization, /^vapid t=/); assert.equal(p.headers["Content-Length"], "0"); }
  const marked = w.state.calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/rest/v1/email_outbox")).map((c) => c.path.split("id=eq.")[1]);
  assert.deepEqual(marked.sort(), ["o1", "o2", "o3"]);          // u2 has no device but is still marked, so it is not retried forever
});

test("a device that has unsubscribed (404 or 410) is removed; an unreachable one is skipped without stopping anything", async () => {
  const { env } = keys();
  const w = world((u) => (u.includes("gone.test") ? 410 : 201));
  const r = await push.sendPushes(w.client, env, w.fetchImpl, NOW);
  assert.equal(r.removed, 2);
  assert.ok(w.state.calls.some((c) => c.method === "DELETE" && c.path.includes("id=eq.s2")));
  const w2 = world();
  w2.fetchImpl = async () => { throw new Error("network down"); };
  const r2 = await push.sendPushes(w2.client, env, w2.fetchImpl, NOW);
  assert.equal(r2.pushed, 0);
});

test("the service worker shows only a generic message, in both languages, and opens the portal; the manifest makes the portal installable", () => {
  const sw = readFileSync(join(root, "sw.js"), "utf8");
  assert.match(sw, /addEventListener\("push"/);
  assert.match(sw, /You have a new update/);
  assert.match(sw, /لديك تحديث جديد/);
  assert.ok(!/event\.data/.test(sw), "the push payload is never read or shown");
  assert.match(sw, /notificationclick/);
  const man = JSON.parse(readFileSync(join(root, "manifest.webmanifest"), "utf8"));
  assert.equal(man.display, "standalone");
  assert.ok(man.start_url.startsWith("/portal/") || man.start_url === "/login/");
  assert.ok(man.icons.length >= 1);
  for (const f of ["portal/index.html", "login/index.html"]) assert.match(readFileSync(join(root, f), "utf8"), /rel="manifest"/, f);
});
