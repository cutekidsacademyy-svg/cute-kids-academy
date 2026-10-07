// The owner's private dashboard (#/owner), the attendance sheet (#/attendance) and the staff-concern
// form (#/concern). Plugs into the staff page through window.CKAStaff (see js/staff.js).
// All numbers come from the database function owner_dashboard(), which refuses anyone but the owner;
// hiding the menu item is only a convenience. Text from the database is only ever inserted as text.
(function () {
  "use strict";
  var S = window.CKAStaff, el = CKA.el, t = CKA.t, L = window.CKALogic, client = CKA.client;
  var kind = "month";
  var CSV_NAME = "cka-owner";

  function lang() { return CKA.getLang(); }
  function todayCairo() { return L.periodFor("month", Date.now()).to; }
  function download(name, sections) {
    var blob = new Blob(["﻿" + L.toCsv(sections)], { type: "text/csv;charset=utf-8" });
    var a = el("a", { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click(); a.remove();
  }
  function table(header, rows, rowClass) {
    var head = el("tr", {}, header.map(function (h) { return el("th", { text: h }); }));
    var body = rows.length ? rows.map(function (r, i) {
      return el("tr", { class: rowClass ? rowClass(i) || "" : "" }, r.map(function (c) { return c && c.nodeType ? el("td", {}, [c]) : el("td", { text: c === null || c === undefined ? "" : String(c) }); }));
    }) : [el("tr", {}, [el("td", { colspan: String(header.length), class: "p-sub", text: t("od.none") })])];
    return el("div", { class: "tbl-wrap" }, [el("table", { class: "tbl" }, [el("thead", {}, [head]), el("tbody", {}, body)])]);
  }
  // A card with the section title and its own CSV button.
  function section(sec, bodyNodes, cls) {
    var csv = el("button", { type: "button", class: "btn btn-outline btn-small", text: "⬇ " + t("od.csv"), "aria-label": t("od.csv") + ": " + sec.title });
    csv.addEventListener("click", function () { download(CSV_NAME + "-" + sec.id + ".csv", [sec]); });
    return S.card([el("div", { class: "sec-head" }, [el("h2", { text: sec.title }), csv])].concat(bodyNodes), cls);
  }
  function statusPill(s) {
    var icon = { good: "✓ ", watch: "👁 ", action: "⚠ " }[s];
    return el("span", { class: "pill od-" + s, text: icon + t("od.status." + s) });
  }

  // ------------------------------------------------------------------ Dashboard
  async function dashboard() {
    if (!S.isOwner()) return S.routes[""]();
    var p = L.periodFor(kind, Date.now());
    S.loadingView();
    var d;
    try { d = await S.rpc("owner_dashboard", { p_from: p.from, p_to: p.to }); } catch (e) { S.show([S.note("err", S.msgFromError(e))]); return; }
    var sections = L.ownerSections(d, function (k) { return CKA.t(k); }), by = {};
    sections.forEach(function (x) { by[x.id] = x; });
    var flash = S.takeFlash(), nodes = [];

    // controls
    var bar = el("div", { class: "actions" });
    [["week", "od.p.week"], ["month", "od.p.month"], ["quarter", "od.p.quarter"]].forEach(function (o) {
      var b = el("button", { type: "button", class: "filter-pill" + (kind === o[0] ? " active" : ""), text: t(o[1]) });
      b.addEventListener("click", function () { kind = o[0]; dashboard(); });
      bar.appendChild(b);
    });
    var all = el("button", { type: "button", class: "btn btn-pink btn-small", text: "⬇ " + t("od.csv_all") });
    all.addEventListener("click", function () { download(CSV_NAME + "-" + p.from + "_" + p.to + ".csv", sections); });
    nodes.push(S.card([el("h1", { text: "🔒 " + t("od.title") }), el("p", { class: "p-sub", text: t("od.privacy") }), bar,
      el("p", { class: "p-sub", text: t("od.period") + ": " + p.from + " → " + p.to + " (" + t("od.vs") + ")" }), all]));
    if (flash) nodes.unshift(S.note("ok", flash));

    // 1. six tiles
    function tile(key, label, value, a, b, hint) {
      var tr = L.trend(key, a, b), arrow = tr.dir === "up" ? "▲" : tr.dir === "down" ? "▼" : "●";
      var cls = tr.good === null ? "" : tr.good ? " good" : " bad";
      return el("div", { class: "tile big" + cls }, [el("strong", { text: String(value) }), el("span", { text: label }),
        el("em", { class: "trend" }, [arrow + " " + (tr.diff > 0 ? "+" : "") + tr.diff + " · " + t("od." + tr.dir)]), hint ? el("small", { text: hint }) : null]);
    }
    var tl = d.tiles;
    nodes.push(S.card([el("h2", { text: t("od.tiles") }), el("div", { class: "tiles" }, [
      tile("accidents", t("od.accidents"), tl.accidents.value, tl.accidents.value, tl.accidents.previous),
      tile("complaints", t("od.complaints"), tl.complaints.value, tl.complaints.value, tl.complaints.previous),
      tile("happy_comments", t("od.happy"), tl.happy_comments.value, tl.happy_comments.value, tl.happy_comments.previous),
      tile("absence_days", t("od.absence_days"), tl.absence_days.value, tl.absence_days.value, tl.absence_days.previous),
      tile("late_minutes", t("od.late_minutes"), tl.late_minutes.value, tl.late_minutes.value, tl.late_minutes.previous),
      tile("open_hr", t("od.open_hr"), tl.open_hr.value, tl.open_hr.opened, tl.open_hr.previous_opened, t("od.open_hr_hint")),
    ])], "blue"));

    // 2 and 3. charts
    var labels = d.weekly.map(function (w) { return w.week_start; });
    var acc = d.weekly.map(function (w) { return w.accidents; }), cmp = d.weekly.map(function (w) { return w.complaints; }), hap = d.weekly.map(function (w) { return w.happy_comments; });
    var C = window.CKACharts;
    nodes.push(S.card([el("h2", { text: t("od.chart_accidents") + " (" + t("od.weeks8") + ")" }),
      C.barChart({ labels: labels, values: acc, max: L.niceMax(Math.max.apply(null, acc)), color: C.PALETTE.vermillion, label: t("od.chart_accidents"), desc: acc.join(", ") })]));
    nodes.push(S.card([el("h2", { text: t("od.chart_compare") + " (" + t("od.weeks8") + ")" }),
      C.lineChart({ labels: labels, max: L.niceMax(Math.max.apply(null, cmp.concat(hap))), label: t("od.chart_compare"),
        desc: t("od.complaints_line") + ": " + cmp.join(", ") + ". " + t("od.happy_line") + ": " + hap.join(", "),
        series: [{ name: t("od.complaints_line"), values: cmp, color: C.PALETTE.vermillion, dash: "", shape: "circle" },
                 { name: t("od.happy_line"), values: hap, color: C.PALETTE.blue, dash: "9 6", shape: "square" }] }),
      el("p", { class: "p-sub small", text: t("od.chart_note") })]));
    nodes.push(section(by.weekly, [table(by.weekly.header, by.weekly.rows)]));

    // 4. latest accidents
    nodes.push(section(by.accidents, [table(by.accidents.header, by.accidents.rows, function (i) { return d.latest_accidents[i].severity === "serious" ? "row-bad" : ""; })]));

    // 5. repeated mistakes, critical ones flagged
    nodes.push(section(by.mistakes, [table([t("od.category"), t("od.count")], d.mistakes.map(function (m) {
      return [m.critical ? el("span", {}, [el("span", { class: "pill od-action", text: "⚠ " + t("od.critical_flag") }), " " + m.category]) : m.category, m.count];
    }), function (i) { return d.mistakes[i].critical ? "row-bad" : ""; })]));

    // 6. staff table
    nodes.push(section(by.staff, [table(by.staff.header.slice(0, 6).concat([t("od.status")]), d.staff.map(function (x) {
      return [x.name, x.absence_days, x.late_minutes, x.class_accidents, x.confirmed_faults, x.complaints_about, statusPill(x.status)];
    }), function (i) { return d.staff[i].status === "action" ? "row-bad" : d.staff[i].status === "watch" ? "row-watch" : ""; }),
      el("p", { class: "p-sub small", text: t("od.staff_note") })]));

    // 7. HR log (items waiting for the owner first)
    var hrCards = d.hr_log.length ? d.hr_log.map(function (h) {
      var kids = [el("div", { class: "case-top" }, [el("strong", { text: h.staff }), el("span", { class: "pill", text: t("od.hr." + h.type) }), el("small", { text: h.date }),
        h.awaiting ? el("span", { class: "pill od-action", text: "⚠ " + t("od.awaiting") }) : (h.decided_at ? el("span", { class: "pill od-good", text: "✓ " + t("od.decided") }) : null)]),
        h.note ? el("p", { class: "preline", text: h.note }) : null, h.follow_up_date ? el("small", { class: "promise", text: t("od.follow_up") + ": " + h.follow_up_date }) : null];
      if (h.awaiting) {
        var b = el("button", { type: "button", class: "btn btn-pink btn-small", text: t("od.mark_decided") });
        b.addEventListener("click", async function () {
          b.disabled = true;
          var r = await client.from("hr_log").update({ decided_at: new Date().toISOString() }).eq("id", h.id);
          if (r.error) { b.disabled = false; return; }
          S.setFlash(t("od.saved")); dashboard();
        });
        kids.push(b);
      }
      return el("div", { class: "case-item" + (h.awaiting ? " due-overdue" : "") }, kids);
    }) : [el("p", { class: "p-sub", text: t("od.none") })];
    nodes.push(section(by.hr, hrCards));

    // 8. concerns raised by staff
    var sc = d.staff_concerns;
    var concernCards = sc.recent.length ? sc.recent.map(function (c) {
      var sel = el("select", { "aria-label": t("od.status") }, ["open", "in_review", "resolved"].map(function (s) { return S.opt(s, t("od.cstatus." + s)); }));
      sel.value = c.status;
      sel.addEventListener("change", async function () {
        var r = await client.from("staff_complaints").update({ status: sel.value }).eq("id", c.id);
        if (r.error) sel.value = c.status; else S.setFlash(t("od.saved")), dashboard();
      });
      return el("div", { class: "case-item" }, [el("div", { class: "case-top" }, [el("span", { class: "pill", text: t("od.cat." + c.category) }), el("small", { text: c.date }),
        el("strong", { text: c.anonymous ? "🕶 " + t("od.anonymous") : c.raised_by })]), el("p", { class: "preline", text: c.description }), sel]);
    }) : [el("p", { class: "p-sub", text: t("od.none") })];
    var matrix = sc.by_category_status.map(function (x) { return t("od.cat." + x.category) + " · " + t("od.cstatus." + x.status) + ": " + x.count; }).join("   |   ");
    nodes.push(section(by.concerns, [matrix ? el("p", { class: "p-sub", text: matrix }) : null].concat(concernCards)));

    // 9. feedback per family, with a balance bar (striped = complaints, solid = happy; numbers always shown)
    var maxN = Math.max.apply(null, [1].concat(d.families.map(function (f) { return f.complaints + f.happy; })));
    nodes.push(section(by.families, [table([t("od.family"), t("od.balance"), t("od.latest_message")], d.families.map(function (f) {
      var bal = el("div", { class: "balance", role: "img", "aria-label": t("od.complaints") + " " + f.complaints + ", " + t("od.happy") + " " + f.happy }, [
        el("span", { class: "bar-bad", style: "width:" + Math.round(f.complaints / maxN * 100) + "%" }), el("span", { class: "bar-good", style: "width:" + Math.round(f.happy / maxN * 100) + "%" }),
        el("small", { text: "▨ " + f.complaints + "  ■ " + f.happy })]);
      return [f.parent, bal, f.latest_message || ""];
    }))]));

    // management: add HR entry, record a mistake, mistake types, thresholds
    nodes.push(await manageCards());
    var more = await Promise.all((S.ownerCards || []).map(function (f) { return Promise.resolve().then(function () { return f(p); }).catch(function () { return null; }); }));
    more.filter(Boolean).forEach(function (x) { nodes.push(x); });
    S.show(nodes.flat ? nodes.flat() : nodes);
  }

  async function manageCards() {
    var res = await Promise.all([S.loadStaff(), client.from("mistake_categories").select("id, name, critical, active").order("name"), client.from("owner_settings").select("value").eq("key", "thresholds").maybeSingle()]);
    var staff = (res[0] || []).filter(function (p) { return p.role !== "owner"; }), cats = res[1].data || [], th = (res[2].data && res[2].data.value) || {};
    var out = [];
    function formCard(title, fields, submit, cta) {
      var msg = el("div", {}), btn = el("button", { class: "btn btn-pink btn-small", type: "submit", text: cta });
      var form = el("form", { novalidate: "novalidate" }, fields.concat([msg, btn]));
      form.addEventListener("submit", async function (e) {
        e.preventDefault(); msg.textContent = ""; btn.disabled = true;
        try { await submit(); S.setFlash(t("od.saved")); dashboard(); }
        catch (err) { msg.appendChild(S.note("err", err && err.message ? err.message : t("od.err"))); btn.disabled = false; }
      });
      return el("details", { class: "action" }, [el("summary", { text: title }), form]);
    }
    var staffSel = function (optional) { return el("select", {}, [S.opt("", optional ? "—" : t("od.pick_staff"))].concat(staff.map(function (p) { return S.opt(p.id, p.full_name); }))); };

    // HR entry
    var hs = staffSel(false), ht = el("select", {}, ["verbal_reminder", "written_warning", "final_warning", "leave", "contract", "appraisal", "praise"].map(function (x) { return S.opt(x, t("od.hr." + x)); }));
    var hd = el("input", { type: "date" }); hd.value = todayCairo();
    var hn = S.textarea(3), hf = el("input", { type: "date" }), hneed = el("input", { type: "checkbox" });
    out.push(formCard(t("od.add_hr"), [S.field(t("od.hr_staff"), hs), S.field(t("od.hr_type"), ht), S.field(t("od.hr_date"), hd), S.field(t("od.hr_note"), hn), S.field(t("od.hr_follow"), hf),
      el("label", { class: "choice small" }, [hneed, el("span", { text: t("od.hr_needs") })])], async function () {
      if (!hs.value) throw new Error(t("od.pick_staff"));
      var r = await client.from("hr_log").insert({ staff_id: hs.value, entry_type: ht.value, entry_date: hd.value, note: hn.value.trim() || null, follow_up_date: hf.value || null, needs_decision: hneed.checked });
      if (r.error) throw new Error(r.error.message);
    }, t("od.add")));

    // mistake
    var ms = staffSel(true), mc = el("select", {}, cats.filter(function (c) { return c.active; }).map(function (c) { return S.opt(c.id, c.name + (c.critical ? " ⚠" : "")); }));
    var md = el("input", { type: "date" }); md.value = todayCairo();
    var msrc = el("select", {}, ["spot_check", "investigation", "complaint"].map(function (x) { return S.opt(x, t("od.src." + x)); }));
    var mconf = el("input", { type: "checkbox" });
    out.push(formCard(t("od.add_mistake"), [S.field(t("od.mistake_staff"), ms), S.field(t("od.mistake_cat"), mc), S.field(t("od.mistake_date"), md), S.field(t("od.mistake_source"), msrc),
      el("label", { class: "choice small" }, [mconf, el("span", {}, [el("strong", { text: t("od.mistake_confirmed") }), el("small", { text: t("od.mistake_confirmed_hint") })])])], async function () {
      var r = await client.from("mistakes").insert({ staff_id: ms.value || null, category_id: mc.value, mistake_date: md.value, source: msrc.value, confirmed: mconf.checked });
      if (r.error) throw new Error(r.error.message);
    }, t("od.add")));

    // mistake types (edit in place)
    var catBox = el("div", {});
    cats.forEach(function (c) {
      var crit = el("input", { type: "checkbox" }), act = el("input", { type: "checkbox" }); crit.checked = c.critical; act.checked = c.active;
      function save() { client.from("mistake_categories").update({ critical: crit.checked, active: act.checked }).eq("id", c.id).then(function (r) { if (r.error) { crit.checked = c.critical; act.checked = c.active; } else { c.critical = crit.checked; c.active = act.checked; } }); }
      crit.addEventListener("change", save); act.addEventListener("change", save);
      catBox.appendChild(el("div", { class: "cat-row" }, [el("strong", { text: c.name }), el("label", {}, [crit, " " + t("od.cat_critical")]), el("label", {}, [act, " " + t("od.cat_active")])]));
    });
    var nn = el("input", { type: "text", maxlength: "80" }), nc = el("input", { type: "checkbox" });
    var addMsg = el("div", {}), addBtn = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("od.cat_add") });
    addBtn.addEventListener("click", async function () {
      addMsg.textContent = ""; if (!nn.value.trim()) return;
      var r = await client.from("mistake_categories").insert({ name: nn.value.trim(), critical: nc.checked });
      if (r.error) { addMsg.appendChild(S.note("err", r.error.message)); return; }
      S.setFlash(t("od.saved")); dashboard();
    });
    out.push(el("details", { class: "action" }, [el("summary", { text: t("od.categories") }), catBox, S.field(t("od.cat_new"), nn), el("label", { class: "choice small" }, [nc, el("span", { text: t("od.cat_critical") })]), addMsg, addBtn]));

    // thresholds
    var inputs = {};
    var thFields = ["absence_days", "late_minutes", "confirmed_faults", "complaints"].map(function (m) {
      var w = el("input", { type: "number", min: "1", max: "9999" }), a = el("input", { type: "number", min: "1", max: "9999" });
      var cur = th[m] || {}; w.value = cur.watch != null ? cur.watch : ""; a.value = cur.action != null ? cur.action : "";
      inputs[m] = { watch: w, action: a };
      return el("div", { class: "f-grid" }, [S.field(t("od.t." + m) + ": " + t("od.watch"), w), S.field(t("od.t." + m) + ": " + t("od.action"), a)]);
    });
    out.push(formCard(t("od.settings"), [el("p", { class: "p-sub", text: t("od.settings_hint") })].concat(thFields), async function () {
      var v = {};
      Object.keys(inputs).forEach(function (m) { v[m] = { watch: Number(inputs[m].watch.value), action: Number(inputs[m].action.value) }; if (!(v[m].watch >= 1 && v[m].action >= v[m].watch)) throw new Error(t("od.t_bad")); });
      var r = await client.from("owner_settings").update({ value: v, updated_at: new Date().toISOString() }).eq("key", "thresholds");
      if (r.error) throw new Error(r.error.message);
    }, t("od.save")));
    return S.card(out);
  }

  // ------------------------------------------------------------------ Attendance sheet
  var attDate = null;
  async function attendance() {
    if (!S.isMgmt()) return S.routes[""]();
    attDate = attDate || todayCairo();
    S.loadingView();
    var rows;
    try { rows = await S.rpc("staff_attendance_day", { p_date: attDate }); } catch (e) { S.show([S.note("err", S.msgFromError(e))]); return; }
    var dateIn = el("input", { type: "date", max: todayCairo() }); dateIn.value = attDate;
    dateIn.addEventListener("change", function () { if (dateIn.value) { attDate = dateIn.value; attendance(); } });
    var nodes = [S.card([el("h1", { text: t("att.title") }), el("p", { class: "p-sub", text: t("att.intro") }), S.field(t("att.date"), dateIn)])];
    if (!rows.length) nodes.push(S.note("info", t("att.none")));
    rows.forEach(function (r) {
      var st = el("select", {}, ["present", "absent", "leave"].map(function (x) { return S.opt(x, t("att." + x)); })); st.value = r.status || "present";
      var late = el("input", { type: "number", min: "0", max: "600", inputmode: "numeric" }); late.value = r.minutes_late || 0;
      var why = el("input", { type: "text", maxlength: "200" }); why.value = r.reason || "";
      function sync() { late.disabled = st.value !== "present"; if (late.disabled) late.value = 0; }
      st.addEventListener("change", sync); sync();
      var msg = el("span", { class: "att-msg" }), save = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("att.save") });
      save.addEventListener("click", async function () {
        save.disabled = true; msg.textContent = "";
        try { await S.rpc("record_staff_attendance", { p_staff: r.staff_id, p_date: attDate, p_status: st.value, p_minutes_late: Number(late.value) || 0, p_reason: why.value.trim() || null }); msg.textContent = t("att.saved"); msg.className = "att-msg ok"; }
        catch (e) { msg.textContent = t("att.err"); msg.className = "att-msg bad"; }
        finally { save.disabled = false; }
      });
      nodes.push(S.card([el("strong", { text: r.full_name }), el("div", { class: "f-grid" }, [S.field(t("att.status"), st), S.field(t("att.late"), late)]), S.field(t("att.reason"), why), el("div", { class: "actions" }, [save, msg])]));
    });
    S.show(nodes);
  }

  // ------------------------------------------------------------------ Staff concern form (everyone on staff)
  function concern() {
    var cat = el("select", {}, ["supplies", "workload", "conduct", "facilities", "pay", "other"].map(function (x) { return S.opt(x, t("od.cat." + x)); }));
    var text = S.textarea(6), anon = el("input", { type: "checkbox" });
    var err = el("div", {}), ok = el("div", {}), send = el("button", { type: "submit", class: "btn btn-pink", text: t("con.send") });
    var form = el("form", { novalidate: "novalidate" }, [S.field(t("con.category"), cat), S.field(t("con.text"), text),
      el("label", { class: "choice" }, [anon, el("span", {}, [el("strong", { text: t("con.anonymous") }), el("small", { text: t("con.anon_hint") })])]), err, send]);
    form.addEventListener("submit", async function (e) {
      e.preventDefault(); err.textContent = ""; ok.textContent = "";
      if (!text.value.trim()) { err.appendChild(S.note("err", t("con.need"))); return; }
      send.disabled = true;
      try { await S.rpc("submit_staff_complaint", { p_category: cat.value, p_description: text.value.trim(), p_anonymous: anon.checked }); form.reset(); ok.appendChild(S.note("ok", t("con.sent"))); }
      catch (x) { err.appendChild(S.note("err", S.msgFromError(x))); }
      finally { send.disabled = false; }
    });
    S.show([S.card([el("h1", { text: t("con.title") }), el("p", { class: "p-sub", text: t("con.intro") }), ok, form])]);
  }

  S.routes.owner = dashboard;
  S.routes.attendance = attendance;
  S.routes.concern = concern;
})();
