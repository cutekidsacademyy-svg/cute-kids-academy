// POST /api/portal-set-active
// Switch a parent (child withdrawn) or staff member (left the academy) off or back on.
// History stays for the records; a switched-off account cannot log in or read anything.
// Body: { user_id, active: true | false }
const { L, HttpError, endpoint } = require("./_lib/portal.js");

module.exports = endpoint(async ({ body, client, caller }) => {
  if (!L.canInviteParents(caller.role)) throw new HttpError(403, "You are not allowed to change access.");
  if (typeof body.active !== "boolean" || !L.UUID_RE.test(String(body.user_id || ""))) {
    throw new HttpError(400, "Invalid request.");
  }
  if (body.user_id === caller.id) throw new HttpError(400, "You cannot change your own access.");

  const rows = await client.call(`/rest/v1/profiles?id=eq.${body.user_id}&select=id,role,active`);
  const target = rows && rows[0];
  if (!target) throw new HttpError(404, "That account was not found.");
  if (!L.canChangeActive(caller.role, target.role)) throw new HttpError(403, "You are not allowed to change this account.");

  await client.call(`/rest/v1/profiles?id=eq.${target.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: { active: body.active },
  });
  // Also stop the login itself, so existing sessions cannot be refreshed.
  await client.call(`/auth/v1/admin/users/${target.id}`, {
    method: "PUT",
    body: { ban_duration: body.active ? "none" : "876000h" },
  });
  return { user_id: target.id, active: body.active };
});
