// Rules shared by the browser pages and the server functions. Plain functions, no
// dependencies, so they can be tested in Node (see tests/portal-logic.test.mjs).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CKALogic = factory();
})(this, function () {
  const STAFF_ROLES = ["teacher", "admin", "manager", "owner"];
  const ALL_ROLES = ["parent"].concat(STAFF_ROLES);
  const INACTIVITY_MS = 30 * 60 * 1000;

  // Which private area a role belongs to: parents -> /portal, staff -> /staff.
  function areaFor(role) {
    if (role === "parent") return "portal";
    return STAFF_ROLES.indexOf(role) >= 0 ? "staff" : null;
  }

  function homePath(role) {
    const area = areaFor(role);
    return area ? "/" + area + "/" : "/login/";
  }

  // What a page in `area` should do for the signed-in account.
  // `profile` is null when there is no profile row (not invited, or removed).
  function guard(area, profile) {
    if (!profile || !profile.active) return { action: "login" };
    if (areaFor(profile.role) === area) return { action: "stay" };
    return { action: "redirect", to: homePath(profile.role) };
  }

  // A session with no recorded activity is treated as new, not expired.
  function isExpired(lastActiveMs, nowMs, limitMs) {
    if (lastActiveMs == null || isNaN(lastActiveMs)) return false;
    return nowMs - lastActiveMs > (limitMs || INACTIVITY_MS);
  }

  const canInviteParents = (role) => ["admin", "manager", "owner"].indexOf(role) >= 0;
  const canManageStaff = (role) => ["manager", "owner"].indexOf(role) >= 0;

  // Roles a caller may give to a new staff account. Only the owner can create managers or owners,
  // so a manager cannot grant themselves more power than they have.
  function staffRolesCallerCanCreate(callerRole) {
    if (callerRole === "owner") return STAFF_ROLES.slice();
    if (callerRole === "manager") return ["teacher", "admin"];
    return [];
  }

  // May `callerRole` switch `targetRole`'s access on or off? (Never your own: checked separately.)
  function canChangeActive(callerRole, targetRole) {
    if (!canInviteParents(callerRole)) return false;
    if (targetRole === "owner") return callerRole === "owner";
    if (targetRole === "manager") return callerRole === "owner";
    if (targetRole === "admin") return callerRole === "manager" || callerRole === "owner";
    return true; // parent, teacher
  }

  // ----- Dates in plain words, always in Cairo time -----
  const TZ = "Africa/Cairo";
  function cairoDay(d) {        // "2026-10-11"
    return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  }
  function daysBetween(fromKey, toKey) {
    var a = fromKey.split("-").map(Number), b = toKey.split("-").map(Number);
    return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
  }
  // "today at 2:00 pm", "tomorrow at 9:00 am", "Sunday at 2:00 pm", "12 October at 2:00 pm"
  function whenText(iso, nowMs, lang) {
    var d = new Date(iso), loc = lang === "ar" ? "ar-EG" : "en-GB";
    var time = new Intl.DateTimeFormat(loc, { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true }).format(d);
    var diff = daysBetween(cairoDay(new Date(nowMs)), cairoDay(d));
    var weekday = new Intl.DateTimeFormat(loc, { timeZone: TZ, weekday: "long" }).format(d);
    var date = new Intl.DateTimeFormat(loc, { timeZone: TZ, day: "numeric", month: "long" }).format(d);
    if (lang === "ar") {
      var dayAr = diff <= 0 ? "اليوم" : diff === 1 ? "غداً" : diff <= 6 ? weekday : date;
      return dayAr + " الساعة " + time;
    }
    var day = diff <= 0 ? "today" : diff === 1 ? "tomorrow" : diff <= 6 ? weekday : date;
    return day + " at " + time;
  }
  const refLabel = (n) => "CKA-" + String(n).padStart(4, "0");
  // First day of the current month in Cairo, as "YYYY-MM-01" (ratings are once a month per child).
  const monthKey = (nowMs) => cairoDay(new Date(nowMs)).slice(0, 8) + "01";

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  return {
    STAFF_ROLES, ALL_ROLES, INACTIVITY_MS, EMAIL_RE, UUID_RE,
    areaFor, homePath, guard, isExpired,
    canInviteParents, canManageStaff, staffRolesCallerCanCreate, canChangeActive,
    whenText, refLabel, monthKey,
  };
});
