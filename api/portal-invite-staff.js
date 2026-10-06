// POST /api/portal-invite-staff
// Manager or owner creates a staff login with a role and classes. Only the owner can create
// managers or owners.
// Body: { email, full_name, phone?, language, role: "teacher"|"admin"|"manager"|"owner", class_ids?: [uuid] }
const { L, HttpError, endpoint, cleanText, inviteUser } = require("./_lib/portal.js");

module.exports = endpoint(async ({ req, body, client, caller, env }) => {
  if (!L.canManageStaff(caller.role)) throw new HttpError(403, "Only the manager or owner can add staff.");

  const email = cleanText(body.email, 254).toLowerCase();
  const fullName = cleanText(body.full_name, 120);
  const phone = cleanText(body.phone, 30);
  const language = body.language === "en" ? "en" : "ar";
  const role = body.role;
  const classIds = Array.isArray(body.class_ids) ? Array.from(new Set(body.class_ids)) : [];

  if (!L.EMAIL_RE.test(email)) throw new HttpError(400, "Please enter a valid email address.");
  if (!fullName) throw new HttpError(400, "Please enter the staff member's name.");
  if (!L.staffRolesCallerCanCreate(caller.role).includes(role)) {
    throw new HttpError(403, "You are not allowed to create that kind of account.");
  }
  if (classIds.length > 20 || !classIds.every((id) => L.UUID_RE.test(id))) throw new HttpError(400, "Invalid class selection.");
  if (classIds.length) {
    const found = await client.call(`/rest/v1/classes?id=in.(${classIds.join(",")})&select=id`);
    if (!found || found.length !== classIds.length) throw new HttpError(400, "One of the chosen classes was not found.");
  }

  const userId = await inviteUser({
    client, req, env, email, fullName, phone, language, role,
    after: classIds.length
      ? (id) => client.call("/rest/v1/staff_classes", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: classIds.map((class_id) => ({ staff_id: id, class_id })),
        })
      : null,
  });
  return { user_id: userId };
});
