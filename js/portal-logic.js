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
      var dayAr = diff === 0 ? "اليوم" : diff === 1 ? "غداً" : diff === -1 ? "أمس" : Math.abs(diff) <= 6 ? weekday : date;
      return dayAr + " الساعة " + time;
    }
    var day = diff === 0 ? "today" : diff === 1 ? "tomorrow" : diff === -1 ? "yesterday" : Math.abs(diff) <= 6 ? weekday : date;
    return day + " at " + time;
  }
  const refLabel = (n) => "CKA-" + String(n).padStart(4, "0");
  // First day of the current month in Cairo, as "YYYY-MM-01" (ratings are once a month per child).
  const monthKey = (nowMs) => cairoDay(new Date(nowMs)).slice(0, 8) + "01";

  // ----- Staff queue -----
  // red = overdue, orange = due within 2 hours, green = on track, done = nothing left to do
  function dueState(nextDueIso, nowMs) {
    if (!nextDueIso) return "done";
    var diff = new Date(nextDueIso).getTime() - nowMs;
    if (diff < 0) return "overdue";
    return diff <= 2 * 3600 * 1000 ? "soon" : "ok";
  }
  var CLOSED = ["resolved", "closed"];
  // Numbers for the manager/owner overview: open items per escalation level, overdue now,
  // and items finished in the last 7 days.
  function overview(rows, nowMs) {
    var out = { byLevel: { 1: 0, 2: 0, 3: 0, 4: 0 }, overdue: 0, closedThisWeek: 0, open: 0 };
    rows.forEach(function (r) {
      if (CLOSED.indexOf(r.status) >= 0) {
        if (r.resolved_at && nowMs - new Date(r.resolved_at).getTime() <= 7 * 86400000) out.closedThisWeek++;
        return;
      }
      out.open++;
      out.byLevel[r.escalation_level] = (out.byLevel[r.escalation_level] || 0) + 1;
      if (dueState(r.next_due, nowMs) === "overdue") out.overdue++;
    });
    return out;
  }
  // Filters for the queue screen. f = { type, urgency, status ("open" | "all" | a status), classId, mine }
  function filterQueue(rows, f, myId) {
    return rows.filter(function (r) {
      if (f.type && r.type !== f.type) return false;
      if (f.urgency && r.urgency !== f.urgency) return false;
      if (f.classId && r.class_id !== f.classId) return false;
      if (f.mine && r.assigned_to !== myId) return false;
      var st = f.status || "open";
      if (st === "open") return CLOSED.indexOf(r.status) < 0;
      return st === "all" ? true : r.status === st;
    });
  }

  // ----- Reports -----
  // Periods are whole days in Cairo time. The academy week starts on Sunday.
  function periodFor(kind, nowMs) {
    var today = cairoDay(new Date(nowMs));
    if (kind === "month") return { from: today.slice(0, 8) + "01", to: today };
    if (kind === "quarter") {                    // the current month and the two before it
      var q = today.split("-").map(Number), d0 = new Date(Date.UTC(q[0], q[1] - 3, 1));
      return { from: d0.toISOString().slice(0, 10), to: today };
    }
    var wd = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(new Date(nowMs));
    var back = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd];
    var p = today.split("-").map(Number);
    return { from: new Date(Date.UTC(p[0], p[1] - 1, p[2] - back)).toISOString().slice(0, 10), to: today };
  }
  function pct(n, d) { return d ? Math.round((n / d) * 100) : null; }
  function change(now, before) {
    if (now == null || before == null) return "";
    return Math.round((Number(now) - Number(before)) * 100) / 100;
  }

  // The report as plain tables, used for BOTH the screen and the CSV so they can never disagree.
  // t(key) returns the wording (English or Arabic); with identity t the keys come back.
  function reportSections(r, t) {
    var ack = r.on_time.acknowledged, res = r.on_time.resolved, tot = r.totals;
    function onTime(x) { var p = pct(x.on_time, x.due); return x.on_time + " / " + x.due + (p === null ? "" : " (" + p + "%)"); }
    var sections = [];
    sections.push({ id: "summary", title: t("rp.summary"), header: [t("rp.metric"), t("rp.value")], rows: [
      [t("rp.received"), tot.received], [t("rp.open_now"), tot.open_now], [t("rp.overdue_now"), tot.overdue_now],
      [t("rp.ack_on_time"), onTime(ack)], [t("rp.res_on_time"), onTime(res)],
      [t("rp.avg_resolve"), r.avg_resolve_hours == null ? "" : r.avg_resolve_hours],
      [t("rp.esc_cases"), r.escalations.cases], [t("rp.esc_moves"), r.escalations.moves],
      [t("rp.sat_yes"), r.satisfaction.yes], [t("rp.sat_no"), r.satisfaction.no], [t("rp.sat_waiting"), r.satisfaction.waiting],
      [t("rp.acc_total"), r.incidents.total], [t("rp.open_inv"), r.incidents.open_investigations],
    ] });
    sections.push({ id: "types", title: t("rp.by_type_urgency"), header: [t("rp.type"), t("rp.urgency"), t("rp.count")],
      rows: r.by_type_urgency.map(function (x) { return [t("rp.type." + x.type), t("rp.urg." + x.urgency), x.count]; }) });
    sections.push({ id: "levels", title: t("rp.esc_by_level"), header: [t("rp.level"), t("rp.count")],
      rows: r.escalations.by_level.map(function (x) { return [t("rp.level") + " " + x.level, x.count]; }) });
    sections.push({ id: "acc_class", title: t("rp.acc_by_class"), header: [t("rp.class"), t("rp.count")], rows: r.incidents.by_class.map(function (x) { return [x.name, x.count]; }) });
    sections.push({ id: "acc_loc", title: t("rp.acc_by_location"), header: [t("rp.location"), t("rp.count")], rows: r.incidents.by_location.map(function (x) { return [x.name, x.count]; }) });
    sections.push({ id: "acc_sev", title: t("rp.acc_by_severity"), header: [t("rp.severity"), t("rp.count")], rows: r.incidents.by_severity.map(function (x) { return [t("rp.sev." + x.name), x.count]; }) });
    sections.push({ id: "ratings", title: t("rp.ratings") + " (" + r.ratings.month.slice(0, 7) + " vs " + r.ratings.previous_month.slice(0, 7) + ")",
      header: [t("rp.class"), t("rp.n"), t("rp.care"), t("rp.comm"), t("rp.daily"), t("rp.prev_n"), t("rp.prev_care"), t("rp.prev_comm"), t("rp.prev_daily"), t("rp.chg_care"), t("rp.chg_comm"), t("rp.chg_daily")],
      rows: r.ratings.classes.map(function (c) {
        return [c.name, c.count, c.care, c.communication, c.daily, c.prev_count, c.prev_care == null ? "" : c.prev_care, c.prev_communication == null ? "" : c.prev_communication, c.prev_daily == null ? "" : c.prev_daily,
          change(c.care, c.prev_care), change(c.communication, c.prev_communication), change(c.daily, c.prev_daily)];
      }) });
    sections.push({ id: "compliments", title: t("rp.compliments"), header: [t("rp.staff"), t("rp.count"), t("rp.messages")],
      rows: r.ratings.compliments.map(function (c) { return [c.staff, c.count, c.items.map(function (i) { return i.text; }).filter(Boolean).join(" | ")]; }) });
    return sections;
  }

  // CSV that opens correctly in Excel. Text that starts with = + - @ is defused so a spreadsheet
  // can never run it as a formula (parents and staff type some of this text).
  function csvCell(v) {
    if (v == null) return "";
    if (typeof v === "number") return String(v);
    var x = String(v);
    if (/^[=+\-@\t\r]/.test(x) && !/^-?\d+(\.\d+)?$/.test(x)) x = "'" + x;
    return /[",\n\r]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x;
  }
  function toCsv(sections) {
    var lines = [];
    sections.forEach(function (sec) {
      lines.push(csvCell(sec.title));
      lines.push(sec.header.map(csvCell).join(","));
      sec.rows.forEach(function (row) { lines.push(row.map(csvCell).join(",")); });
      lines.push("");
    });
    return lines.join("\r\n");
  }

  // ----- Owner dashboard -----
  // A friendly top for a chart axis (1, 2, 5 times a power of ten), never below 4.
  function niceMax(max) {
    max = Math.max(4, Math.ceil(Number(max) || 0));
    var pow = Math.pow(10, Math.floor(Math.log10(max))), f = max / pow;
    var step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return step * pow;
  }
  // Which way a tile moved, and whether that is good news. up/down/same; "bad" for rising problems.
  var HIGHER_IS_GOOD = { happy_comments: true };
  function trend(key, value, previous) {
    var diff = Number(value) - Number(previous);
    var dir = diff > 0 ? "up" : diff < 0 ? "down" : "same";
    var good = dir === "same" ? null : (dir === "up") === !!HIGHER_IS_GOOD[key];
    return { diff: diff, dir: dir, good: good };
  }

  // The owner dashboard as plain tables, used for BOTH the screen and the per-section CSV downloads.
  function ownerSections(d, t) {
    var out = [], tl = d.tiles;
    function tileRow(key, label) { var x = tl[key]; return [label, x.value, x.previous, x.value - x.previous]; }
    out.push({ id: "tiles", title: t("od.tiles"), header: [t("od.measure"), t("od.this_period"), t("od.previous_period"), t("od.change")], rows: [
      tileRow("accidents", t("od.accidents")), tileRow("complaints", t("od.complaints")), tileRow("happy_comments", t("od.happy")),
      tileRow("absence_days", t("od.absence_days")), tileRow("late_minutes", t("od.late_minutes")),
      [t("od.open_hr"), tl.open_hr.value, "", tl.open_hr.opened - tl.open_hr.previous_opened]] });
    out.push({ id: "weekly", title: t("od.weekly"), header: [t("od.week_start"), t("od.accidents"), t("od.complaints"), t("od.happy")],
      rows: d.weekly.map(function (w) { return [w.week_start, w.accidents, w.complaints, w.happy_comments]; }) });
    out.push({ id: "accidents", title: t("od.latest_accidents"), header: [t("od.date"), t("od.child"), t("od.class"), t("od.location"), t("od.severity"), t("od.investigation"), t("od.parent_read"), t("od.note")],
      rows: d.latest_accidents.map(function (a) { return [a.occurred_at.slice(0, 10), a.child, a.class || "", a.location, t("od.sev." + a.severity), a.investigation ? t("od.inv." + a.investigation) : "", a.parent_read ? t("od.yes") : t("od.no"), a.note]; }) });
    out.push({ id: "mistakes", title: t("od.mistakes"), header: [t("od.category"), t("od.critical"), t("od.count")],
      rows: d.mistakes.map(function (m) { return [m.category, m.critical ? t("od.yes") : t("od.no"), m.count]; }) });
    out.push({ id: "staff", title: t("od.staff_table"), header: [t("od.name"), t("od.absence_days"), t("od.late_minutes"), t("od.class_accidents"), t("od.confirmed_faults"), t("od.complaints_about"), t("od.status")],
      rows: d.staff.map(function (x) { return [x.name, x.absence_days, x.late_minutes, x.class_accidents, x.confirmed_faults, x.complaints_about, t("od.status." + x.status)]; }) });
    out.push({ id: "hr", title: t("od.hr_log"), header: [t("od.name"), t("od.type"), t("od.date"), t("od.note"), t("od.follow_up"), t("od.decision")],
      rows: d.hr_log.map(function (h) { return [h.staff, t("od.hr." + h.type), h.date, h.note || "", h.follow_up_date || "", h.awaiting ? t("od.awaiting") : (h.decided_at ? t("od.decided") : "")]; }) });
    out.push({ id: "concerns", title: t("od.staff_concerns"), header: [t("od.date"), t("od.category"), t("od.status"), t("od.raised_by"), t("od.description")],
      rows: d.staff_concerns.recent.map(function (c) { return [c.date, t("od.cat." + c.category), t("od.cstatus." + c.status), c.anonymous ? t("od.anonymous") : (c.raised_by || ""), c.description]; }) });
    out.push({ id: "families", title: t("od.families"), header: [t("od.family"), t("od.complaints"), t("od.happy"), t("od.latest_message")],
      rows: d.families.map(function (f) { return [f.parent, f.complaints, f.happy, f.latest_message || ""]; }) });
    return out;
  }

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  return {
    STAFF_ROLES, ALL_ROLES, INACTIVITY_MS, EMAIL_RE, UUID_RE,
    areaFor, homePath, guard, isExpired,
    canInviteParents, canManageStaff, staffRolesCallerCanCreate, canChangeActive,
    whenText, refLabel, monthKey, dueState, overview, filterQueue,
    periodFor, pct, change, reportSections, csvCell, toCsv,
    niceMax, trend, ownerSections,
  };
});
