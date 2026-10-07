// Parent portal: Calendar (#/calendar). Month, week and list views of events, closures, holidays and specialist sessions
// meant for the parent's children's classes, the weekly menu (with a warning when a dish contains an allergen for their
// child), and the deadline to answer an event. Parents answer yes or no per child, and can download an .ics file.
// The database only returns what is meant for this parent. Text is only ever inserted as text.
(function () {
  "use strict";
  var P = window.CKAParent, el = CKA.el, t = CKA.t, L = window.CKALogic, client = CKA.client;
  var view = "month", anchor = null, selected = null, flash = null;
  var MEAL_ORDER = ["breakfast", "lunch", "snack"];

  function lang() { return CKA.getLang(); }
  function loc() { return lang() === "ar" ? "ar-EG" : "en-GB"; }
  function pick(en, ar) { var a = lang() === "ar" ? [ar, en] : [en, ar]; return (a[0] && a[0].trim()) ? a[0] : (a[1] || ""); }
  function ymd(d) { return d.toISOString().slice(0, 10); }
  function parse(s) { return new Date(s + "T12:00:00Z"); }
  function addDays(s, n) { var d = parse(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
  function cairoDay(iso) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date(iso)); }
  function hhmm(iso) { return new Intl.DateTimeFormat(loc(), { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)); }
  function dayLabel(s) { return new Intl.DateTimeFormat(loc(), { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(parse(s)); }
  function monthLabel(s) { return new Intl.DateTimeFormat(loc(), { timeZone: "UTC", month: "long", year: "numeric" }).format(parse(s)); }
  function today() { return L.periodFor("week", Date.now()).to; }
  function weekStart(s) { return addDays(s, -parse(s).getUTCDay()); }                       // Sunday first

  function range() {
    if (view === "month") { var first = anchor.slice(0, 8) + "01"; var from = weekStart(first); return { from: from, to: addDays(from, 41) }; }
    if (view === "week") { var f = weekStart(anchor); return { from: f, to: addDays(f, 6) }; }
    return { from: today(), to: addDays(today(), 59) };
  }

  async function page() {
    P.loadingView();
    if (!anchor) anchor = today();
    var r = range();
    var res = await Promise.all([
      client.from("events").select("*").gte("starts_at", addDays(r.from, -3) + "T00:00:00Z").lt("starts_at", addDays(r.to, 2) + "T00:00:00Z").order("starts_at"),
      client.from("event_responses").select("event_id, child_id, answer"),
      client.from("children").select("id, full_name, class_id"),
      client.rpc("menu_week", { p_from: r.from, p_to: r.to > addDays(r.from, 61) ? addDays(r.from, 61) : r.to }),
    ]);
    var events = (res[0].data || []).slice().sort(function (a, b) { return a.starts_at < b.starts_at ? -1 : 1; });
    var answers = {}; (res[1].data || []).forEach(function (a) { answers[a.event_id + ":" + a.child_id] = a.answer; });
    var kids = res[2].data || [], menu = res[3].data || [];

    // items by day
    var by = {};
    function add(day, item) { (by[day] = by[day] || []).push(item); }
    events.forEach(function (e) {
      var s = cairoDay(e.starts_at), en = e.ends_at ? cairoDay(e.ends_at) : s;
      for (var d = s, n = 0; d <= en && n < 31; d = addDays(d, 1), n++) add(d, { type: "event", e: e });
      if (e.needs_approval && e.approval_deadline) add(cairoDay(e.approval_deadline), { type: "deadline", e: e });
    });
    menu.forEach(function (m) { add(m.menu_date, { type: "menu", m: m }); });

    var nodes = [];
    if (flash) { nodes.push(P.note(flash.kind, flash.text)); flash = null; }
    nodes.push(controls());
    var ctx = { by: by, kids: kids, answers: answers };
    if (view === "month") { nodes.push(P.card([monthGrid(ctx)])); nodes.push(dayDetails(ctx, selected || today())); }
    else if (view === "week") { var f = weekStart(anchor); for (var i = 0; i < 7; i++) nodes.push(dayDetails(ctx, addDays(f, i), true)); }
    else {
      var any = false;
      for (var j = 0; j < 60; j++) { var dd = addDays(today(), j); if ((by[dd] || []).some(function (x) { return x.type !== "menu"; })) { any = true; nodes.push(dayDetails(ctx, dd, true, true)); } }
      if (!any) nodes.push(P.card([el("p", { class: "p-sub", text: t("cal.nothing_list") })]));
    }
    P.show(nodes);
  }

  function controls() {
    var bar = el("div", { class: "actions" });
    [["month", "cal.month"], ["week", "cal.week"], ["list", "cal.list"]].forEach(function (o) {
      var b = el("button", { type: "button", class: "filter-pill" + (view === o[0] ? " active" : ""), text: t(o[1]) });
      b.addEventListener("click", function () { view = o[0]; page(); });
      bar.appendChild(b);
    });
    var nav = el("div", { class: "actions" });
    function step(n) {
      return function () {
        if (view === "month") { var d = parse(anchor.slice(0, 8) + "01"); d.setUTCMonth(d.getUTCMonth() + n); anchor = ymd(d); }
        else anchor = addDays(anchor, 7 * n);
        selected = null; page();
      };
    }
    var prev = el("button", { type: "button", class: "btn btn-outline btn-small", text: "‹ " + t("cal.prev") }), next = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("cal.next") + " ›" });
    var now = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("cal.today") });
    prev.addEventListener("click", step(-1)); next.addEventListener("click", step(1)); now.addEventListener("click", function () { anchor = today(); selected = today(); page(); });
    if (view !== "list") nav.appendChild(prev), nav.appendChild(now), nav.appendChild(next);
    return P.card([el("h1", { text: t("cal.title") }), bar, view === "month" ? el("h2", { text: monthLabel(anchor) }) : null, nav].filter(Boolean));
  }

  function monthGrid(ctx) {
    var grid = el("div", { class: "cal-grid", role: "grid" });
    t("cal.days").split(",").forEach(function (n) { grid.appendChild(el("div", { class: "cal-head", text: n.slice(0, 3) })); });
    var r = range(), cur = anchor.slice(0, 7), tod = today();
    for (var d = r.from; d <= r.to; d = addDays(d, 1)) {
      var items = ctx.by[d] || [], kinds = {};
      items.forEach(function (x) { kinds[x.type === "event" ? x.e.kind : x.type] = true; });
      var cell = el("button", { type: "button", class: "cal-cell" + (d.slice(0, 7) !== cur ? " out" : "") + (d === tod ? " today" : "") + (d === (selected || tod) ? " sel" : ""), "aria-label": dayLabel(d) },
        [el("span", { text: String(Number(d.slice(8))) }), el("span", { class: "cal-dots" }, Object.keys(kinds).map(function (k) { return el("i", { class: "dot-" + k }); }))]);
      cell.addEventListener("click", (function (day) { return function () { selected = day; page(); }; })(d));
      grid.appendChild(cell);
    }
    return grid;
  }

  function dayDetails(ctx, day, compact, skipMenu) {
    var items = ctx.by[day] || [], kids = [el("h2", { text: dayLabel(day) })];
    var evs = items.filter(function (x) { return x.type === "event"; }), dls = items.filter(function (x) { return x.type === "deadline"; });
    var menu = skipMenu ? [] : items.filter(function (x) { return x.type === "menu"; }).map(function (x) { return x.m; });
    if (!evs.length && !dls.length && !menu.length) { if (compact) return P.card([el("h2", { text: dayLabel(day) }), el("p", { class: "p-sub", text: t("cal.nothing") })]); kids.push(el("p", { class: "p-sub", text: t("cal.nothing") })); }
    evs.forEach(function (x) { kids.push(eventCard(ctx, x.e)); });
    dls.forEach(function (x) { kids.push(el("div", { class: "note info", text: "⏰ " + t("cal.k.deadline") + ": " + pick(x.e.title_en, x.e.title_ar) })); });
    if (menu.length) {
      kids.push(el("h3", { text: "🍽 " + t("cal.menu") }));
      menu.sort(function (a, b) { return MEAL_ORDER.indexOf(a.meal) - MEAL_ORDER.indexOf(b.meal); }).forEach(function (m) {
        kids.push(el("div", { class: "kv" }, [el("span", { class: "k", text: t("cal.m." + m.meal) }), el("strong", { text: pick(m.dish_en, m.dish_ar) }),
          (m.affected && m.affected.length) ? el("span", { class: "att-msg bad", text: "⚠ " + t("cal.allergy") + " " + m.affected.join(", ") }) : null].filter(Boolean)));
      });
    }
    return P.card(kids);
  }

  function eventCard(ctx, e) {
    var time = e.all_day ? t("cal.all_day") : hhmm(e.starts_at) + (e.ends_at ? " – " + hhmm(e.ends_at) : "");
    var kids = [el("div", { class: "case-top" }, [P.pill(t("cal.k." + e.kind), e.kind === "closure" ? "urg-critical" : e.kind === "event" ? "urg-urgent" : ""), el("strong", { text: pick(e.title_en, e.title_ar) })]),
      el("div", { class: "p-who", text: time + (e.audience === "class" ? " · " + t("cal.class") : "") })];
    if (e.place) kids.push(el("div", { text: "📍 " + t("cal.place") + ": " + e.place }));
    if (e.cost != null) kids.push(el("div", { text: "💰 " + t("cal.cost") + ": " + e.cost + " " + t("cal.egp") }));
    var det = pick(e.details_en, e.details_ar); if (det) kids.push(el("p", { class: "preline", text: det }));
    if (e.needs_approval) kids.push(approval(ctx, e));
    var ics = el("button", { type: "button", class: "btn btn-outline btn-small", text: "📅 " + t("cal.ics") });
    ics.addEventListener("click", function () { downloadIcs(e); });
    kids.push(el("div", { class: "actions" }, [ics]));
    return el("div", { class: "action" }, kids);
  }

  function approval(ctx, e) {
    var box = el("div", { class: "internal-box" }, [el("strong", { text: t("cal.approve") + " · " + t("cal.deadline") + " " + new Intl.DateTimeFormat(loc(), { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" }).format(new Date(e.approval_deadline)) })]);
    var open = Date.now() < new Date(e.approval_deadline).getTime();
    ctx.kids.filter(function (k) { return e.audience === "all" || k.class_id === e.class_id; }).forEach(function (k) {
      var a = ctx.answers[e.id + ":" + k.id];
      var row = el("div", { class: "check-row" }, [el("div", { class: "check-label", text: k.full_name }), el("div", { class: "p-who", text: a === "yes" ? "✓ " + t("cal.answered_yes") : a === "no" ? "✗ " + t("cal.answered_no") : t("cal.not_answered") })]);
      if (open) {
        var y = el("button", { type: "button", class: "btn " + (a === "yes" ? "btn-pink" : "btn-outline") + " btn-small", text: t("cal.yes") }), n = el("button", { type: "button", class: "btn " + (a === "no" ? "btn-pink" : "btn-outline") + " btn-small", text: t("cal.no") });
        [[y, "yes"], [n, "no"]].forEach(function (p) {
          p[0].addEventListener("click", async function () {
            y.disabled = n.disabled = true;
            var r = await client.rpc("event_respond", { p_event: e.id, p_child: k.id, p_answer: p[1] });
            flash = r.error ? { kind: "err", text: t("cal.err") } : { kind: "ok", text: t("cal.saved") }; page();
          });
        });
        row.appendChild(el("div", { class: "actions" }, [y, n]));
      } else if (a == null) row.appendChild(el("div", { class: "p-who", text: t("cal.closed_answers") }));
      box.appendChild(row);
    });
    return box;
  }

  function icsDate(iso) { return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); }
  function icsEsc(s) { return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n"); }
  function downloadIcs(e) {
    var lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Cute Kids Academy//Portal//EN", "BEGIN:VEVENT", "UID:" + e.id + "@cutekidsacademy", "DTSTAMP:" + icsDate(new Date().toISOString())];
    if (e.all_day) { var s = cairoDay(e.starts_at), en = addDays(e.ends_at ? cairoDay(e.ends_at) : s, 1); lines.push("DTSTART;VALUE=DATE:" + s.replace(/-/g, ""), "DTEND;VALUE=DATE:" + en.replace(/-/g, "")); }
    else lines.push("DTSTART:" + icsDate(e.starts_at), "DTEND:" + icsDate(e.ends_at || new Date(new Date(e.starts_at).getTime() + 3600000).toISOString()));
    lines.push("SUMMARY:" + icsEsc(pick(e.title_en, e.title_ar)));
    if (e.place) lines.push("LOCATION:" + icsEsc(e.place));
    var d = pick(e.details_en, e.details_ar); if (d) lines.push("DESCRIPTION:" + icsEsc(d));
    lines.push("END:VEVENT", "END:VCALENDAR");
    var a = el("a", { href: URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" })), download: "event.ics" });
    document.body.appendChild(a); a.click(); a.remove();
  }

  P.routes.calendar = page;
})();
