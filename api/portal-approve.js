// POST /api/portal-approve
// Admin, manager or owner approves a registration: the database creates the child in the chosen class
// (and checks the caller's role itself), then this function invites the parents to the portal and links
// them to the child. A parent who already has a login (a second child) is linked, not invited again.
// Body: { application_id, class_id }
const { L, HttpError, endpoint, inviteUser } = require("./_lib/portal.js");

module.exports = endpoint(async ({ req, body, client, caller, env }) => {
  if (!L.canInviteParents(caller.role)) throw new HttpError(403, "You are not allowed to approve applications.");
  if (!L.UUID_RE.test(String(body.application_id || "")) || !L.UUID_RE.test(String(body.class_id || ""))) throw new HttpError(400, "Please choose a class.");

  // 1. Approve in the database AS THE CALLER, so the database enforces who may do this.
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || req.headers.Authorization || "")[1];
  const approved = await client.call("/rest/v1/rpc/approve_registration", { method: "POST", token, body: { p_id: body.application_id, p_class: body.class_id } });
  const childId = approved.child_id, language = approved.language === "ar" ? "ar" : "en";

  // 2. Invite or link each parent (at most two).
  const link = (parentId) => client.call("/rest/v1/parent_children", {
    method: "POST", headers: { Prefer: "return=minimal,resolution=ignore-duplicates" }, body: [{ parent_id: parentId, child_id: childId }] });
  const results = [], seen = new Set();
  for (const p of approved.parents || []) {
    const email = String(p.email || "").trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    try {
      const existing = await client.call("/rest/v1/rpc/find_user_by_email", { method: "POST", body: { p_email: email } });
      const user = existing && existing[0];
      if (user && user.role === "parent" && user.active) {
        await link(user.id);
        results.push({ email, name: p.full_name, outcome: "linked" });
      } else if (user) {
        results.push({ email, name: p.full_name, outcome: "failed", error: "This email already belongs to a staff or switched-off account." });
      } else {
        await inviteUser({ client, req, env, email, fullName: p.full_name, phone: p.phone, language, role: "parent", after: (id) => link(id) });
        results.push({ email, name: p.full_name, outcome: "invited" });
      }
    } catch (e) {
      results.push({ email, name: p.full_name, outcome: "failed", error: String(e && e.message || "Could not send the invitation").slice(0, 200) });
    }
  }
  return { child_id: childId, results };
});
