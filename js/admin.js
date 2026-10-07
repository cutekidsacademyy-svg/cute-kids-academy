// The admin area (#/admin): today at a glance, children (search, profile, move, withdraw), classes (staff, capacity),
// and the academy's settings. Everything is read and written through database functions that only admin, manager and
// owner can run; hiding the menu item is only a convenience. Text is only ever inserted as text.
(function () {
  "use strict";
  var S = window.CKAStaff, el = CKA.el, t = CKA.t, client = CKA.client;
  var filter = { q: "", cls: "", withdrawn: false }, flash = null, editClass = null;

  function lang() { return CKA.getLang(); }
  function fmtDate(iso) { return new Intl.DateTimeFormat(lang() === "ar" ? "ar-EG" : "en-GB", { timeZone: "Africa/Cairo", dateStyle: "medium" }).format(new Date(iso)); }
  function fmtDT(iso) { return new Intl.DateTimeFormat(lang() === "ar" ? "ar-EG" : "en-GB", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)); }
  function guard() { if (!S.isMgmt()) { S.routes[""](); return false; } return true; }
  function input(type, attrs, value) { var i = el("input", Object.assign({ type: type }, attrs || {})); if (value != null) i.value = value; return i; }
  function accessPill(a) { return S.pill((a === "active" ? "✓ " : a === "off" ? "⛔ " : "✉ ") + t("ad.access." + a), a === "off" ? "urg-critical" : a === "invited" ? "urg-urgent" : "st-resolved"); }

  function tabs(active) {
    var bar = el("div", { class: "actions" });
    [["today", "#/admin"], ["children", "#/admin/children"], ["classes", "#/admin/classes"], ["settings", "#/admin/settings"]].forEach(function (x) {
      bar.appendChild(el("a", { class: "filter-pill" + (active === x[0] ? " active" : ""), href: x[1], text: t("ad.tab." + x[0]), style: "text-decoration:none" }));
    });
    if (S.isTop()) bar.appendChild(el("a", { class: "filter-pill", href: "#/people", text: t("ad.tab.people"), style: "text-decoration:none" }));
    return S.card([el("h1", { text: t("ad.title") }), bar], "blue");
  }
  function shown(nodes) { if (flash) { nodes.unshift(S.note(flash.kind, flash.text)); flash = null; } S.show(nodes); }

  function admin(parts) {
    if (!guard()) return;
    var page = parts[1] || "today";
    if (page === "children") return children();
    if (page === "child") return childProfile(parts[2]);
    if (page === "classes") return classes();
    if (page === "settings") return settings();
    return today();
  }

  // ------------------------------------------------------------------ Today
  async function today() {
    S.loadingView();
    var h; try { h = await S.rpc("admin_home"); } catch (e) { return S.show([S.note("err", S.msgFromError(e))]); }
    function tile(n, label, href, bad) { return el("a", { class: "tile" + (bad && n ? " bad" : ""), href: href, style: "text-decoration:none;color:inherit" }, [el("strong", { text: String(n) }), el("span", { text: label })]); }
    shown([tabs("today"), S.card([el("h2", { text: t("ad.today.title") }), el("div", { class: "tiles" }, [
      tile(h.present, t("ad.t.present"), "#/door"), tile(h.absent_reported, t("ad.t.absent"), "#/door"), tile(h.not_arrived, t("ad.t.notarrived"), "#/door", true),
      tile(h.reports_ready, t("ad.t.reports"), "#/daily", true), tile(h.reports_sent, t("ad.t.sent"), "#/daily"), tile(h.unread_important, t("ad.t.unread"), "#/announcements", true),
      tile(h.events_waiting, t("ad.t.events"), "#/events", true), tile(h.cases_open, t("ad.t.cases"), "#/"), tile(h.cases_overdue, t("ad.t.overdue"), "#/", true),
      tile(h.cases_critical, t("ad.t.critical"), "#/", true), tile(h.applications_new, t("ad.t.apps"), "#/applications"), tile(h.children, t("ad.t.children"), "#/admin/children")])])]);
  }

  // ------------------------------------------------------------------ Children
  async function children() {
    S.loadingView();
    var res = await Promise.all([S.rpc("admin_children"), client.from("classes").select("id, name").order("name")]);
    var rows = res[0], cls = res[1].data || [], list = el("div", {});
    var q = input("search", { placeholder: t("ad.ch.search"), "aria-label": t("ad.ch.search") }, filter.q);
    var sel = el("select", {}, [S.opt("", t("ad.ch.all_classes"))].concat(cls.map(function (c) { return S.opt(c.id, c.name); }))); sel.value = filter.cls;
    var wd = input("checkbox"); wd.checked = filter.withdrawn;
    function draw() {
      list.textContent = "";
      var ql = filter.q.toLowerCase().trim();
      var f = rows.filter(function (r) {
        if (!filter.withdrawn && !r.active) return false;
        if (filter.cls && r.class_id !== filter.cls) return false;
        if (!ql) return true;
        return r.child_name.toLowerCase().indexOf(ql) >= 0 || (r.parents || []).some(function (p) { return (p.name || "").toLowerCase().indexOf(ql) >= 0 || (p.phone || "").indexOf(ql) >= 0; });
      });
      if (!f.length) list.appendChild(el("p", { class: "p-sub", text: t("ad.ch.none") }));
      f.forEach(function (r) {
        list.appendChild(el("a", { class: "case-item", href: "#/admin/child/" + r.child_id }, [
          el("div", { class: "case-top" }, [el("strong", { text: r.child_name }), S.pill(r.class_name || t("ad.ch.noclass")), r.has_allergy ? S.pill("⚠ " + t("ad.ch.allergy"), "urg-critical") : null, !r.active ? S.pill(t("ad.ch.withdrawn_tag"), "off") : null].filter(Boolean)),
          el("div", {}, (r.parents || []).map(function (p) { return el("small", { text: p.name + (p.phone ? " · " + p.phone : "") + " · " + t("ad.access." + p.access) }); }))]));
      });
    }
    q.addEventListener("input", function () { filter.q = q.value; draw(); }); sel.addEventListener("change", function () { filter.cls = sel.value; draw(); }); wd.addEventListener("change", function () { filter.withdrawn = wd.checked; draw(); });
    draw();
    shown([tabs("children"), S.card([q, S.field(t("ad.pr.class"), sel), el("label", { class: "choice" }, [wd, el("span", { text: t("ad.ch.withdrawn") })]), list])]);
  }

  async function childProfile(id) {
    S.loadingView();
    var res = await Promise.all([S.rpc("admin_child_profile", { p_child: id }), client.from("classes").select("id, name").order("name")]);
    var p = res[0], cls = res[1].data || [];
    if (!p) return S.failView();
    var c = p.child, nodes = [tabs("children"), S.link("#/admin/children", t("ad.pr.back"))];
    var kids = [el("div", { class: "case-top" }, [c.active ? null : S.pill(t("ad.ch.withdrawn_tag"), "off"), S.pill(c.class_name || t("ad.ch.noclass"))].filter(Boolean)), el("h1", { text: c.name }),
      S.kv(t("ad.pr.dob"), c.date_of_birth), S.kv(t("ad.pr.since"), fmtDate(c.enrolled_since))];
    if (c.active) {
      var sel = el("select", {}, cls.map(function (x) { return S.opt(x.id, x.name); })); sel.value = c.class_id || "";
      var mv = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("ad.pr.move_btn") });
      mv.addEventListener("click", async function () { mv.disabled = true; try { await S.rpc("child_move_class", { p_child: id, p_class: sel.value }); flash = { kind: "ok", text: t("ad.pr.moved") }; childProfile(id); } catch (e) { mv.disabled = false; S.show([S.note("err", S.msgFromError(e))]); } });
      kids.push(S.field(t("ad.pr.move"), sel), el("div", { class: "actions" }, [mv]));
    }
    nodes.push(S.card(kids));

    nodes.push(S.card([el("h2", { text: t("ad.pr.parents") })].concat(p.parents.length ? p.parents.map(function (x) {
      return el("div", { class: "kv" }, [el("strong", { text: x.name }), x.phone ? el("a", { class: "p-link", href: "tel:" + x.phone.replace(/\s+/g, ""), text: x.phone, dir: "ltr" }) : null, x.email ? el("small", { dir: "ltr", text: x.email }) : null, accessPill(x.access)].filter(Boolean));
    }) : [el("p", { class: "p-sub", text: t("ad.pr.none") })])));
    nodes.push(S.card([el("h2", { text: t("ad.pr.pickups") })].concat(p.pickups.length ? p.pickups.map(function (x) {
      return el("div", { class: "kv" }, [el("strong", { text: x.name + " · " + x.relationship }), el("small", { dir: "ltr", text: x.phone }), x.has_id_photo ? el("small", { text: "✓ " + t("ad.pr.id_photo") }) : null].filter(Boolean));
    }) : [el("p", { class: "p-sub", text: t("ad.pr.none") })])));
    var hl = p.health || {};
    nodes.push(S.card([el("h2", { text: t("ad.pr.health") }), S.kv(t("ad.pr.allergies"), hl.allergies || t("ad.pr.none")), S.kv(t("ad.pr.conditions"), hl.medical_conditions || t("ad.pr.none")),
      S.kv(t("ad.pr.medications"), hl.medications || t("ad.pr.none")), S.kv(t("ad.pr.doctor"), [hl.doctor_name, hl.doctor_phone].filter(Boolean).join(" · ") || t("ad.pr.none"))], "blue"));
    var cn = p.consents;
    nodes.push(S.card([el("h2", { text: t("ad.pr.consents") })].concat(cn ? ["photos_class", "photos_social", "outings", "emergency_treatment", "birthday_wall"].map(function (k) { return S.kv(t("ad.c." + k), cn[k] ? t("ad.yes") : t("ad.no")); }) : [el("p", { class: "p-sub", text: t("ad.pr.none") })])));

    var docs = el("div", {});
    nodes.push(S.card([el("h2", { text: t("ad.pr.documents") }), docs]));
    if (!p.documents.length) docs.appendChild(el("p", { class: "p-sub", text: t("ad.pr.none") }));
    p.documents.forEach(function (d) {
      var b = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("ad.pr.open") });
      b.addEventListener("click", async function () {
        var w = window.open("about:blank", "_blank"), bucket = /^drafts\//.test(d.path) ? "registrations" : "child-files";
        var r = await client.storage.from(bucket).createSignedUrl(d.path, 300);
        if (r.data && w) w.location.href = r.data.signedUrl; else if (w) w.close();
      });
      docs.appendChild(el("div", { class: "kv" }, [el("strong", { text: d.kind.replace(/_/g, " ") + (d.file_name ? " · " + d.file_name : "") }), b]));
    });

    nodes.push(S.card([el("h2", { text: t("ad.pr.log") })].concat(p.log.length ? [el("ul", { class: "timeline" }, p.log.map(function (g) {
      return el("li", {}, [el("div", { class: "tl-when", text: fmtDT(g.at) + (g.by ? " · " + g.by : "") }), el("div", { class: "tl-what", text: t("ad.log." + g.kind) + ": " + g.summary })]);
    }))] : [el("p", { class: "p-sub", text: t("ad.pr.none") })])));

    if (c.active) {
      var why = input("text", { maxlength: "300" }), msg = el("div", {}), wd = el("button", { type: "button", class: "btn btn-outline", text: t("ad.wd.btn") });
      wd.addEventListener("click", async function () {
        msg.textContent = "";
        if (why.value.trim().length < 3) { msg.appendChild(S.note("err", t("ad.wd.need"))); return; }
        if (!window.confirm(t("ad.wd.confirm"))) return;
        wd.disabled = true;
        try { await S.rpc("child_withdraw", { p_child: id, p_reason: why.value }); flash = { kind: "ok", text: t("ad.wd.done") }; childProfile(id); } catch (e) { wd.disabled = false; msg.appendChild(S.note("err", S.msgFromError(e))); }
      });
      nodes.push(S.card([el("h2", { text: t("ad.wd.title") }), el("p", { class: "p-sub", text: t("ad.wd.hint") }), S.field(t("ad.wd.reason"), why), msg, wd]));
    } else {
      var rc = el("select", {}, cls.map(function (x) { return S.opt(x.id, x.name); })), rm = el("div", {}), re = el("button", { type: "button", class: "btn btn-pink", text: t("ad.re.btn") });
      re.addEventListener("click", async function () { re.disabled = true; try { await S.rpc("child_reinstate", { p_child: id, p_class: rc.value }); flash = { kind: "ok", text: t("ad.re.done") }; childProfile(id); } catch (e) { re.disabled = false; rm.appendChild(S.note("err", S.msgFromError(e))); } });
      nodes.push(S.card([el("h2", { text: t("ad.re.title") }), S.field(t("ad.pr.class"), rc), rm, re]));
    }
    shown(nodes);
  }

  // ------------------------------------------------------------------ Classes
  async function classes() {
    S.loadingView();
    var res = await Promise.all([S.rpc("admin_classes"), client.from("profiles").select("id, full_name, job_title").eq("role", "teacher").eq("active", true).order("full_name")]);
    var rows = res[0], teachers = res[1].data || [], nodes = [tabs("classes")];
    var add = el("button", { type: "button", class: "btn btn-pink", text: "+ " + t("ad.cl.new") });
    add.addEventListener("click", function () { editClass = { id: null }; classes(); });
    nodes.push(S.card([el("div", { class: "actions" }, [add]), el("p", { class: "p-sub" }, [S.link("#/menu", t("ad.cl.schedule_link"))])]));
    if (editClass) nodes.push(classForm(editClass));
    rows.forEach(function (c) { nodes.push(classCard(c, teachers)); });
    shown(nodes);
  }

  function classForm(c) {
    var name = input("text", { maxlength: "60" }, c.name || ""), age = input("text", { maxlength: "40" }, c.age_group || ""), cap = input("number", { min: "1", max: "100", inputmode: "numeric" }, c.capacity != null ? c.capacity : "");
    var msg = el("div", {}), save = el("button", { type: "button", class: "btn btn-pink", text: t("ad.cl.save") }), cancel = el("button", { type: "button", class: "btn btn-outline", text: "✕" });
    cancel.addEventListener("click", function () { editClass = null; classes(); });
    save.addEventListener("click", async function () {
      msg.textContent = "";
      if (name.value.trim().length < 2 || !age.value.trim()) { msg.appendChild(S.note("err", t("ad.cl.need"))); return; }
      save.disabled = true;
      try { await S.rpc("class_save", { p_id: c.id || null, p_name: name.value, p_age_group: age.value, p_capacity: cap.value === "" ? null : Number(cap.value) }); editClass = null; flash = { kind: "ok", text: t("ad.cl.saved") }; classes(); }
      catch (e) { save.disabled = false; msg.appendChild(S.note("err", S.msgFromError(e))); }
    });
    return S.card([el("h2", { text: c.id ? t("ad.cl.edit") : t("ad.cl.new") }), S.field(t("ad.cl.name"), name), el("div", { class: "f-grid" }, [S.field(t("ad.cl.age"), age), S.field(t("ad.cl.cap"), cap)]), msg, el("div", { class: "actions" }, [save, cancel])]);
  }

  function classCard(c, teachers) {
    var full = c.capacity != null && c.enrolled >= c.capacity;
    var ed = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("ad.cl.edit") });
    ed.addEventListener("click", function () { editClass = { id: c.class_id, name: c.name, age_group: c.age_group, capacity: c.capacity }; classes(); });
    var kids = [el("div", { class: "sec-head" }, [el("h2", { text: c.name + " · " + c.age_group }), ed]),
      el("div", { class: "tiles" }, [el("div", { class: "tile" + (full ? " bad" : "") }, [el("strong", { text: c.enrolled + (c.capacity != null ? " / " + c.capacity : "") }), el("span", { text: t("ad.cl.enrolled") + (full ? " · " + t("ad.cl.full") : "") })]),
        el("div", { class: "tile good" }, [el("strong", { text: String(c.present_today) }), el("span", { text: t("ad.cl.present") })])]),
      S.kv(t("ad.cl.head"), c.head_teacher_name || "—"), el("h3", { text: t("ad.cl.staff") })];
    if (!c.staff.length) kids.push(el("p", { class: "p-sub", text: t("ad.cl.none_staff") }));
    c.staff.forEach(function (s) {
      var rm = el("button", { type: "button", class: "p-link", text: t("ad.cl.remove") });
      rm.addEventListener("click", async function () { try { await S.rpc("class_staff_remove", { p_class: c.class_id, p_staff: s.id }); classes(); } catch (e) {} });
      kids.push(el("div", { class: "kv" }, [el("strong", { text: s.name + (s.class_role ? " · " + t("ad.cl.r." + s.class_role) : "") + (c.head_teacher_id === s.id ? " ★" : "") }), rm]));
    });
    var who = el("select", {}, [S.opt("", t("ad.cl.pick_staff"))].concat(teachers.map(function (x) { return S.opt(x.id, x.full_name + (x.job_title ? " (" + t("jt." + x.job_title) + ")" : "")); })));
    var role = el("select", {}, ["head", "teacher", "co_teacher", "assistant"].map(function (r) { return S.opt(r, t("ad.cl.r." + r)); }));
    var msg = el("div", {}), go = el("button", { type: "button", class: "btn btn-outline btn-small", text: "+ " + t("ad.cl.add_staff") });
    go.addEventListener("click", async function () { msg.textContent = ""; if (!who.value) return; try { await S.rpc("class_staff_set", { p_class: c.class_id, p_staff: who.value, p_role: role.value }); classes(); } catch (e) { msg.appendChild(S.note("err", S.msgFromError(e))); } });
    kids.push(el("div", { class: "f-grid" }, [S.field(t("ad.cl.add_staff"), who), S.field(t("ad.cl.role"), role)]), msg, go);
    return S.card(kids);
  }

  // ------------------------------------------------------------------ Settings
  async function settings() {
    S.loadingView();
    var r = await client.from("academy_settings").select("*").maybeSingle(), s = r.data || {};
    var phone = input("tel", { dir: "ltr" }, s.phone || ""), wa = input("tel", { dir: "ltr", inputmode: "numeric" }, s.whatsapp || ""), email = input("email", { dir: "ltr" }, s.email || "");
    var ae = input("text", { maxlength: "300" }, s.address_en || ""), aa = input("text", { maxlength: "300", dir: "rtl" }, s.address_ar || ""), close = input("time", {}, String(s.overtime_close || "18:00").slice(0, 5));
    var msg = el("div", {}), save = el("button", { type: "button", class: "btn btn-pink", text: t("ad.set.save") });
    save.addEventListener("click", async function () {
      msg.textContent = ""; save.disabled = true;
      try { await S.rpc("academy_settings_save", { p_phone: phone.value, p_whatsapp: wa.value, p_email: email.value, p_address_en: ae.value, p_address_ar: aa.value, p_overtime_close: close.value }); msg.appendChild(S.note("ok", t("ad.set.saved"))); }
      catch (e) { msg.appendChild(S.note("err", S.msgFromError(e))); }
      save.disabled = false;
    });
    shown([tabs("settings"), S.card([el("h2", { text: t("ad.set.title") }), el("div", { class: "f-grid" }, [S.field(t("ad.set.phone"), phone), S.field(t("ad.set.whatsapp"), wa)]), S.field(t("ad.set.email"), email),
      el("div", { class: "f-grid" }, [S.field(t("ad.set.addr_en"), ae), S.field(t("ad.set.addr_ar"), aa)]), S.field(t("ad.set.close"), close), msg, save]),
      S.card([el("h2", { text: t("ad.fixed.title") }), el("p", { text: t("ad.fixed.hours") }), el("p", { text: t("ad.fixed.urgency") }), el("p", { class: "p-sub", text: t("ad.fixed.change") }),
        el("p", { class: "p-sub" }, [t("ad.fixed.links") + " "]), el("div", { class: "actions" }, [S.link("#/daily", t("ad.fixed.reports")), S.link("#/photos", t("ad.fixed.photos"))])], "blue")]);
  }

  S.routes.admin = admin;
})();
