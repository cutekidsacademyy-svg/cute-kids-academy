// Parent portal: the home dashboard (#/) and the "More" page (#/more). One screen with what matters today for each child:
// whether they have arrived, today's report, this month at a glance, today's schedule, the latest photos, what is coming up,
// news, events waiting for an answer, and open cases; plus four quick buttons. Everything is read through the database, which
// only returns the parent's own family. Text is only ever inserted as text.
(function () {
  "use strict";
  var P = window.CKAParent, el = CKA.el, t = CKA.t, L = window.CKALogic, client = CKA.client;

  function lang() { return CKA.getLang(); }
  function loc() { return lang() === "ar" ? "ar-EG" : "en-GB"; }
  function pick(en, ar) { var a = lang() === "ar" ? [ar, en] : [en, ar]; return (a[0] && a[0].trim()) ? a[0] : (a[1] || ""); }
  function hhmm(iso) { return new Intl.DateTimeFormat(loc(), { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)); }
  function dayText(iso) { return new Intl.DateTimeFormat(loc(), { timeZone: "Africa/Cairo", weekday: "short", day: "numeric", month: "short" }).format(new Date(iso)); }
  function today() { return L.periodFor("week", Date.now()).to; }
  function tile(n, label, cls) { return el("div", { class: "tile " + (cls || "") }, [el("strong", { text: String(n) }), el("span", { text: label })]); }
  function big(href, icon, text, cls) { return el("a", { class: "btn " + (cls || "btn-outline") + " btn-block", href: href, text: icon + " " + text }); }

  async function home() {
    P.loadingView();
    var day = today(), kidsBase = P.children();
    var res = await Promise.all([
      client.from("children").select("id, full_name, class_id, classes(name)").order("full_name"),
      client.from("attendance").select("child_id, checked_in_at, checked_out_at, collector_name").eq("att_date", day),
      client.from("attendance_notices").select("child_id, kind, expected_arrival").eq("notice_date", day),
      client.from("daily_reports").select("child_id").eq("report_date", day),
      client.from("schedule_items").select("class_id, start_time, title_en, title_ar").order("start_time"),
      client.from("events").select("*").gte("starts_at", new Date().toISOString()).order("starts_at").limit(30),
      client.from("event_responses").select("event_id, child_id"),
      client.from("announcements").select("id, important"), client.from("announcement_reads").select("announcement_id"),
      client.rpc("parent_cases"), client.rpc("parent_incidents"),
    ]);
    var kids = res[0].data && res[0].data.length ? res[0].data : kidsBase;
    var att = {}; (res[1].data || []).forEach(function (a) { att[a.child_id] = a; });
    var notice = {}; (res[2].data || []).forEach(function (n) { notice[n.child_id] = n; });
    var sentReport = {}; (res[3].data || []).forEach(function (r) { sentReport[r.child_id] = true; });
    var sched = res[4].data || [];
    var events = (res[5].data || []).slice().sort(function (a, b) { return a.starts_at < b.starts_at ? -1 : 1; });
    var answered = {}; (res[6].data || []).forEach(function (r) { answered[r.event_id + ":" + r.child_id] = true; });
    var reads = {}; (res[8].data || []).forEach(function (r) { reads[r.announcement_id] = true; });
    var anns = res[7].data || [], unread = anns.filter(function (a) { return !reads[a.id]; });
    var cases = (res[9].data || []).filter(function (c) { return c.status !== "closed"; });
    var unreadAcc = (res[10].data || []).filter(function (i) { return !i.parent_signed_at; }).length;

    var nodes = [];
    // quick buttons
    nodes.push(P.card([el("h1", { text: CKA.greeting(P.profile().full_name) }),
      el("div", { class: "quick" }, [big("#/ask", "❓", t("hm.q_ask"), "btn-pink"), big("#/attendance", "🏠", t("hm.q_absence")), big("#/ask/missing", "🔍", t("hm.q_missing")), big("#/payments", "💳", t("hm.q_pay"))]),
      el("p", { style: "margin-top:10px" }, [P.link("#/new", t("hm.q_concern"))])]));

    // one card per child
    kids.forEach(function (k) {
      var a = att[k.id], n = notice[k.id], status = a ? (a.checked_out_at ? t("hm.out_at") + " " + hhmm(a.checked_out_at) + (a.collector_name ? " " + t("hm.by") + " " + a.collector_name : "") : t("hm.in_at") + " " + hhmm(a.checked_in_at)) : t("hm.not_arrived");
      var lines = [el("div", { class: "case-top" }, [el("h2", { text: k.full_name }), k.classes ? P.pill(k.classes.name) : null].filter(Boolean)), el("p", { class: "promise-big", text: t("hm.child_status") + ": " + status })];
      if (n && !a) lines.push(el("div", { class: "note info", text: n.kind === "absence" ? t("hm.told_absent") : t("hm.told_late") + (n.expected_arrival ? " (" + String(n.expected_arrival).slice(0, 5) + ")" : "") }));
      if (sentReport[k.id]) lines.push(el("div", { class: "actions" }, [el("span", { class: "att-msg ok", text: "✓ " + t("hm.report_ready") }), P.link("#/daily", t("hm.report_open"), "btn btn-pink btn-small")]));
      else lines.push(el("p", { class: "p-sub", text: a ? t("hm.report_coming") : t("hm.report_none") }));
      var glance = el("div", { class: "tiles" }); lines.push(el("h3", { text: t("hm.month") }), glance);
      client.rpc("parent_month_summary", { p_child: k.id }).then(function (r) {
        if (!r.data) return;
        [[r.data.attended, "hm.attended", "good"], [r.data.absent_reported, "hm.absent_told", ""], [r.data.absent_unreported, "hm.absent_not", r.data.absent_unreported ? "bad" : ""], [r.data.late_pickups, "hm.late", ""]].forEach(function (x) { glance.appendChild(tile(x[0], t(x[1]), x[2])); });
      });
      var mine = sched.filter(function (s) { return s.class_id === null || s.class_id === k.class_id; });
      if (mine.length) lines.push(el("h3", { text: t("hm.schedule") }), el("div", {}, mine.map(function (s) { return el("div", { class: "kv" }, [el("strong", { text: String(s.start_time).slice(0, 5) + " · " + pick(s.title_en, s.title_ar) })]); })));
      nodes.push(P.card(lines, "blue"));
    });

    // events waiting for an answer
    var waiting = [];
    events.forEach(function (e) { if (e.needs_approval && Date.now() < new Date(e.approval_deadline).getTime()) kids.forEach(function (k) { if ((e.audience === "all" || e.class_id === k.class_id) && !answered[e.id + ":" + k.id]) waiting.push({ e: e, k: k }); }); });
    if (waiting.length) nodes.push(P.card([el("h2", { text: "⏰ " + t("hm.waiting") })].concat(waiting.slice(0, 4).map(function (w) {
      return el("a", { class: "case-item", href: "#/calendar" }, [el("strong", { text: pick(w.e.title_en, w.e.title_ar) + " · " + w.k.full_name }), el("small", { text: t("hm.answer_by") + " " + dayText(w.e.approval_deadline) })]);
    }))));

    // kindly send for tomorrow (set by the teachers)
    var extras = await Promise.all(P.homeCards.map(function (f) { return Promise.resolve().then(f).catch(function () { return null; }); }));
    extras.filter(Boolean).forEach(function (x) { nodes.push(x); });

    // photos
    var photoBox = el("div", { class: "photos" });
    nodes.push(P.card([el("h2", { text: t("hm.photos") }), photoBox, P.link("#/photos", t("hm.all_photos"))]));
    if (P.latestPhotos) P.latestPhotos(6).then(function (list) { list.forEach(function (p) { photoBox.appendChild(el("a", { href: "#/photos" }, [el("img", { src: p.url, alt: "" })])); }); if (!list.length) photoBox.parentNode.hidden = true; }).catch(function () { photoBox.parentNode.hidden = true; });

    // next three calendar items, and the news
    var up = events.slice(0, 3);
    nodes.push(P.card([el("h2", { text: t("hm.coming_up") })].concat(up.length ? up.map(function (e) {
      return el("a", { class: "case-item", href: "#/calendar" }, [el("div", { class: "case-top" }, [P.pill(t("cal.k." + e.kind), e.kind === "closure" ? "urg-critical" : ""), el("strong", { text: pick(e.title_en, e.title_ar) })]), el("small", { text: dayText(e.starts_at) })]);
    }) : [el("p", { class: "p-sub", text: t("hm.nothing_coming") })]).concat([P.link("#/calendar", t("hm.all_calendar"))])));
    nodes.push(P.card([el("h2", { text: t("hm.news") + (unread.length ? " · " + unread.length + " " + t("hm.unread") : "") }), unread.length ? el("a", { class: "btn btn-outline btn-small", href: "#/news", text: t("hm.open_news") }) : el("p", { class: "p-sub", text: t("hm.news_none") })]));

    // open cases and accident reports
    nodes.push(P.card([el("h2", { text: t("hm.cases") })].concat(cases.length ? cases.map(P.caseItem) : [el("p", { class: "p-sub", text: t("hm.no_cases") })])
      .concat(unreadAcc ? [P.link("#/reports", "⚠ " + t("hm.accidents") + ": " + unreadAcc + " " + t("hm.accidents_unread"), "btn btn-outline btn-small")] : [])));
    P.show(nodes);
  }

  // ------------------------------------------------------------------ More
  function more() {
    var items = [["#/attendance", "🏠", "mo.attendance"], ["#/child", "🧒", "mo.child"], ["#/payments", "💳", "mo.payments"], ["#/messages", "✉", "mo.messages"], ["#/transport", "🚌", "mo.transport"],["#/news", "📰", "mo.news"],["#/reports", "⚠", "mo.accidents"], ["#/ask", "❓", "mo.ask"], ["#/new", "📝", "mo.concern"], ["#/rate", "⭐", "mo.rate"], ["#/settings", "⚙", "mo.settings"]];
    P.show([P.card([el("h1", { text: t("mo.title") })].concat(items.map(function (x) { return el("a", { class: "case-item", href: x[0], text: x[1] + "  " + t(x[2]) }); })))]);
  }

  P.routes.home = home;
  P.routes.more = more;
})();
