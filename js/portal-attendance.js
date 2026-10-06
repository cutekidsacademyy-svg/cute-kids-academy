// Parent portal: Attendance (#/attendance). The parent sees their child's check-in and check-out times, who collected
// them, and any overtime; and can tell the academy about an absence or a late arrival (today before 8:00 am, or any
// later school day). The database enforces the 8:00 am rule and that the child is the parent's own.
// Text is only ever inserted as text.
(function () {
  "use strict";
  var P = window.CKAParent, el = CKA.el, t = CKA.t, L = window.CKALogic, client = CKA.client;
  var chosen = null, flash = null;

  function lang() { return CKA.getLang(); }
  function loc() { return lang() === "ar" ? "ar-EG" : "en-GB"; }
  function hhmm(iso) { return new Intl.DateTimeFormat(loc(), { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)); }
  function dayText(ymd) { return new Intl.DateTimeFormat(loc(), { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(ymd + "T12:00:00Z")); }
  function today() { return L.periodFor("week", Date.now()).to; }
  function cairoMinutes() {
    var p = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()).split(":");
    return Number(p[0]) * 60 + Number(p[1]);
  }
  function addDays(ymd, n) { var d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function isSchoolDay(ymd) { var w = new Date(ymd + "T12:00:00Z").getUTCDay(); return w >= 0 && w <= 4; }          // Sunday to Thursday
  function suggestedDay() {
    var d = today();
    if (isSchoolDay(d) && cairoMinutes() < 480) return d;
    d = addDays(d, 1); while (!isSchoolDay(d)) d = addDays(d, 1);
    return d;
  }
  function input(type, attrs) { return el("input", Object.assign({ type: type, id: "f" + Math.random().toString(36).slice(2, 8) }, attrs || {})); }
  function row(label, control) { return P.field(label, control, control.id); }

  async function page() {
    P.loadingView();
    var kids = P.children(), nodes = [];
    if (flash) { nodes.push(P.note("ok", flash)); flash = null; }
    nodes.push(P.card([el("h1", { text: t("pa.title") })]));
    if (!kids.length) { P.show(nodes); return; }
    if (!chosen || !kids.some(function (k) { return k.id === chosen; })) chosen = kids[0].id;
    if (kids.length > 1) {
      var bar = el("div", { class: "actions" });
      kids.forEach(function (k) {
        var b = el("button", { type: "button", class: "filter-pill" + (k.id === chosen ? " active" : ""), text: k.full_name });
        b.addEventListener("click", function () { chosen = k.id; page(); });
        bar.appendChild(b);
      });
      nodes.push(P.card([el("h2", { text: t("pa.pick") }), bar]));
    }
    var kid = kids.filter(function (k) { return k.id === chosen; })[0], day = today();
    var from = addDays(day, -30);
    var res = await Promise.all([
      client.from("attendance").select("att_date, checked_in_at, checked_out_at, collector_name, off_list, overtime_minutes").eq("child_id", kid.id).gte("att_date", from).order("att_date", { ascending: false }),
      client.from("attendance_notices").select("id, notice_date, kind, expected_arrival, reason").eq("child_id", kid.id).gte("notice_date", day).order("notice_date"),
    ]);
    var hist = res[0].data || [], notices = res[1].data || [];
    var todayRow = hist.filter(function (h) { return h.att_date === day; })[0];

    var status = !todayRow ? t("pa.not_in") : todayRow.checked_out_at
      ? t("pa.out_at") + " " + hhmm(todayRow.checked_out_at) + (todayRow.collector_name ? " " + t("pa.by") + " " + todayRow.collector_name : "")
      : t("pa.in_at") + " " + hhmm(todayRow.checked_in_at);
    nodes.push(P.card([el("h2", { text: kid.full_name + " · " + t("pa.today") }), el("p", { class: "promise-big", text: status }),
      todayRow && todayRow.off_list ? el("div", { class: "call-box" }, [el("p", { text: "⚠ " + t("pa.off_list") }), el("a", { class: "btn btn-pink", href: "tel:" + P.phone().replace(/\s+/g, ""), text: "📞 " + P.phone() })]) : null].filter(Boolean), "blue"));

    nodes.push(reportCard(kid));
    nodes.push(P.card([el("h2", { text: t("pa.upcoming") })].concat(notices.length ? notices.map(function (n) { return noticeRow(kid, n); }) : [el("p", { class: "p-sub", text: t("pa.none_upcoming") })])));
    nodes.push(historyCard(hist));
    P.show(nodes);
  }

  function reportCard(kid) {
    var kind = "absence";
    var date = input("date", { min: today() }); date.value = suggestedDay();
    var arrival = input("time", { min: "08:00", max: "18:00" });
    var arrivalRow = row(t("pa.arrival"), arrival); arrivalRow.classList.add("hidden");
    var reason = input("text", { maxlength: "500" });
    var msg = el("div", {});
    var radios = el("div", {});
    [["absence", "pa.absence"], ["late", "pa.late"]].forEach(function (o) {
      var r = el("input", { type: "radio", name: "kind", value: o[0] }); r.checked = o[0] === kind;
      r.addEventListener("change", function () { kind = o[0]; arrivalRow.classList.toggle("hidden", kind !== "late"); });
      radios.appendChild(el("label", { class: "choice" }, [r, el("span", { text: t(o[1]) })]));
    });
    var send = el("button", { type: "button", class: "btn btn-pink", text: t("pa.send") });
    send.addEventListener("click", async function () {
      msg.textContent = "";
      if (!date.value) { msg.appendChild(P.note("err", t("pa.need_date"))); return; }
      if (!isSchoolDay(date.value)) { msg.appendChild(P.note("err", t("pa.closed"))); return; }
      if (reason.value.trim().length < 2) { msg.appendChild(P.note("err", t("pa.need_reason"))); return; }
      send.disabled = true;
      var r = await client.rpc("parent_report_attendance", { p_child: kid.id, p_date: date.value, p_kind: kind, p_reason: reason.value, p_arrival: kind === "late" && arrival.value ? arrival.value : null });
      send.disabled = false;
      if (r.error) {
        if (/too_late_today/.test(r.error.message)) msg.appendChild(el("div", { class: "call-box" }, [el("p", { text: t("pa.too_late") + " " + P.phone() }), el("a", { class: "btn btn-pink", href: "tel:" + P.phone().replace(/\s+/g, ""), text: "📞 " + P.phone() })]));
        else msg.appendChild(P.note("err", t("pa.err")));
        return;
      }
      flash = t("pa.sent"); page();
    });
    return P.card([el("h2", { text: t("pa.report") }), el("p", { class: "p-sub", text: t("pa.rule") }), el("div", { class: "f-row" }, [el("label", { text: t("pa.kind") }), radios]),
      row(t("pa.date"), date), arrivalRow, row(t("pa.reason"), reason), msg, send]);
  }

  function noticeRow(kid, n) {
    var cancel = el("button", { type: "button", class: "p-link", text: t("pa.cancel") });
    cancel.addEventListener("click", async function () {
      cancel.disabled = true;
      var r = await client.rpc("parent_cancel_attendance_notice", { p_child: kid.id, p_date: n.notice_date });
      if (r.error) { cancel.disabled = false; return; }
      flash = t("pa.cancelled"); page();
    });
    return el("div", { class: "kv" }, [el("strong", { text: dayText(n.notice_date) + " · " + t("pa.n." + n.kind) + (n.expected_arrival ? " · " + t("pa.expected") + " " + String(n.expected_arrival).slice(0, 5) : "") }),
      el("span", { class: "preline", text: n.reason }), cancel]);
  }

  function historyCard(hist) {
    var head = el("tr", {}, [t("pa.col_day"), t("pa.col_in"), t("pa.col_out"), t("pa.col_who")].map(function (h) { return el("th", { text: h }); }));
    var body = hist.length ? hist.map(function (h) {
      return el("tr", { class: h.off_list ? "overdue" : "" }, [el("td", { text: dayText(h.att_date) }), el("td", { text: hhmm(h.checked_in_at) }), el("td", { text: h.checked_out_at ? hhmm(h.checked_out_at) : "—" }),
        el("td", { text: (h.collector_name || "—") + (h.off_list ? " ⚠" : "") + (h.overtime_minutes > 0 ? " · " + t("pa.overtime") + " " + h.overtime_minutes + " " + t("pa.min") : "") })]);
    }) : [el("tr", {}, [el("td", { colspan: "4", class: "p-sub", text: t("pa.none_history") })])];
    return P.card([el("h2", { text: t("pa.history") }), el("div", { class: "tbl-wrap" }, [el("table", { class: "tbl" }, [el("thead", {}, [head]), el("tbody", {}, body)])])]);
  }

  P.routes.attendance = page;
})();
