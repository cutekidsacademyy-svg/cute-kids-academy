// POST /api/portal-invite-parent
// Admin, manager or owner invites a parent by email and links them to their child or children.
// Body: { email, full_name, phone?, language: "ar" | "en", child_ids: [uuid, ...] }
const { L, HttpError, endpoint, cleanText, inviteUser } = require("./_lib/portal.js");

module.exports = endpoint(async ({ req, body, client, caller, env }) => {
  if (!L.canInviteParents(caller.role)) throw new HttpError(403, "You are not allowed to invite parents.");

  const email = cleanText(body.email, 254).toLowerCase();
  const fullName = cleanText(body.full_name, 120);
  const phone = cleanText(body.phone, 30);
  const language = body.language === "en" ? "en" : "ar";
  const childIds = Array.isArray(body.child_ids) ? Array.from(new Set(body.child_ids)) : [];

  if (!L.EMAIL_RE.test(email)) throw new HttpError(400, "Please enter a valid email address.");
  if (!fullName) throw new HttpError(400, "Please enter the parent's name.");
  if (childIds.length < 1 || childIds.length > 10 || !childIds.every((id) => L.UUID_RE.test(id))) {
    throw new HttpError(400, "Choose at least one child.");
  }

  const found = await client.call(`/rest/v1/children?id=in.(${childIds.join(",")})&active=eq.true&select=id`);
  if (!found || found.length !== childIds.length) throw new HttpError(400, "One of the chosen children was not found or is no longer enrolled.");

  const userId = await inviteUser({
    client, req, env, email, fullName, phone, language, role: "parent",
    after: (id) => client.call("/rest/v1/parent_children", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: childIds.map((child_id) => ({ parent_id: id, child_id })),
    }),
  });
  return { user_id: userId };
});
