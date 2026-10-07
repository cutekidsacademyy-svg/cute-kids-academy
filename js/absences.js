// Staff (admin, manager, owner): absences (#/absences). Three tabs: the 3-day follow-up tasks (send a caring message through the
// portal and email, open WhatsApp with the same text, record the outcome); the tracker (per child, any period, with a way to
// record an absence); and "from an email" (turn an email that reached the academy's inbox into a portal case).
// The owner dashboard gets a card with the follow-up numbers. The database enforces everything; text is only inserted as text.
(function () {
  "use strict";
  var S = window.CKAStaff, el = CKA.el, t = CKA.t, L = window.CKALogic, client = CKA.client;
  var tab = "followups", period = "month", flash = null, emailPick = null, lastCase = null;

  function lang() { return CKA.getLang(); }
  function fmt(d) { return new Intl.DateTimeFormat(lang() === "ar" ? "ar-EG" : "en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(String(d).slice(0, 10) + "T12:00:00Z")); }
  function fmtDT(iso) { return new Intl.DateTimeFormat(lang() === "ar" ? "ar-EG" : "en-GB", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)); }
  function today() { return L.periodFor("week", Date.now()).to; }
  function input(type, attrs, v) { var i = el("input", Object.assign({ type: type }, attrs || {})); if (v != null) i.value = v; return i; }
  function first(name) { return String(name || "").trim().split(/\s+/)[0]; }
  function waNumber(phone) { var d = String(phone || "").replace(/[^0-9]/g, ""); if (!d) return null; if (d.indexOf("00") === 0) d = d.slice(2); else if (d.charAt(0) === "0") d = "20" + d.slice(1); return d; }
  function guard() { if (!S.isMgmt()) { S.routes[""](); return false; } return true; }
  function tpl(key, lg, child, days) { return t("ab.msg." + key + "_" + lg).replace(/\{child\}/g, first(child)).replace(/\{days\}/g, days); }

  function tabs() {
    var bar = el("div", { class: "actions" });
    [["followups", "ab.tab.followups"], ["tracker", "ab.tab.tracker"], ["email", "ab.tab.email"]].forEach(function (x) {
      var b = el("button", { type: "button", class: "filter-pill" + (tab === x[0] ? " active" : ""), text: t(x[1]) });
      b.addEventListener("click", function () { tab = x[0]; absences(); });
      bar.appendChild(b);
    });
    return S.card([el("h1", { text: t("ab.title") }), bar], "blue");
  }
  function shown(nodes) { if (flash) { nodes.unshift(S.note(flash.kind, flash.text)); flash = null; } S.show([tabs()].concat(nodes)); }

  async function absences() {
    if (!guard()) return;
    S.loadingView();
    try {
      if (tab === "tracker") return await tracker();
      if (tab === "email") return email();
      return await followups();
    } catch (e) { S.show([S.note("err", S.msgFromError(e))]); }
  }

  // ------------------------------------------------------------------ Follow-ups
  async function followups() {
    var list = await S.rpc("absence_followup_list"), open = list.filter(function (x) { return !x.closed_at; }), closed = list.filter(function (x) { return x.closed_at; });
    var nodes = [S.card([el("p", { class: "p-sub", text: t("ab.f.intro") })])];
    if (!open.length) nodes.push(S.card([el("p", { class: "p-sub", text: t("ab.f.none") })]));
    open.forEach(function (f) { nodes.push(taskCard(f)); });
    if (closed.length) nodes.push(S.card([el("h2", { text: t("ab.f.closed") })].concat(closed.map(function (f) {
      return el("div", { class: "kv" }, [el("strong", { text: f.child_name + " · " + t("ab.k." + f.kind) }), el("small", { text: f.outcome ? t("ab.o." + f.outcome) + (f.return_date ? " · " + fmt(f.return_date) : "") : f.closed_reason || "" })]);
    }))));
    shown(nodes);
  }

  function taskCard(f) {
    var kids = [el("div", { class: "case-top" }, [S.pill(t("ab.k." + f.kind), f.kind === "call" ? "urg-critical" : f.kind === "reminder" ? "urg-urgent" : ""), f.overdue ? S.pill("⚠ " + t("ab.overdue"), "urg-critical") : null, f.escalated_at ? S.pill(t("ab.escalated"), "urg-critical") : null].filter(Boolean)),
      el("h2", { text: f.child_name + " · " + f.class_name }), el("p", { class: "att-msg bad", text: f.streak_days + " " + t("ab.days") + " · " + t("ab.since") + " " + fmt(f.streak_start) })];
    kids.push(el("h3", { text: t("ab.reasons") }));
    if (f.reasons.length) f.reasons.forEach(function (r) { kids.push(el("div", { class: "kv" }, [el("strong", { text: fmt(r.date) + (r.reported ? "" : " · " + t("ab.not_reported")) }), el("span", { text: r.reason })])); });
    else kids.push(el("p", { class: "p-sub", text: t("ab.no_reason") }));
    kids.push(el("h3", { text: t("ab.parents") }));
    f.parents.forEach(function (p) { if (p.phone) kids.push(el("a", { class: "p-link", href: "tel:" + p.phone.replace(/\s+/g, ""), dir: "ltr", text: "📞 " + p.name + " " + p.phone })); else kids.push(el("div", { text: p.name })); });

    if (!f.message_sent_at && f.kind !== "call") {
      var reasoned = f.reasons.some(function (r) { return r.reported; });
      var lg = el("select", {}, [S.opt("ar", t("lang.ar")), S.opt("en", t("lang.en"))]); lg.value = (f.parents[0] && f.parents[0].language) || "ar";
      var which = el("select", {}, [S.opt("reason", t("ab.tpl_reason")), S.opt("noreason", t("ab.tpl_noreason"))]); which.value = reasoned ? "reason" : "noreason";
      var msg = S.textarea(4, ""); msg.maxLength = 1500;
      function fill() { msg.value = tpl(which.value, lg.value, f.child_name, f.streak_days); wa(); }
      var waBox = el("div", { class: "actions" });
      function wa() { waBox.textContent = ""; f.parents.forEach(function (p) { var n = waNumber(p.phone); if (n) waBox.appendChild(el("a", { class: "btn btn-outline btn-small", target: "_blank", rel: "noopener", href: "https://wa.me/" + n + "?text=" + encodeURIComponent(msg.value), text: "💬 " + t("ab.whatsapp") + ": " + p.name })); }); }
      which.addEventListener("change", fill); lg.addEventListener("change", fill); msg.addEventListener("input", wa); fill();
      var err = el("div", {}), send = el("button", { type: "button", class: "btn btn-pink", text: t("ab.send") });
      send.addEventListener("click", async function () {
        err.textContent = ""; send.disabled = true;
        try { await S.rpc("followup_send", { p_id: f.id, p_message: msg.value }); flash = { kind: "ok", text: t("ab.sent") }; absences(); } catch (e) { send.disabled = false; err.appendChild(S.note("err", S.msgFromError(e))); }
      });
      kids.push(el("h3", { text: t("ab.msg") }), el("div", { class: "f-grid" }, [S.field(t("ab.tpl"), which), S.field(t("ab.lang"), lg)]), msg, waBox, err, el("div", { class: "actions" }, [send]));
    } else {
      if (f.message_sent_at) kids.push(el("p", { class: "att-msg ok", text: "✓ " + t("ab.sent_at") + " " + fmtDT(f.message_sent_at) }), el("p", { class: "preline", text: f.message || "" }));
      else kids.push(S.note("info", t("ab.call_task")));
      kids.push(outcomeBox(f));
    }
    return S.card(kids);
  }

  function outcomeBox(f) {
    var sel = el("select", {}, ["parent_replied", "returning", "considering_leaving", "no_reply"].map(function (o) { return S.opt(o, t("ab.o." + o)); }));
    var date = input("date", { min: today() }, ""); var dRow = S.field(t("ab.return_date"), date); dRow.classList.add("hidden");
    sel.addEventListener("change", function () { dRow.classList.toggle("hidden", sel.value !== "returning"); });
    var note = input("text", { maxlength: "300" }), msg = el("div", {}), go = el("button", { type: "button", class: "btn btn-outline", text: t("ab.outcome_save") });
    go.addEventListener("click", async function () {
      msg.textContent = "";
      if (sel.value === "returning" && !date.value) { msg.appendChild(S.note("err", t("ab.outcome_need_date"))); return; }
      go.disabled = true;
      try { await S.rpc("followup_outcome", { p_id: f.id, p_outcome: sel.value, p_return: sel.value === "returning" ? date.value : null, p_note: note.value }); flash = { kind: "ok", text: t("ab.outcome_saved") }; absences(); }
      catch (e) { go.disabled = false; msg.appendChild(S.note("err", S.msgFromError(e))); }
    });
    return el("div", { class: "action" }, [el("h3", { text: t("ab.outcome") }), S.field(t("ab.outcome"), sel), dRow, S.field("…", note), msg, go]);
  }

  // ------------------------------------------------------------------ Tracker
  async function tracker() {
    var p = period === "week" ? L.periodFor("week", Date.now()) : period === "month" ? L.periodFor("month", Date.now()) : { from: addDays(today(), -59), to: today() };
    var res = await Promise.all([S.rpc("absence_tracker", { p_from: p.from, p_to: p.to }), client.from("children").select("id, full_name").eq("active", true).order("full_name")]);
    var rows = res[0], kids = res[1].data || [];
    var sum = rows.reduce(function (a, r) { a.abs += r.absent_days; a.rep += r.reported_days; a.not += r.not_reported_days; if (r.streak >= 3) a.flag++; return a; }, { abs: 0, rep: 0, not: 0, flag: 0 });
    function tile(n, label, cls) { return el("div", { class: "tile " + (cls || "") }, [el("strong", { text: String(n) }), el("span", { text: label })]); }
    var bar = el("div", { class: "actions" });
    [["week", "ab.tr.week"], ["month", "ab.tr.month"], ["60", "ab.tr.60"]].forEach(function (o) {
      var b = el("button", { type: "button", class: "filter-pill" + (period === o[0] ? " active" : ""), text: t(o[1]) }); b.addEventListener("click", function () { period = o[0]; absences(); }); bar.appendChild(b);
    });
    var csv = el("button", { type: "button", class: "btn btn-outline btn-small", text: "⬇ " + t("ab.tr.csv") });
    csv.addEventListener("click", function () {
      var sec = [{ title: t("ab.title") + " " + p.from + " → " + p.to, header: [t("ab.tr.child"), t("ab.tr.class"), t("ab.tr.absent"), t("ab.tr.reported"), t("ab.tr.notrep"), t("ab.tr.streak"), t("ab.tr.last"), t("ab.tr.reason")],
        rows: rows.map(function (r) { return [r.child_name, r.class_name, r.absent_days, r.reported_days, r.not_reported_days, r.streak, r.last_attended ? String(r.last_attended).slice(0, 10) : "", r.last_reason || ""]; }) }];
      var blob = new Blob(["﻿" + L.toCsv(sec)], { type: "text/csv;charset=utf-8" }), a = el("a", { href: URL.createObjectURL(blob), download: "cka-absences-" + p.from + "_" + p.to + ".csv" });
      document.body.appendChild(a); a.click(); a.remove();
    });
    var head = S.card([el("h2", { text: t("ab.tr.period") + ": " + p.from + " → " + p.to }), bar, el("div", { class: "tiles" }, [tile(sum.abs, t("ab.tr.t_absent")), tile(sum.rep, t("ab.tr.t_reported"), "good"), tile(sum.not, t("ab.tr.t_not"), sum.not ? "bad" : ""), tile(sum.flag, t("ab.tr.t_flag"), sum.flag ? "bad" : "")]),
      el("p", { class: "p-sub small", text: t("ab.tr.note") }), el("div", { class: "actions" }, [csv])]);
    var header = el("tr", {}, [t("ab.tr.child"), t("ab.tr.class"), t("ab.tr.absent"), t("ab.tr.reported"), t("ab.tr.notrep"), t("ab.tr.streak"), t("ab.tr.last"), t("ab.tr.reason")].map(function (h) { return el("th", { text: h }); }));
    var body = rows.length ? rows.map(function (r) {
      return el("tr", { class: r.streak >= 3 ? "overdue" : "" }, [el("td", {}, [el("strong", { text: r.child_name }), r.streak >= 3 ? S.pill("⚠ " + t("ab.tr.flagged"), "urg-critical") : null].filter(Boolean)), el("td", { text: r.class_name }), el("td", { text: String(r.absent_days) }), el("td", { text: String(r.reported_days) }),
        el("td", { text: String(r.not_reported_days) }), el("td", { text: String(r.streak || 0) }), el("td", { text: r.last_attended ? fmt(r.last_attended) : "—" }), el("td", { text: r.last_reason || "—" })]);
    }) : [el("tr", {}, [el("td", { colspan: "8", class: "p-sub", text: t("ab.tr.none") })])];
    var table = S.card([el("div", { class: "tbl-wrap" }, [el("table", { class: "tbl" }, [el("thead", {}, [header]), el("tbody", {}, body)])])]);

    var child = el("select", {}, kids.map(function (k) { return S.opt(k.id, k.full_name); })), date = input("date", { max: today() }, today()), rep = el("input", { type: "checkbox" }); rep.checked = true;
    var reason = input("text", { maxlength: "300" }), msg = el("div", {}), add = el("button", { type: "button", class: "btn btn-outline", text: t("ab.tr.add_btn") });
    add.addEventListener("click", async function () {
      msg.textContent = ""; add.disabled = true;
      try { await S.rpc("absence_add", { p_child: child.value, p_date: date.value, p_parent_reported: rep.checked, p_reason: reason.value }); flash = { kind: "ok", text: t("ab.tr.added") }; absences(); }
      catch (e) { add.disabled = false; msg.appendChild(S.note("err", S.msgFromError(e))); }
    });
    var form = S.card([el("h2", { text: t("ab.tr.add") }), el("div", { class: "f-grid" }, [S.field(t("ab.tr.add_child"), child), S.field(t("ab.tr.add_date"), date)]), el("label", { class: "choice" }, [rep, el("span", { text: t("ab.tr.add_reported") })]), S.field(t("ab.tr.add_reason"), reason), msg, add]);
    shown([head, table, form]);
  }
  function addDays(s, n) { var d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

  // ------------------------------------------------------------------ From an email
  function email() {
    var q = input("search", { placeholder: t("ab.em.search"), "aria-label": t("ab.em.search") }), results = el("div", {}), formBox = el("div", {});
    var timer = null;
    q.addEventListener("input", function () {
      clearTimeout(timer); timer = setTimeout(async function () {
        results.textContent = "";
        if (q.value.trim().length < 2) return;
        try { (await S.rpc("admin_parent_search", { p_q: q.value })).forEach(function (p) {
          var b = el("button", { type: "button", class: "case-item", style: "width:100%;text-align:start;background:#fff" }, [el("strong", { text: p.parent_name }), el("small", { dir: "ltr", text: [p.email, p.phone].filter(Boolean).join(" · ") }), el("small", { text: p.children.map(function (c) { return c.name; }).join(", ") })]);
          b.addEventListener("click", function () { emailPick = p; draw(); });
          results.appendChild(b);
        }); } catch (e) {}
      }, 300);
    });
    function draw() {
      formBox.textContent = ""; if (!emailPick) return;
      var child = el("select", {}, emailPick.children.map(function (c) { return S.opt(c.id, c.name); }));
      var sender = input("email", { dir: "ltr" }, emailPick.email || ""), subject = input("text", { maxlength: "150" }), body = S.textarea(6, ""), urg = el("select", {}, [S.opt("can_wait", t("ab.em.can_wait")), S.opt("urgent", t("ab.em.urgent"))]);
      var msg = el("div", {}), go = el("button", { type: "button", class: "btn btn-pink", text: t("ab.em.create") });
      go.addEventListener("click", async function () {
        msg.textContent = "";
        if (!child.value || subject.value.trim().length < 3 || body.value.trim().length < 3) { msg.appendChild(S.note("err", t("ab.em.need"))); return; }
        go.disabled = true;
        try { lastCase = await S.rpc("case_from_email", { p_parent: emailPick.parent_id, p_child: child.value, p_title: subject.value, p_description: body.value, p_urgency: urg.value, p_sender: sender.value }); emailPick = null; flash = { kind: "ok", text: t("ab.em.created") }; absences(); }
        catch (e) { go.disabled = false; msg.appendChild(S.note("err", S.msgFromError(e))); }
      });
      formBox.appendChild(S.card([el("h2", { text: emailPick.parent_name }), S.field(t("ab.em.child"), child), S.field(t("ab.em.sender"), sender), S.field(t("ab.em.subject"), subject), S.field(t("ab.em.body"), body), S.field(t("ab.em.urgency"), urg), msg, go]));
    }
    draw();
    var nodes = [S.card([el("h2", { text: t("ab.em.title") }), el("p", { class: "p-sub", text: t("ab.em.hint") }), q, results]), formBox];
    if (lastCase) { nodes.unshift(S.card([S.link("#/case/" + lastCase, t("ab.em.open"), "btn btn-pink")])); lastCase = null; }
    shown(nodes);
  }

  // The owner dashboard card
  S.ownerCards.push(async function (p) {
    if (!S.isTop()) return null;
    var s = await S.rpc("absence_followup_stats", { p_from: p.from, p_to: p.to });
    function tile(n, label, cls) { return el("div", { class: "tile " + (cls || "") }, [el("strong", { text: String(n) }), el("span", { text: label })]); }
    return S.card([el("h2", { text: t("ab.stats.title") }), el("div", { class: "tiles" }, [tile(s.created, t("ab.stats.created")), tile(s.on_time, t("ab.stats.on_time"), "good"), tile(s.escalated, t("ab.stats.escalated"), s.escalated ? "bad" : ""),
      tile(s.parent_replied, t("ab.stats.replied")), tile(s.returning, t("ab.stats.returning")), tile(s.considering_leaving, t("ab.stats.leaving"), s.considering_leaving ? "bad" : ""), tile(s.no_reply, t("ab.stats.no_reply"))]), S.link("#/absences", t("ab.title") + " →")]);
  });

  S.routes.absences = absences;
})();
