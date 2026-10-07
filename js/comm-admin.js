// Staff (admin, manager, owner): announcements (#/announcements), the weekly menu and class schedule (#/menu), and the
// calendar of events, closures, holidays and sessions with parents' approvals (#/events).
// The database decides who may do what; this page only shows what it is given. Text is only ever inserted as text.
(function () {
  "use strict";
  var S = window.CKAStaff, el = CKA.el, t = CKA.t, L = window.CKALogic, client = CKA.client;
  var ALLERGENS = ["peanuts", "tree_nuts", "milk", "eggs", "wheat", "soy", "fish", "shellfish", "sesame"];
  var TZ = "Africa/Cairo";
  var flash = null, menuWeek = null, schedClass = "", openStats = null, openAnswers = null, editEvent = null, showForm = false, formPrefill = null;

  function lang() { return CKA.getLang(); }
  function pick(en, ar) { var a = lang() === "ar" ? [ar, en] : [en, ar]; return (a[0] && a[0].trim()) ? a[0] : (a[1] || ""); }
  function uuid() { return crypto.randomUUID(); }
  function addDays(s, n) { var d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function today() { return L.periodFor("week", Date.now()).to; }
  function sunday(s) { return addDays(s, -new Date(s + "T12:00:00Z").getUTCDay()); }
  function dayLabel(s) { return new Intl.DateTimeFormat(lang() === "ar" ? "ar-EG" : "en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "short" }).format(new Date(s + "T12:00:00Z")); }
  function fmtDT(iso) { return new Intl.DateTimeFormat(lang() === "ar" ? "ar-EG" : "en-GB", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)); }
  function guard() { if (!S.isMgmt()) { S.routes[""](); return false; } return true; }
  function takeFlash(nodes) { if (flash) { nodes.unshift(S.note(flash.kind, flash.text)); flash = null; } }
  function input(type, attrs, value) { var i = el("input", Object.assign({ type: type }, attrs || {})); if (value != null) i.value = value; return i; }
  // Cairo wall-clock <-> a real moment (the page may be open on a device in another time zone)
  function cairoParts(date) { var p = {}; new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date).forEach(function (x) { p[x.type] = x.value; }); return p; }
  function toLocalInput(iso) { if (!iso) return ""; var p = cairoParts(new Date(iso)); return p.year + "-" + p.month + "-" + p.day + "T" + (p.hour === "24" ? "00" : p.hour) + ":" + p.minute; }
  function fromLocalInput(v) {
    if (!v) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v); if (!m) return null;
    var want = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]), guess = want;
    for (var i = 0; i < 3; i++) { var p = cairoParts(new Date(guess)); var got = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === "24" ? 0 : p.hour), +p.minute); guess += want - got; }
    return new Date(guess).toISOString();
  }

  // ------------------------------------------------------------------ Announcements
  async function announcements() {
    if (!guard()) return;
    S.loadingView();
    var res = await Promise.all([client.from("announcements").select("*").order("created_at", { ascending: false }).limit(50), client.from("classes").select("id, name").order("name"),
      client.from("children").select("id, full_name, classes(name)").eq("active", true).order("full_name")]);
    var list = (res[0].data || []).slice().sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; }), classes = res[1].data || [], kids = res[2].data || [];
    var nodes = [];
    var head = S.card([el("h1", { text: t("ca.title") })]);
    var add = el("button", { type: "button", class: "btn btn-pink", text: "+ " + t("ca.new") });
    add.addEventListener("click", function () { showForm = !showForm; formPrefill = null; announcements(); });
    var weekly = el("button", { type: "button", class: "btn btn-outline", text: "📅 " + t("ca.f.weekly") });
    weekly.addEventListener("click", async function () { formPrefill = await weeklyTemplate(); showForm = true; announcements(); });
    head.appendChild(el("div", { class: "actions" }, [add, weekly])); head.appendChild(el("p", { class: "p-sub", text: t("ca.weekly_hint") }));
    nodes.push(head);
    if (showForm) nodes.push(announcementForm(classes, kids));
    if (!list.length) nodes.push(S.card([el("p", { class: "p-sub", text: t("ca.none") })]));
    list.forEach(function (a) { nodes.push(announcementCard(a, classes)); });
    takeFlash(nodes); S.show(nodes);
  }

  async function weeklyTemplate() {
    var from = addDays(sunday(today()), 7), to = addDays(from, 4), en = [], ar = [];
    try {
      var menu = await S.rpc("menu_week", { p_from: from, p_to: to });
      menu.forEach(function (m) { en.push(dayLabel(m.menu_date) + " · " + t("cm." + m.meal) + ": " + (m.dish_en || m.dish_ar)); ar.push(dayLabel(m.menu_date) + " · " + t("cm." + m.meal) + ": " + (m.dish_ar || m.dish_en)); });
    } catch (e) {}
    return { kind: "weekly_update", title_en: "Weekly update", title_ar: "التحديث الأسبوعي",
      body_en: t("ca.weekly_menu") + ":\n" + (en.join("\n") || "—") + "\n\n" + t("ca.weekly_acts") + "\n\n" + t("ca.weekly_rem") + "\n",
      body_ar: t("ca.weekly_menu") + ":\n" + (ar.join("\n") || "—") + "\n\n" + t("ca.weekly_acts") + "\n\n" + t("ca.weekly_rem") + "\n" };
  }

  function announcementForm(classes, kids) {
    var pre = formPrefill || {};
    var tEn = input("text", { maxlength: "150" }, pre.title_en || ""), tAr = input("text", { maxlength: "150", dir: "rtl" }, pre.title_ar || "");
    var bEn = S.textarea(6, ""), bAr = S.textarea(6, ""); bEn.value = pre.body_en || ""; bAr.value = pre.body_ar || ""; bAr.dir = "rtl";
    var aud = el("select", {}, [S.opt("all", t("ca.a.all")), S.opt("class", t("ca.a.class")), S.opt("families", t("ca.a.families"))]);
    var cls = el("select", {}, classes.map(function (c) { return S.opt(c.id, c.name); }));
    var clsRow = S.field(t("ca.f.class"), cls), famRow = el("div", {});
    var search = input("search", { placeholder: "…" }), checks = el("div", { class: "checks" });
    kids.forEach(function (k) { var c = el("input", { type: "checkbox", value: k.id }), lab = el("label", {}, [c, k.full_name + (k.classes ? " (" + k.classes.name + ")" : "")]); checks.appendChild(lab); });
    search.addEventListener("input", function () { var q = search.value.toLowerCase(); checks.querySelectorAll("label").forEach(function (l) { l.style.display = l.textContent.toLowerCase().indexOf(q) >= 0 ? "" : "none"; }); });
    famRow.appendChild(el("p", { class: "p-sub", text: t("ca.f.children") })); famRow.appendChild(search); famRow.appendChild(checks);
    function sync() { clsRow.classList.toggle("hidden", aud.value !== "class"); famRow.classList.toggle("hidden", aud.value !== "families"); } aud.addEventListener("change", sync); sync();
    var imp = el("input", { type: "checkbox" }), file = el("input", { type: "file", accept: "image/*,application/pdf" });
    var msg = el("div", {}), post = el("button", { type: "button", class: "btn btn-pink", text: t("ca.post") }), cancel = el("button", { type: "button", class: "btn btn-outline", text: t("ca.cancel") });
    cancel.addEventListener("click", function () { showForm = false; formPrefill = null; announcements(); });
    post.addEventListener("click", async function () {
      msg.textContent = "";
      var hasT = tEn.value.trim() || tAr.value.trim(), hasB = bEn.value.trim() || bAr.value.trim();
      if (!hasT || !hasB) { msg.appendChild(S.note("err", t("ca.need_title"))); return; }
      if (aud.value === "class" && !cls.value) { msg.appendChild(S.note("err", t("ca.need_class"))); return; }
      var chosen = Array.prototype.map.call(checks.querySelectorAll("input:checked"), function (c) { return c.value; });
      if (aud.value === "families" && !chosen.length) { msg.appendChild(S.note("err", t("ca.need_children"))); return; }
      var f = file.files && file.files[0];
      if (f && (f.size > 10485760 || !/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(f.type))) { msg.appendChild(S.note("err", t("ca.file_bad"))); return; }
      post.disabled = true; post.textContent = t("ca.working");
      var id = uuid(), path = null, name = null;
      try {
        if (f) {
          var ext = f.type === "application/pdf" ? "pdf" : f.type === "image/png" ? "png" : f.type === "image/webp" ? "webp" : "jpg";
          path = id + "/" + uuid() + "." + ext; name = f.name;
          var up = await client.storage.from("announcements").upload(path, f, { contentType: f.type }); if (up.error) throw up.error;
        }
        await S.rpc("announcement_post", { p_id: id, p_title_en: tEn.value, p_title_ar: tAr.value, p_body_en: bEn.value, p_body_ar: bAr.value, p_audience: aud.value, p_class: aud.value === "class" ? cls.value : null,
          p_children: aud.value === "families" ? chosen : null, p_important: imp.checked, p_kind: pre.kind || "news", p_attachment_path: path, p_attachment_name: name });
        showForm = false; formPrefill = null; flash = { kind: "ok", text: t("ca.posted") }; announcements();
      } catch (e) { post.disabled = false; post.textContent = t("ca.post"); msg.appendChild(S.note("err", t("ca.err"))); }
    });
    return S.card([el("h2", { text: t("ca.new") }), el("div", { class: "f-grid" }, [S.field(t("ca.f.title_en"), tEn), S.field(t("ca.f.title_ar"), tAr)]),
      el("div", { class: "f-grid" }, [S.field(t("ca.f.body_en"), bEn), S.field(t("ca.f.body_ar"), bAr)]), S.field(t("ca.f.audience"), aud), clsRow, famRow,
      el("label", { class: "choice" }, [imp, el("span", { text: "★ " + t("ca.f.important") })]), S.field(t("ca.f.file"), file), msg, el("div", { class: "actions" }, [post, cancel])]);
  }

  function announcementCard(a, classes) {
    var aud = a.audience === "class" ? t("ca.a.class") + ": " + ((classes.filter(function (c) { return c.id === a.class_id; })[0] || {}).name || "") : t("ca.a." + a.audience);
    var kids = [el("div", { class: "case-top" }, [a.important ? S.pill("★ " + t("ca.important"), "urg-critical") : null, a.kind === "weekly_update" ? S.pill(t("ca.weekly")) : null, S.pill(aud)].filter(Boolean)),
      el("div", { class: "case-title", text: pick(a.title_en, a.title_ar) }), el("small", { text: fmtDT(a.created_at) }), el("p", { class: "preline", text: pick(a.body_en, a.body_ar) })];
    var st = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("ca.stats") });
    st.addEventListener("click", function () { openStats = openStats === a.id ? null : a.id; announcements(); });
    var rm = el("button", { type: "button", class: "p-link", text: t("ca.remove") });
    rm.addEventListener("click", async function () { if (!window.confirm(t("ca.confirm_remove"))) return; try { await S.rpc("announcement_remove", { p_id: a.id }); announcements(); } catch (e) {} });
    kids.push(el("div", { class: "actions" }, [st, rm]));
    var holder = el("div", {}); kids.push(holder);
    if (openStats === a.id) S.rpc("announcement_stats", { p_id: a.id }).then(function (s) {
      holder.appendChild(el("p", { class: "att-msg ok", text: s.read + " " + t("ca.of") + " " + s.total + " " + t("ca.read") }));
      if (s.unread.length) holder.appendChild(el("div", { class: "internal-box" }, [el("strong", { text: t("ca.unread") })].concat(s.unread.map(function (u) { return el("div", { text: u.name + (u.phone ? " · " + u.phone : "") }); }))));
      if (s.readers.length) holder.appendChild(el("div", { class: "p-sub" }, [el("strong", { text: t("ca.readers") + ": " }), s.readers.map(function (r) { return r.name; }).join(" · ")]));
    }).catch(function () {});
    return S.card(kids);
  }

  // ------------------------------------------------------------------ Menu and daily schedule
  async function menu() {
    if (!guard()) return;
    S.loadingView();
    if (!menuWeek) menuWeek = addDays(sunday(today()), 7 * 0);
    var from = menuWeek, to = addDays(from, 4);
    var res = await Promise.all([S.rpc("menu_week", { p_from: from, p_to: to }), client.from("classes").select("id, name").order("name"),
      client.from("schedule_items").select("*").order("start_time")]);
    var rows = res[0], classes = res[1].data || [], sched = res[2].data || [];
    var nodes = [];
    var nav = el("div", { class: "actions" });
    function go(n) { return function () { menuWeek = addDays(menuWeek, 7 * n); menu(); }; }
    var pb = el("button", { type: "button", class: "btn btn-outline btn-small", text: "‹ " + t("cm.prev") }), nb = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("cm.next") + " ›" });
    pb.addEventListener("click", go(-1)); nb.addEventListener("click", go(1)); nav.appendChild(pb); nav.appendChild(nb);
    nodes.push(S.card([el("h1", { text: t("cm.title") }), el("p", { class: "p-sub", text: t("cm.hint") }), el("h2", { text: t("cm.week_of") + " " + dayLabel(from) }), nav]));
    for (var i = 0; i < 5; i++) {
      var day = addDays(from, i), kids = [el("h2", { text: dayLabel(day) })];
      ["breakfast", "lunch", "snack"].forEach(function (meal) {
        var r = rows.filter(function (x) { return x.menu_date === day && x.meal === meal; })[0] || {};
        kids.push(menuCell(day, meal, r));
      });
      nodes.push(S.card(kids));
    }
    nodes.push(scheduleCard(classes, sched));
    takeFlash(nodes); S.show(nodes);
  }

  function menuCell(day, meal, r) {
    var en = input("text", { maxlength: "150" }, r.dish_en || ""), ar = input("text", { maxlength: "150", dir: "rtl" }, r.dish_ar || "");
    var boxes = {}, chips = el("div", { class: "checks" });
    ALLERGENS.forEach(function (a) { var c = el("input", { type: "checkbox" }); c.checked = (r.allergens || []).indexOf(a) >= 0; boxes[a] = c; chips.appendChild(el("label", {}, [c, t("al." + a)])); });
    var msg = el("span", { class: "p-who" }), save = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("cm.save") });
    save.addEventListener("click", async function () {
      save.disabled = true; msg.textContent = "";
      try { await S.rpc("menu_save", { p_date: day, p_meal: meal, p_en: en.value, p_ar: ar.value, p_allergens: ALLERGENS.filter(function (a) { return boxes[a].checked; }) }); msg.textContent = "✓ " + t("cm.saved"); }
      catch (e) { msg.textContent = t("cm.err"); }
      save.disabled = false;
    });
    var kids = [el("h3", { text: t("cm." + meal) }), el("div", { class: "f-grid" }, [S.field(t("cm.en"), en), S.field(t("cm.ar"), ar)]), el("p", { class: "p-sub", text: t("cm.allergens") + ":" }), chips];
    if (r.affected && r.affected.length) kids.push(el("div", { class: "att-msg bad", text: "⚠ " + t("cm.affected") + " " + r.affected.join(", ") }));
    kids.push(el("div", { class: "actions" }, [save, msg]));
    return el("div", { class: "action" }, kids);
  }

  function scheduleCard(classes, sched) {
    var sel = el("select", {}, [S.opt("", t("cm.sched_all"))].concat(classes.map(function (c) { return S.opt(c.id, c.name); })));
    sel.value = schedClass; sel.addEventListener("change", function () { schedClass = sel.value; menu(); });
    var shown = sched.filter(function (x) { return schedClass === "" ? x.class_id === null : (x.class_id === null || x.class_id === schedClass); });
    var kids = [el("h2", { text: t("cm.schedule") }), el("p", { class: "p-sub", text: t("cm.sched_hint") }), S.field(t("ca.f.class"), sel)];
    shown.forEach(function (x) {
      var rm = el("button", { type: "button", class: "p-link", text: t("cm.delete") });
      rm.addEventListener("click", async function () { try { await S.rpc("schedule_delete", { p_id: x.id }); menu(); } catch (e) {} });
      kids.push(el("div", { class: "kv" }, [el("strong", { text: String(x.start_time).slice(0, 5) + " · " + pick(x.title_en, x.title_ar) }), x.class_id === null && schedClass !== "" ? el("small", { text: t("cm.sched_all") }) : null, rm].filter(Boolean)));
    });
    var time = input("time"), en = input("text", { maxlength: "100", placeholder: t("cm.en") }), ar = input("text", { maxlength: "100", dir: "rtl", placeholder: t("cm.ar") }), msg = el("div", {});
    var add = el("button", { type: "button", class: "btn btn-outline btn-small", text: "+ " + t("cm.add") });
    add.addEventListener("click", async function () {
      msg.textContent = "";
      if (!time.value || (!en.value.trim() && !ar.value.trim())) { msg.appendChild(S.note("err", t("cm.sched_need"))); return; }
      try { await S.rpc("schedule_save", { p_id: null, p_class: schedClass || null, p_time: time.value, p_en: en.value, p_ar: ar.value }); menu(); } catch (e) { msg.appendChild(S.note("err", t("cm.err"))); }
    });
    kids.push(el("h3", { text: t("cm.add") }), S.field(t("cm.time"), time), el("div", { class: "f-grid" }, [S.field(t("cm.en"), en), S.field(t("cm.ar"), ar)]), msg, add);
    return S.card(kids, "blue");
  }

  // ------------------------------------------------------------------ Events and the calendar
  async function events() {
    if (!guard()) return;
    S.loadingView();
    var res = await Promise.all([client.from("events").select("*").order("starts_at"), client.from("classes").select("id, name").order("name")]);
    var list = (res[0].data || []).slice().sort(function (a, b) { return a.starts_at < b.starts_at ? -1 : 1; }), classes = res[1].data || [];
    var now = new Date().toISOString(), nodes = [];
    var head = S.card([el("h1", { text: t("ce.title") })]);
    var add = el("button", { type: "button", class: "btn btn-pink", text: "+ " + t("ce.new") });
    add.addEventListener("click", function () { editEvent = { id: null }; events(); });
    head.appendChild(el("div", { class: "actions" }, [add])); nodes.push(head);
    var calls = [];
    try { calls = await S.rpc("approval_call_list"); } catch (e) {}
    if (calls.length) nodes.push(callCard(calls));
    if (editEvent) nodes.push(eventForm(editEvent, classes));
    var upcoming = list.filter(function (e) { return (e.ends_at || e.starts_at) >= now; }), past = list.filter(function (e) { return (e.ends_at || e.starts_at) < now; }).reverse();
    if (!list.length) nodes.push(S.card([el("p", { class: "p-sub", text: t("ce.none") })]));
    if (upcoming.length) nodes.push(S.card([el("h2", { text: t("ce.upcoming") })].concat(upcoming.map(function (e) { return eventRow(e, classes); }))));
    if (past.length) nodes.push(S.card([el("h2", { text: t("ce.past") })].concat(past.slice(0, 15).map(function (e) { return eventRow(e, classes); }))));
    takeFlash(nodes); S.show(nodes);
  }

  function callCard(calls) {
    var box = el("div", {});
    calls.forEach(function (c) {
      var note = input("text", { maxlength: "300", placeholder: t("ce.call_note") }), msg = el("div", {}), done = el("button", { type: "button", class: "btn btn-pink btn-small", text: t("ce.i_called") });
      done.addEventListener("click", async function () {
        msg.textContent = "";
        if (note.value.trim().length < 2) { msg.appendChild(S.note("err", t("ce.call_need"))); return; }
        try { await S.rpc("approval_call_log", { p_event: c.event_id, p_child: c.child_id, p_note: note.value }); events(); } catch (e) { msg.appendChild(S.note("err", S.msgFromError(e))); }
      });
      box.appendChild(el("div", { class: "check-row" }, [el("strong", { text: c.child_name + " · " + c.event_title }), el("div", { text: c.parents + (c.phones ? " · " + c.phones : "") }),
        c.called_at ? el("div", { class: "att-msg ok", text: "✓ " + t("ce.called") + ": " + (c.note || "") }) : el("div", {}, [note, msg, done])]));
    });
    return S.card([el("h2", { text: "☎ " + t("ce.call_list") }), el("p", { class: "p-sub", text: t("ce.call_hint") }), box]);
  }

  function eventRow(e, classes) {
    var aud = e.audience === "class" ? ((classes.filter(function (c) { return c.id === e.class_id; })[0] || {}).name || "") : t("ca.a.all");
    var kids = [el("div", { class: "case-top" }, [S.pill(t("ce.k." + e.kind), e.kind === "closure" ? "urg-critical" : ""), S.pill(aud), el("strong", { text: pick(e.title_en, e.title_ar) })]),
      el("small", { text: fmtDT(e.starts_at) + (e.place ? " · " + e.place : "") + (e.cost != null ? " · " + e.cost + " EGP" : "") })];
    var ed = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("ce.edit") }); ed.addEventListener("click", function () { editEvent = e; events(); });
    var rm = el("button", { type: "button", class: "p-link", text: t("ce.delete") });
    rm.addEventListener("click", async function () { if (!window.confirm(t("ce.confirm_delete"))) return; try { await S.rpc("event_delete", { p_id: e.id }); events(); } catch (x) {} });
    var acts = [ed, rm];
    if (e.needs_approval) { var an = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("ce.answers") }); an.addEventListener("click", function () { openAnswers = openAnswers === e.id ? null : e.id; events(); }); acts.unshift(an); }
    kids.push(el("div", { class: "actions" }, acts));
    var holder = el("div", {}); kids.push(holder);
    if (openAnswers === e.id) S.rpc("event_responses_summary", { p_event: e.id }).then(function (rows) {
      var yes = rows.filter(function (r) { return r.answer === "yes"; }).length, no = rows.filter(function (r) { return r.answer === "no"; }).length, wait = rows.length - yes - no;
      holder.appendChild(el("p", { class: "att-msg " + (wait ? "bad" : "ok"), text: t("ce.counts") + ": " + yes + " / " + no + " / " + wait }));
      function st(r) { return r.status === "yes" || r.status === "no" ? t("ce." + r.status) : "— " + t(r.status === "no_answer" ? "ce.no_answer" : "ce.waiting"); }
      var head = el("tr", {}, [t("ce.family"), t("ce.answers"), t("ce.answered_by"), t("ce.reminders")].map(function (h) { return el("th", { text: h }); }));
      var body = rows.map(function (r) { return el("tr", {}, [el("td", { text: r.child_name + (r.class_name ? " (" + r.class_name + ")" : "") + "\n" + r.parents }), el("td", { text: st(r) }), el("td", { text: r.answered_by_name || "" }), el("td", { text: r.reminders ? r.reminders + (r.last_reminder ? " · " + fmtDT(r.last_reminder) : "") : "0" })]); });
      holder.appendChild(el("div", { class: "tbl-wrap" }, [el("table", { class: "tbl" }, [el("thead", {}, [head]), el("tbody", {}, body)])]));
    }).catch(function () {});
    return el("div", { class: "action" }, kids);
  }

  function eventForm(e, classes) {
    var kind = el("select", {}, ["event", "closure", "holiday", "session"].map(function (k) { return S.opt(k, t("ce.k." + k)); })); kind.value = e.kind || "event";
    var tEn = input("text", { maxlength: "150" }, e.title_en || ""), tAr = input("text", { maxlength: "150", dir: "rtl" }, e.title_ar || "");
    var dEn = S.textarea(3, ""), dAr = S.textarea(3, ""); dEn.value = e.details_en || ""; dAr.value = e.details_ar || ""; dAr.dir = "rtl";
    var starts = input("datetime-local", {}, toLocalInput(e.starts_at)), ends = input("datetime-local", {}, toLocalInput(e.ends_at));
    var allDay = el("input", { type: "checkbox" }); allDay.checked = !!e.all_day;
    var place = input("text", { maxlength: "200" }, e.place || ""), cost = input("number", { min: "0", step: "0.5", inputmode: "decimal" }, e.cost != null ? e.cost : "");
    var aud = el("select", {}, [S.opt("all", t("ca.a.all")), S.opt("class", t("ca.a.class"))]); aud.value = e.audience || "all";
    var cls = el("select", {}, classes.map(function (c) { return S.opt(c.id, c.name); })); if (e.class_id) cls.value = e.class_id;
    var clsRow = S.field(t("ca.f.class"), cls); function sync() { clsRow.classList.toggle("hidden", aud.value !== "class"); } aud.addEventListener("change", sync); sync();
    var needs = el("input", { type: "checkbox" }); needs.checked = !!e.needs_approval;
    var deadline = input("datetime-local", {}, toLocalInput(e.approval_deadline)), dlRow = S.field(t("ce.f.deadline"), deadline);
    function sync2() { dlRow.classList.toggle("hidden", !needs.checked); } needs.addEventListener("change", sync2); sync2();
    var msg = el("div", {}), save = el("button", { type: "button", class: "btn btn-pink", text: t("ce.save") }), cancel = el("button", { type: "button", class: "btn btn-outline", text: t("ca.cancel") });
    cancel.addEventListener("click", function () { editEvent = null; events(); });
    save.addEventListener("click", async function () {
      msg.textContent = "";
      if ((!tEn.value.trim() && !tAr.value.trim()) || !starts.value) { msg.appendChild(S.note("err", t("ce.need"))); return; }
      if (needs.checked && !deadline.value) { msg.appendChild(S.note("err", t("ce.need_deadline"))); return; }
      save.disabled = true;
      try {
        await S.rpc("event_save", { p_id: e.id, p_kind: kind.value, p_title_en: tEn.value, p_title_ar: tAr.value, p_details_en: dEn.value, p_details_ar: dAr.value, p_starts: fromLocalInput(starts.value), p_ends: fromLocalInput(ends.value),
          p_all_day: allDay.checked, p_place: place.value, p_audience: aud.value, p_class: aud.value === "class" ? cls.value : null, p_cost: cost.value === "" ? null : Number(cost.value),
          p_needs_approval: needs.checked, p_deadline: needs.checked ? fromLocalInput(deadline.value) : null });
        editEvent = null; flash = { kind: "ok", text: t("ce.saved") }; events();
      } catch (x) { save.disabled = false; msg.appendChild(S.note("err", /deadline/i.test(String(x.message)) ? t("ce.need_deadline") : t("ce.err"))); }
    });
    return S.card([el("h2", { text: e.id ? t("ce.edit") : t("ce.new") }), S.field(t("ce.kind"), kind), el("div", { class: "f-grid" }, [S.field(t("ce.f.title_en"), tEn), S.field(t("ce.f.title_ar"), tAr)]),
      el("div", { class: "f-grid" }, [S.field(t("ce.f.details_en"), dEn), S.field(t("ce.f.details_ar"), dAr)]), el("div", { class: "f-grid" }, [S.field(t("ce.f.starts"), starts), S.field(t("ce.f.ends"), ends)]),
      el("label", { class: "choice" }, [allDay, el("span", { text: t("ce.f.all_day") })]), el("div", { class: "f-grid" }, [S.field(t("ce.f.place"), place), S.field(t("ce.f.cost"), cost)]),
      S.field(t("ce.f.audience"), aud), clsRow, el("label", { class: "choice" }, [needs, el("span", { text: t("ce.f.needs") })]), dlRow, msg, el("div", { class: "actions" }, [save, cancel])]);
  }

  S.routes.announcements = announcements;
  S.routes.menu = menu;
  S.routes.events = events;
})();
