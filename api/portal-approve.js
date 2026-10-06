// POST /api/portal-approve
// Admin, manager or owner approves a registration: the database creates the child in the chosen class
// (and checks the caller's role itself), then this function invites the parents to the portal and links
// them to the child. A parent who already has a login (a second child) is linked, not invited again.
// Body: { application_id, class_id }   or   { application_id, retry: true } to try the invitations again
const crypto = require("crypto");
const { L, HttpError, endpoint, inviteUser } = require("./_lib/portal.js");

// The ID photos of the pickup people arrive in the private "registrations" bucket (only management can open it).
// Once the child exists they move to the child's own folder, so the parents and the door staff can open them.
// Returns how many could not be moved (the approval still stands; trying again later moves the rest).
async function moveIdPhotos(client, childId) {
  let failed = 0;
  try {
    const rows = await client.call(`/rest/v1/child_pickups?child_id=eq.${childId}&id_photo_path=like.drafts/*&select=id,id_photo_path`);
    for (const r of rows || []) {
      try {
        const ext = (String(r.id_photo_path).split(".").pop() || "jpg").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "jpg";
        const dest = `${childId}/pickups/${crypto.randomUUID()}.${ext}`;
        await client.call("/storage/v1/object/copy", { method: "POST", body: { bucketId: "registrations", sourceKey: r.id_photo_path, destinationBucket: "child-files", destinationKey: dest } });
        await client.call(`/rest/v1/child_pickups?id=eq.${r.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { id_photo_path: dest } });
      } catch (e) { failed++; }
    }
  } catch (e) { failed++; }
  return failed;
}

module.exports = endpoint(async ({ req, body, client, caller, env }) => {
  if (!L.canInviteParents(caller.role)) throw new HttpError(403, "You are not allowed to approve applications.");
  if (!L.UUID_RE.test(String(body.application_id || "")) || (body.retry !== true && !L.UUID_RE.test(String(body.class_id || "")))) throw new HttpError(400, "Please choose a class.");

  // 1. Approve in the database AS THE CALLER, so the database enforces who may do this.
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || req.headers.Authorization || "")[1];
  //    With retry:true the application is already approved: only the invitations that failed are tried again.
  let approved;
  if (body.retry === true) {
    const a = await client.call("/rest/v1/rpc/registration_get", { method: "POST", token, body: { p_id: body.application_id } });
    if (!a || a.status !== "approved" || !a.child_id) throw new HttpError(400, "This application has not been approved yet.");
    approved = { child_id: a.child_id, language: a.language, parents: a.parents };
  } else {
    approved = await client.call("/rest/v1/rpc/approve_registration", { method: "POST", token, body: { p_id: body.application_id, p_class: body.class_id } });
  }
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
  const photoFailures = await moveIdPhotos(client, childId);
  return { child_id: childId, results, photo_failures: photoFailures };
});
