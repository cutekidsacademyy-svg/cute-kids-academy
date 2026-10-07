// POST /api/portal-invite-staff
// Manager or owner creates a staff login with a role and classes. Only the owner can create
// managers or owners.
// Body: { email, full_name, phone?, language, role: "teacher"|"admin"|"manager"|"owner"|"finance", job_title?, class_ids?: [uuid] }
// job_title must fit the role: teacher (teacher, co_teacher, assistant) or finance (finance_assistant, finance_manager).
const { L, HttpError, endpoint, cleanText, inviteUser } = require("./_lib/portal.js");

module.exports = endpoint(async ({ req, body, client, caller, env }) => {
  if (!L.canManageStaff(caller.role)) throw new HttpError(403, "Only the manager or owner can add staff.");

  const email = cleanText(body.email, 254).toLowerCase();
  const fullName = cleanText(body.full_name, 120);
  const phone = cleanText(body.phone, 30);
  const language = body.language === "en" ? "en" : "ar";
  const role = body.role;
  const TITLES = { teacher: ["teacher", "co_teacher", "assistant"], finance: ["finance_assistant", "finance_manager"], admin: ["admin"], manager: ["manager"], owner: ["owner"] };
  const jobTitle = body.job_title == null || body.job_title === "" ? (TITLES[role] || [null])[0] : body.job_title;
  const classIds = Array.isArray(body.class_ids) ? Array.from(new Set(body.class_ids)) : [];

  if (!L.EMAIL_RE.test(email)) throw new HttpError(400, "Please enter a valid email address.");
  if (!fullName) throw new HttpError(400, "Please enter the staff member's name.");
  if (!L.staffRolesCallerCanCreate(caller.role).includes(role)) {
    throw new HttpError(403, "You are not allowed to create that kind of account.");
  }
  if (!(TITLES[role] || []).includes(jobTitle)) throw new HttpError(400, "That job title does not fit this role.");
  if (classIds.length > 20 || !classIds.every((id) => L.UUID_RE.test(id))) throw new HttpError(400, "Invalid class selection.");
  if (classIds.length) {
    const found = await client.call(`/rest/v1/classes?id=in.(${classIds.join(",")})&select=id`);
    if (!found || found.length !== classIds.length) throw new HttpError(400, "One of the chosen classes was not found.");
  }

  const userId = await inviteUser({
    client, req, env, email, fullName, phone, language, role,
    after: async (id) => {
      await client.call(`/rest/v1/profiles?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { job_title: jobTitle } });
      if (classIds.length) {
        await client.call("/rest/v1/staff_classes", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: classIds.map((class_id) => ({ staff_id: id, class_id, class_role: role === "teacher" && jobTitle !== "teacher" ? jobTitle : "teacher" })),
        });
      }
    },
  });
  return { user_id: userId };
});
