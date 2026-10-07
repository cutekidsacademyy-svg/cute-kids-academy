// Web push without any libraries. The push carries NO text: the service worker (sw.js) shows
// "You have a new update" and opens the portal, so nothing private ever travels through the push service.
// Environment variables (Vercel): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (both base64url, see LAUNCH-CHECKLIST), VAPID_SUBJECT (mailto:...).
// Without them this does nothing and emails carry on as before.
const crypto = require("crypto");

const b64u = (buf) => Buffer.from(buf).toString("base64url");

function configured(env) { return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY); }

function privateKey(env) {
  const pub = Buffer.from(env.VAPID_PUBLIC_KEY, "base64url");            // 0x04 | X (32) | Y (32)
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID_PUBLIC_KEY must be an uncompressed P-256 key");
  return crypto.createPrivateKey({ key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: env.VAPID_PRIVATE_KEY }, format: "jwk" });
}

// The signed proof that this server may push to a subscription of that push service.
function vapidHeader(endpoint, env, nowMs) {
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || "mailto:Cutekidsacademyy@gmail.com" }));
  const sig = crypto.sign("sha256", Buffer.from(header + "." + claims), { key: privateKey(env), dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

// One empty push to one subscription. Returns the HTTP status (404/410 mean the device has unsubscribed).
async function pushOne(sub, env, fetchImpl, nowMs) {
  const res = await fetchImpl(sub.endpoint, { method: "POST", headers: { Authorization: vapidHeader(sub.endpoint, env, nowMs), TTL: "86400", Urgency: "normal", "Content-Length": "0" } });
  return res.status;
}

// Push everything waiting in the notification queue that has not been pushed yet.
async function sendPushes(client, env, fetchImpl, nowMs) {
  if (!configured(env)) return { configured: false, pushed: 0, removed: 0 };
  const rows = await client.call("/rest/v1/email_outbox?pushed_at=is.null&user_id=not.is.null&status=in.(pending,sent)&order=created_at.asc&limit=50&select=id,user_id");
  if (!rows.length) return { configured: true, pushed: 0, removed: 0 };
  const users = [...new Set(rows.map((r) => r.user_id))];
  const subs = await client.call(`/rest/v1/push_subscriptions?user_id=in.(${users.join(",")})&select=id,user_id,endpoint`);
  const by = {}; for (const s of subs) (by[s.user_id] = by[s.user_id] || []).push(s);
  let pushed = 0, removed = 0;
  for (const row of rows) {
    for (const sub of by[row.user_id] || []) {
      try {
        const status = await pushOne(sub, env, fetchImpl, nowMs);
        if (status === 404 || status === 410) { await client.call(`/rest/v1/push_subscriptions?id=eq.${sub.id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }); removed++; }
        else if (status >= 200 && status < 300) pushed++;
      } catch (e) { /* a device that cannot be reached is simply skipped; the email still goes out */ }
    }
    await client.call(`/rest/v1/email_outbox?id=eq.${row.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { pushed_at: new Date(nowMs).toISOString() } });
  }
  return { configured: true, pushed, removed };
}

module.exports = { configured, vapidHeader, pushOne, sendPushes };
