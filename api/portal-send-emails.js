// POST /api/portal-send-emails
// Called by Supabase's scheduler (see supabase/schedule-emails.sql), never by a browser.
//   * every minute:     sends whatever is waiting in the email queue, through Resend
//   * every 15 minutes: body { "check": true } also runs the deadline clock first
// Protected by a shared secret: Authorization: Bearer <CRON_SECRET>.
// Environment variables (Vercel): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET,
// RESEND_API_KEY, RESEND_FROM (e.g. "Cute Kids Academy <notifications@yourdomain.com>"), SITE_URL.
// Until RESEND_API_KEY is set, emails simply wait in the queue; nothing is lost.
const crypto = require("crypto");
const { HttpError, makeClient } = require("./_lib/portal.js");
const { render } = require("./_lib/email.js");
const { sendPushes } = require("./_lib/push.js");
const { cleanupMedia } = require("./_lib/media-cleanup.js");

const BATCH = 20;           // emails per run (keeps well inside the function time limit)
const MAX_ATTEMPTS = 5;

function sameSecret(given, expected) {
  const a = Buffer.from(String(given || "")), b = Buffer.from(String(expected || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

async function sendEmails(client, env, fetchImpl, now) {
  const site = env.SITE_URL || "https://cutekidsacademy-eg.vercel.app";
  const pending = await client.call(`/rest/v1/email_outbox?status=eq.pending&order=created_at.asc&limit=${BATCH}&select=*`);
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) return { configured: false, waiting: pending.length, sent: 0, failed: 0 };

  let sent = 0, failed = 0;
  for (const row of pending) {
    // Claim the row first, so two overlapping runs never send the same email twice.
    const claimed = await client.call(`/rest/v1/email_outbox?id=eq.${row.id}&status=eq.pending`, {
      method: "PATCH", headers: { Prefer: "return=representation" },
      body: { status: "sending", claimed_at: new Date(now).toISOString(), attempts: row.attempts + 1 },
    });
    if (!claimed || !claimed.length) continue;

    let error = null;
    try {
      const mail = render(row.template, row.payload, row.language, { site, now });
      const res = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json", "Idempotency-Key": row.id },
        body: JSON.stringify({ from: env.RESEND_FROM, to: [row.to_email], subject: mail.subject, html: mail.html, text: mail.text }),
      });
      if (!res.ok) { let t = ""; try { t = await res.text(); } catch (e) {} error = `Resend ${res.status} ${t}`.slice(0, 300); }
    } catch (e) { error = String(e && e.message || e).slice(0, 300); }

    if (!error) {
      await client.call(`/rest/v1/email_outbox?id=eq.${row.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { status: "sent", sent_at: new Date(now).toISOString(), last_error: null } });
      sent++;
    } else {
      const giveUp = row.attempts + 1 >= MAX_ATTEMPTS;
      await client.call(`/rest/v1/email_outbox?id=eq.${row.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { status: giveUp ? "failed" : "pending", last_error: error } });
      failed++;
    }
  }
  return { configured: true, waiting: pending.length - sent - failed, sent, failed };
}

module.exports = async function handler(req, res, env = process.env, fetchImpl = globalThis.fetch, now = Date.now()) {
  const send = (status, body) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(body)); };
  try {
    if (req.method !== "POST") throw new HttpError(405, "Use POST.");
    if (!env.CRON_SECRET) throw new HttpError(500, "CRON_SECRET is not set in Vercel.");
    const header = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m || !sameSecret(m[1], env.CRON_SECRET)) throw new HttpError(401, "Not allowed.");

    const client = makeClient(env, fetchImpl);
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const out = { ok: true };
    if (body.check === true) {
      out.deadlines = await client.call("/rest/v1/rpc/cka_run_deadline_check", { method: "POST", body: {} });
      out.owner_reminders = await client.call("/rest/v1/rpc/cka_run_owner_reminders", { method: "POST", body: {} });
      out.attendance = await client.call("/rest/v1/rpc/cka_run_attendance_check", { method: "POST", body: {} });
      out.reports = await client.call("/rest/v1/rpc/cka_run_report_check", { method: "POST", body: {} });
      out.content = await client.call("/rest/v1/rpc/cka_run_content_check", { method: "POST", body: {} });
      try { out.media = await cleanupMedia(client); } catch (e) { out.media = { error: true }; }
    }
    out.emails = await sendEmails(client, env, fetchImpl, now);
    try { out.push = await sendPushes(client, env, fetchImpl, now); } catch (e) { out.push = { error: true }; }   // push is a bonus: never lets it stop the emails
    send(200, out);
  } catch (e) {
    if (e instanceof HttpError) send(e.status, { ok: false, error: e.message });
    else send(500, { ok: false, error: "Something went wrong." });
  }
};
