// POST /api/portal-resend-invite
// Admin, manager or owner sends a parent a fresh invitation (if they never opened the first one) or a "set a new password" email
// (if they already have an account). Only for parents; it never reveals whether the account is set up.
// Body: { user_id }
const { L, HttpError, endpoint, origin } = require("./_lib/portal.js");

module.exports = endpoint(async ({ req, body, client, caller, env }) => {
  if (!L.canInviteParents(caller.role)) throw new HttpError(403, "You are not allowed to invite parents.");
  const id = String(body.user_id || "");
  if (!L.UUID_RE.test(id)) throw new HttpError(400, "Invalid request.");

  const rows = await client.call(`/rest/v1/profiles?id=eq.${id}&select=id,role,active,full_name,language`);
  const target = rows && rows[0];
  if (!target || target.role !== "parent") throw new HttpError(404, "That account was not found.");
  if (!target.active) throw new HttpError(400, "This account is switched off. Switch it on first.");

  const user = await client.call(`/auth/v1/admin/users/${id}`);
  const email = user && user.email;
  if (!email) throw new HttpError(404, "That account has no email address.");
  const redirect = encodeURIComponent(origin(req, env) + "/login/?mode=set-password");
  const opened = !!(user.email_confirmed_at || user.confirmed_at || user.last_sign_in_at);
  if (opened) await client.call(`/auth/v1/recover?redirect_to=${redirect}`, { method: "POST", body: { email } });
  else await client.call(`/auth/v1/invite?redirect_to=${redirect}`, { method: "POST", body: { email, data: { full_name: target.full_name, language: target.language } } });
  return { sent: true };
});
