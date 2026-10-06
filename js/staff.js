// /staff: the staff dashboard. Case queue, case page with actions, accident log, ratings
// (manager/owner), and people management (admin/manager/owner).
// Everything is read and written through Supabase, which enforces who may see or do what;
// the checks here only decide which buttons to show. Text from the database is always
// inserted as text, never as HTML.
(function () {
  "use strict";
  var el = CKA.el, t = CKA.t, L = window.CKALogic, client = CKA.client;
  var TZ = "Africa/Cairo";
  var me = null, view = document.getElementById("view");
  var staffCache = null, flash = null;
  var filters = { type: "", urgency: "", status: "open", classId: "", mine: false };

  function lang() { return CKA.getLang(); }
  function locale() { return lang() === "ar" ? "ar-EG" : "en-GB"; }
  function fmt(iso) { return new Intl.DateTimeFormat(locale(), { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)); }
  function when(iso) { return L.whenText(iso, Date.now(), lang()); }
  function isMgmt() { return L.canInviteParents(me.role); }
  function isTop() { return L.canManageStaff(me.role); }

  function show(nodes) { view.textContent = ""; nodes.forEach(function (n) { if (n) view.appendChild(n); }); }
  function card(kids, cls) { return el("div", { class: "p-card " + (cls || "") }, kids); }
  function note(kind, text) { return el("div", { class: "note " + kind, role: "status", "aria-live": "polite", text: text }); }
  function pill(text, cls) { return el("span", { class: "pill " + (cls || ""), text: text }); }
  function link(href, text, cls) { return el("a", { class: cls || "p-link", href: href, text: text }); }
  function field(labelText, control) { return el("div", { class: "f-row" }, [el("label", { text: labelText }), control]); }
  function loadingView() { show([el("p", { class: "p-sub", text: t("s.loading") })]); }
  function failView() { show([card([note("err", t("s.error")), link("#/", t("s.nav.queue"))])]); }
  function opt(value, text) { return el("option", { value: value, text: text }); }
  function msgFromError(e) { return (e && e.message) || t("s.error"); }

  async function rpc(name, args) {
    var r = await client.rpc(name, args || {});
    if (r.error) throw new Error(r.error.message);
    return r.data;
  }
  async function loadStaff() { if (!staffCache) staffCache = await rpc("staff_list"); return staffCache; }

  function urgPill(u) { return pill(t("s.urg." + u), "urg-" + u); }
  function stPill(s) { return pill(t("s.st." + s), "st-" + s); }

  // ------------------------------------------------------------------ Queue
  async function queue() {
    loadingView();
    var rows = await rpc("staff_queue", { p_include_done: true });
    var now = Date.now(), nodes = [];
    if (isTop()) nodes.push(overviewCard(L.overview(rows, now)));

    var classes = {};
    rows.forEach(function (r) { if (r.class_id) classes[r.class_id] = r.class_name; });
    var list = el("div", {});
    function sel(key, label, options) {
      var s = el("select", {}, options.map(function (o) { return opt(o[0], o[1]); }));
      s.value = filters[key] || "";
      s.addEventListener("change", function () { filters[key] = s.value; draw(); });
      return el("div", { class: "f-row" }, [el("label", { text: label }), s]);
    }
    var mine = el("input", { type: "checkbox" }); mine.checked = filters.mine;
    mine.addEventListener("change", function () { filters.mine = mine.checked; draw(); });
    var bar = el("div", { class: "filters" }, [
      sel("type", t("s.f.type"), [["", t("s.f.any")], ["complaint", t("s.type.complaint")], ["safety_concern", t("s.type.safety_concern")]]),
      sel("urgency", t("s.f.urgency"), [["", t("s.f.any")], ["critical", t("s.urg.critical")], ["urgent", t("s.urg.urgent")], ["can_wait", t("s.urg.can_wait")]]),
      sel("status", t("s.f.status"), [["open", t("s.f.open")], ["all", t("s.f.all")], ["received", t("s.st.received")], ["acknowledged", t("s.st.acknowledged")],
        ["in_progress", t("s.st.in_progress")], ["resolved", t("s.st.resolved")], ["closed", t("s.st.closed")]]),
      sel("classId", t("s.f.class"), [["", t("s.f.any")]].concat(Object.keys(classes).map(function (id) { return [id, classes[id]]; }))),
      el("label", { class: "choice small" }, [mine, el("span", { text: t("s.f.mine") })]),
    ]);
    function draw() {
      var shown = L.filterQueue(rows, filters, me.id);
      list.textContent = "";
      if (!shown.length) list.appendChild(el("p", { class: "p-sub", text: t("s.q.empty") }));
      shown.forEach(function (r) { list.appendChild(queueItem(r, now)); });
    }
    nodes.push(card([bar, list]));
    show(nodes); draw();
  }

  function overviewCard(o) {
    function tile(num, label, cls) { return el("div", { class: "tile " + (cls || "") }, [el("strong", { text: String(num) }), el("span", { text: label })]); }
    var tiles = [1, 2, 3, 4].map(function (n) { return tile(o.byLevel[n] || 0, t("s.ov.open") + " " + n); });
    tiles.push(tile(o.overdue, t("s.ov.overdue"), o.overdue ? "bad" : ""), tile(o.closedThisWeek, t("s.ov.closed"), "good"));
    return card([el("h2", { text: t("s.ov.title") }), el("div", { class: "tiles" }, tiles)], "blue");
  }

  function queueItem(r, now) {
    var st = L.dueState(r.next_due, now), dueText = "";
    if (st === "overdue") dueText = t("s.due.overdue") + " " + when(r.next_due);
    else if (st === "soon" || st === "ok") dueText = t("s.due.by") + " " + when(r.next_due);
    else dueText = t("s.due.done");
    return el("a", { class: "case-item due-" + st, href: "#/case/" + r.id }, [
      el("div", { class: "case-top" }, [el("strong", { text: L.refLabel(r.ref_no) }), stPill(r.status), urgPill(r.urgency),
        r.type === "safety_concern" ? pill(t("s.type.safety_concern"), "urg-critical") : null, pill(t("s.q.level") + " " + r.escalation_level)]),
      el("div", { class: "case-title", text: r.title }),
      el("small", { text: r.child_name + (r.class_name ? " · " + r.class_name : "") + " · " + t("s.q.parent") + ": " + r.parent_name }),
      el("small", { text: (r.assignee_name ? t("s.c.handler") + ": " + r.assignee_name : t("s.q.unassigned")) + (r.about_staff_name ? " · " + t("s.c.about") + ": " + r.about_staff_name : "") }),
      el("small", { class: "due-text", text: dueText }),
    ]);
  }

  // ------------------------------------------------------------------ One case
  async function casePage(id) {
    loadingView();
    var res = await Promise.all([
      client.rpc("staff_case", { p_id: id }),
      client.from("submission_events").select("id, event_type, message, old_value, new_value, actor_name, visible_to_parent, created_at").eq("submission_id", id).order("created_at"),
      client.from("attachments").select("id, storage_path, file_name").eq("submission_id", id),
      loadStaff(),
    ]);
    var c = res[0].data && res[0].data[0];
    if (res[0].error || !c) return failView();
    var events = res[1].data || [], files = res[2].data || [], staff = res[3] || [];
    var finished = c.status === "resolved" || c.status === "closed";
    var reload = function (msg) { flash = msg || null; casePage(id); };

    var nodes = [link("#/", t("s.back"))];
    if (flash) { nodes.push(note("ok", flash)); flash = null; }

    var phoneRow = c.parent_phone ? el("a", { class: "btn btn-outline btn-small", href: "tel:" + c.parent_phone.replace(/\s+/g, ""), text: "📞 " + t("s.c.call") + " " + c.parent_phone }) : null;
    var st = L.dueState(finished ? null : (c.status === "received" ? c.acknowledge_by : c.resolve_by), Date.now());
    nodes.push(card([
      el("div", { class: "case-top" }, [el("strong", { text: L.refLabel(c.ref_no) }), stPill(c.status), urgPill(c.urgency), pill(t("s.q.level") + " " + c.escalation_level)]),
      el("h1", { text: c.title }),
      kv(t("s.c.child"), c.child_name + (c.class_name ? " · " + c.class_name : "")),
      kv(t("s.c.parent"), c.parent_name), phoneRow ? el("div", { class: "kv" }, [phoneRow]) : null,
      kv(t("s.c.handler"), c.assignee_name || t("s.q.unassigned")),
      c.about_staff_name ? kv(t("s.c.about"), c.about_staff_name) : null,
      kv(t("s.c.created"), fmt(c.created_at)),
      !finished ? kv(c.status === "received" ? t("s.due.by") + " (1)" : t("s.due.by") + " (2)", when(c.status === "received" ? c.acknowledge_by : c.resolve_by)) : null,
      c.parent_satisfied === null ? null : kv(t("s.c.satisfied"), c.parent_satisfied ? t("s.c.yes") : t("s.c.no")),
      c.has_investigation ? note("info", t("s.c.investigation")) : null,
      c.investigation_id ? link("#/investigation/" + c.investigation_id, t("s.v.open.link") + " →", "btn btn-outline btn-small") : null,
    ].filter(Boolean), st === "overdue" ? "overdue" : ""));

    var story = [el("h2", { text: t("s.c.desc") }), el("p", { class: "preline", text: c.description })];
    if (files.length) {
      var gallery = el("div", { class: "photos" });
      story.push(el("h3", { text: t("s.c.photos") }), gallery);
      files.forEach(async function (f) {
        var s = await client.storage.from("attachments").createSignedUrl(f.storage_path, 300);
        if (s.data) gallery.appendChild(el("a", { href: s.data.signedUrl, target: "_blank", rel: "noopener" }, [el("img", { src: s.data.signedUrl, alt: f.file_name })]));
      });
    }
    nodes.push(card(story, "blue"));
    nodes.push(actionsCard(c, finished, staff, reload));
    nodes.push(timelineCard(events));
    show(nodes);
  }

  function kv(k, v) { return el("div", { class: "kv" }, [el("span", { class: "k", text: k }), el("span", { class: "preline", text: v })]); }

  // One collapsible block per action. `run` returns a promise; errors are shown inside the block.
  function action(title, cls, build) { var d = el("details", { class: "action " + (cls || "") }, [el("summary", { text: title })]); build(d); return d; }
  function actionForm(details, inputs, buttonText, onSubmit, btnClass) {
    var msg = el("div", {}), btn = el("button", { class: btnClass || "btn btn-pink btn-small", type: "submit", text: buttonText });
    var form = el("form", { novalidate: "novalidate" }, inputs.concat([msg, btn]));
    form.addEventListener("submit", async function (e) {
      e.preventDefault(); msg.textContent = ""; btn.disabled = true;
      try { await onSubmit(); }
      catch (err) { msg.appendChild(note("err", msgFromError(err))); btn.disabled = false; }
    });
    details.appendChild(form);
  }
  function textarea(rows, ph) { return el("textarea", { rows: String(rows || 3), maxlength: "4000", placeholder: ph || "" }); }

  function actionsCard(c, finished, staff, reload) {
    var id = c.id, kids = [el("h2", { text: t("s.c.actions") })];
    if (finished) kids.push(el("p", { class: "p-sub", text: t("s.c.finished") }));

    if (c.status === "received") kids.push(action(t("s.c.ack"), "", function (d) {
      var m = textarea(3); m.setAttribute("aria-label", t("s.c.ack.msg"));
      actionForm(d, [field(t("s.c.ack.msg"), m)], t("s.c.ack.btn"), async function () { await rpc("staff_acknowledge", { p_submission: id, p_message: m.value.trim() || null }); reload(t("s.saved")); });
    }));
    if (c.status === "received" || c.status === "acknowledged") kids.push(action(t("s.c.start"), "", function (d) {
      actionForm(d, [], t("s.c.start"), async function () { await rpc("staff_mark_in_progress", { p_submission: id }); reload(t("s.saved")); });
    }));
    if (!finished) {
      kids.push(action(t("s.c.assign"), "", function (d) {
        var s = el("select", {}, [opt("", t("s.c.assign.pick"))].concat(staff.filter(function (p) { return p.id !== c.assigned_to; }).map(function (p) { return opt(p.id, p.full_name + " (" + t("role." + p.role) + ")"); })));
        actionForm(d, [field(t("s.c.assign"), s)], t("s.c.assign.btn"), async function () {
          if (!s.value) throw new Error(t("s.c.needperson"));
          await rpc("staff_assign", { p_submission: id, p_staff: s.value }); reload(t("s.saved"));
        });
      }));
      if (c.type !== "safety_concern") kids.push(action(t("s.c.urgency"), "", function (d) {
        var u = el("select", {}, ["critical", "urgent", "can_wait"].filter(function (x) { return x !== c.urgency; }).map(function (x) { return opt(x, t("s.urg." + x)); }));
        var why = textarea(2);
        actionForm(d, [field(t("s.c.urgency"), u), field(t("s.c.reason"), why)], t("s.c.urgency.btn"), async function () {
          if (!why.value.trim()) throw new Error(t("s.c.needreason"));
          await rpc("change_urgency", { p_submission: id, p_urgency: u.value, p_reason: why.value.trim() }); reload(t("s.saved"));
        });
      }));
      if (c.status !== "closed") kids.push(action(t("s.c.update"), "", function (d) {
        var m = textarea(3);
        actionForm(d, [field(t("s.c.update"), m)], t("s.c.update.btn"), async function () {
          if (!m.value.trim()) throw new Error(t("s.c.needmsg"));
          var r = await client.from("submission_events").insert({ submission_id: id, actor_id: me.id, event_type: "update", message: m.value.trim(), visible_to_parent: true });
          if (r.error) throw new Error(r.error.message);
          reload(t("s.saved"));
        });
      }));
    }
    kids.push(action("🔒 " + t("s.c.note"), "internal", function (d) {
      var m = textarea(3);
      d.appendChild(el("p", { class: "internal-hint", text: t("s.c.note.hint") }));
      actionForm(d, [m], t("s.c.note.btn"), async function () {
        if (!m.value.trim()) throw new Error(t("s.c.needmsg"));
        var r = await client.from("submission_events").insert({ submission_id: id, actor_id: me.id, event_type: "internal_note", message: m.value.trim(), visible_to_parent: false });
        if (r.error) throw new Error(r.error.message);
        reload(t("s.saved"));
      });
    }));
    if (!finished && c.escalation_level < 4) kids.push(action(t("s.c.escalate.to") + " " + (c.escalation_level + 1), "", function (d) {
      var why = textarea(2);
      actionForm(d, [field(t("s.c.escalate.reason"), why)], t("s.c.escalate.btn"), async function () {
        if (!why.value.trim()) throw new Error(t("s.c.needreason"));
        await rpc("staff_escalate", { p_submission: id, p_reason: why.value.trim() }); reload(t("s.saved"));
      }, "btn btn-outline btn-small");
    }));
    if (!finished) kids.push(action(t("s.c.resolve"), "", function (d) {
      var m = textarea(3);
      actionForm(d, [field(t("s.c.resolve.msg"), m)], t("s.c.resolve.btn"), async function () {
        if (!m.value.trim()) throw new Error(t("s.c.needmsg"));
        await rpc("staff_resolve", { p_submission: id, p_message: m.value.trim() }); reload(t("s.saved"));
      });
    }));
    return card(kids);
  }

  function eventDetail(ev) {
    switch (ev.event_type) {
      case "urgency_changed": return t("s.urg." + ev.old_value) + " → " + t("s.urg." + ev.new_value) + (ev.message ? " — " + ev.message : "");
      case "status_changed": return t("s.st." + ev.new_value) + (ev.message ? " — " + ev.message : "");
      case "escalated": return t("s.q.level") + " " + ev.old_value + " → " + ev.new_value + (ev.message ? " — " + ev.message : "");
      case "investigation_step": return ev.new_value;
      case "created": return "";
      default: return ev.message || "";
    }
  }
  function timelineCard(events) {
    var tl = el("ol", { class: "timeline" });
    events.forEach(function (ev) {
      tl.appendChild(el("li", { class: ev.visible_to_parent ? "" : "internal" }, [
        el("div", { class: "tl-when", text: fmt(ev.created_at) + " · " + (ev.actor_name || t("s.c.system")) }),
        el("div", { class: "tl-what" }, [
          el("strong", { text: t("s.ev." + ev.event_type) }), " ",
          ev.visible_to_parent ? pill(t("s.c.parentsees"), "see") : pill(t("s.c.internal"), "off"),
          eventDetail(ev) ? el("div", { class: "preline", text: eventDetail(ev) }) : null]),
      ]));
    });
    return card([el("h2", { text: t("s.c.timeline") }), tl]);
  }

  // ------------------------------------------------------------------ Log an accident
  function localInputValue(d) { var p = function (n) { return String(n).padStart(2, "0"); }; return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes()); }

  async function incidentForm() {
    loadingView();
    var kids = (await client.from("children").select("id, full_name, classes(name)").eq("active", true).order("full_name")).data || [];
    var child = el("select", {}, [opt("", "—")].concat(kids.map(function (k) { return opt(k.id, k.full_name + (k.classes ? " (" + k.classes.name + ")" : "")); })));
    var whenIn = el("input", { type: "datetime-local" }); whenIn.value = localInputValue(new Date());
    var where = el("input", { type: "text", maxlength: "120" });
    var what = textarea(4), injury = el("input", { type: "text", maxlength: "300" }), aid = el("input", { type: "text", maxlength: "300" });
    var wit = el("input", { type: "text", maxlength: "300" });
    var sevVal = "minor", sevBox = el("div", { class: "f-row" }, [el("label", { text: t("s.i.severity") })]);
    var seriousNote = el("div", { class: "hidden" }, [note("info", t("s.i.seriousnote"))]);
    var callBox = el("div", { class: "f-row" });
    var called = el("input", { type: "checkbox" }), calledAt = el("input", { type: "datetime-local" });
    function syncCall() { calledAt.classList.toggle("hidden", !called.checked); if (called.checked && !calledAt.value) calledAt.value = localInputValue(new Date()); }
    called.addEventListener("change", syncCall);
    ["minor", "needs_attention", "serious"].forEach(function (v) {
      var r = el("input", { type: "radio", name: "sev", value: v }); r.checked = v === "minor";
      r.addEventListener("change", function () { sevVal = v; seriousNote.classList.toggle("hidden", v !== "serious"); });
      sevBox.appendChild(el("label", { class: "choice small" }, [r, el("span", { text: t("s.i." + v) })]));
    });
    callBox.appendChild(el("label", { class: "choice small" }, [called, el("span", {}, [el("strong", { text: t("s.i.called") }), el("small", { text: t("s.i.callreq") })])]));
    callBox.appendChild(calledAt); syncCall();
    var err = el("div", { class: "note err hidden", role: "alert" }), ok = el("div", {});
    var save = el("button", { class: "btn btn-pink", type: "submit", text: t("s.i.save") });
    var form = el("form", { novalidate: "novalidate" }, [
      field(t("s.i.child"), child), field(t("s.i.when"), whenIn), field(t("s.i.where"), where), field(t("s.i.what"), what),
      field(t("s.i.injury"), injury), field(t("s.i.firstaid"), aid), sevBox, seriousNote, callBox, field(t("s.i.witnesses"), wit), err, save,
    ]);
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      function fail(key) { err.textContent = t(key); err.classList.remove("hidden"); err.scrollIntoView({ block: "center" }); }
      err.classList.add("hidden");
      if (!child.value) return fail("s.i.needchild");
      if (!where.value.trim()) return fail("s.i.needwhere");
      if (!what.value.trim()) return fail("s.i.needwhat");
      var occurred = new Date(whenIn.value), calledTime = called.checked && calledAt.value ? new Date(calledAt.value) : null;
      if (isNaN(occurred) || occurred.getTime() > Date.now() + 60000 || (calledTime && calledTime.getTime() > Date.now() + 60000)) return fail("s.i.future");
      if (sevVal !== "minor" && !calledTime) return fail("s.i.needcall");
      save.disabled = true;
      var r = await client.from("incidents").insert({
        child_id: child.value, occurred_at: occurred.toISOString(), location: where.value.trim(), what_happened: what.value.trim(),
        injury: injury.value.trim() || null, first_aid: aid.value.trim() || null, severity: sevVal,
        witnesses: wit.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean),
        parent_called_at: calledTime ? calledTime.toISOString() : null, reported_by: me.id,
      });
      if (r.error) { save.disabled = false; return fail("s.error"); }
      flash = t("s.i.saved"); location.hash = "#/accidents";
    });
    show([card([el("h1", { text: t("s.i.title") }), el("p", { class: "p-sub", text: t("s.i.intro") }), form, ok])]);
  }

  async function accidents() {
    loadingView();
    var q = await client.from("incidents").select("id, occurred_at, location, severity, what_happened, parent_called_at, parent_signed_at, children(full_name)").order("occurred_at", { ascending: false }).limit(100);
    if (q.error) return failView();
    var nodes = [];
    if (flash) { nodes.push(note("ok", flash)); flash = null; }
    nodes.push(card([el("h1", { text: t("s.a.title") }), link("#/incident", t("s.nav.incident"), "btn btn-pink btn-small")].concat((q.data || []).length ? [] : [el("p", { class: "p-sub", text: t("s.a.none") })])));
    (q.data || []).forEach(function (i) {
      nodes.push(card([
        el("div", { class: "case-top" }, [el("strong", { text: i.children ? i.children.full_name : "" }), pill(t("s.i." + i.severity), "sev-" + i.severity)]),
        el("small", { text: fmt(i.occurred_at) + " · " + i.location }),
        el("p", { class: "preline", text: i.what_happened }),
        i.parent_signed_at ? note("ok", t("s.a.read") + " · " + fmt(i.parent_signed_at)) : el("small", { class: "promise", text: t("s.a.unread") }),
      ]));
    });
    show(nodes);
  }

  // ------------------------------------------------------------------ Ratings (manager / owner)
  async function ratings() {
    loadingView();
    var rows = await rpc("staff_ratings");
    var nodes = [card([el("h1", { text: t("s.r.title") }), el("p", { class: "p-sub", text: t("s.r.privacy") })].concat(rows.length ? [] : [el("p", { text: t("s.r.none") })]))];
    rows.forEach(function (r) {
      nodes.push(card([
        el("div", { class: "case-top" }, [el("strong", { text: (r.class_name || "—") + " · " + r.child_name }), el("small", { text: r.month })]),
        el("div", { class: "kv" }, [el("span", { class: "k", text: t("s.r.care") + " / " + t("s.r.comm") + " / " + t("s.r.daily") }), el("span", { text: r.care_score + " / " + r.communication_score + " / " + r.daily_reports_score })]),
        r.comment ? el("p", { class: "preline", text: r.comment }) : null,
        r.compliment_staff_name ? note("ok", t("s.r.compliment") + " " + r.compliment_staff_name + (r.compliment_text ? ": " + r.compliment_text : "")) : null,
      ]));
    });
    show(nodes);
  }

  // ------------------------------------------------------------------ People (admin / manager / owner)
  async function api(path, body) {
    var s = await client.auth.getSession();
    var res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + s.data.session.access_token }, body: JSON.stringify(body) });
    var data = {}; try { data = await res.json(); } catch (e) {}
    if (!res.ok || !data.ok) throw new Error(data.error || t("s.error"));
    return data;
  }
  function checks(items) {
    var box = el("div", { class: "checks" });
    items.forEach(function (it) { box.appendChild(el("label", {}, [el("input", { type: "checkbox", value: it.id }), it.label])); });
    box.values = function () { return Array.prototype.map.call(box.querySelectorAll("input:checked"), function (i) { return i.value; }); };
    return box;
  }
  function langSelect() { return el("select", {}, [opt("ar", t("lang.ar")), opt("en", t("lang.en"))]); }

  async function people() {
    loadingView();
    var res = await Promise.all([
      client.from("children").select("id, full_name, classes(name)").eq("active", true).order("full_name"),
      client.from("classes").select("id, name").order("name"),
      client.from("profiles").select("id, full_name, role, phone, active").order("full_name"),
    ]);
    var kids = res[0].data || [], classes = res[1].data || [], list = res[2].data || [];
    var nodes = [];

    function inviteCard(title, build) {
      var msg = el("div", {}), form = el("form", { novalidate: "novalidate" });
      var parts = build(form);
      var btn = el("button", { class: "btn btn-pink", type: "submit", text: t("staff.sendinvite") });
      parts.fields.forEach(function (f) { form.appendChild(f); });
      form.appendChild(btn);
      form.addEventListener("submit", async function (e) {
        e.preventDefault(); msg.textContent = ""; btn.disabled = true;
        try { await parts.submit(); msg.appendChild(note("ok", t("staff.invited"))); form.reset(); form.querySelectorAll(".checks input").forEach(function (i) { i.checked = false; }); setTimeout(people, 900); }
        catch (err) { msg.appendChild(note("err", msgFromError(err))); }
        finally { btn.disabled = false; }
      });
      return card([el("h2", { text: title }), msg, form], "blue");
    }

    nodes.push(inviteCard(t("staff.inviteparent"), function () {
      var name = el("input", { type: "text" }), email = el("input", { type: "email", inputmode: "email" }), phone = el("input", { type: "tel" }), lg = langSelect();
      var ch = checks(kids.map(function (k) { return { id: k.id, label: k.full_name + (k.classes ? " (" + k.classes.name + ")" : "") }; }));
      if (!kids.length) ch.textContent = t("staff.nochildren");
      return {
        fields: [el("div", { class: "f-grid" }, [field(t("field.name"), name), field(t("field.email"), email), field(t("field.phone"), phone), field(t("field.language"), lg)]), field(t("field.children"), ch)],
        submit: async function () {
          var ids = ch.values(); if (!ids.length) throw new Error(t("staff.pickchild"));
          await api("/api/portal-invite-parent", { email: email.value, full_name: name.value, phone: phone.value, language: lg.value, child_ids: ids });
        },
      };
    }));

    if (isTop()) nodes.push(inviteCard(t("staff.invitestaff"), function () {
      var name = el("input", { type: "text" }), email = el("input", { type: "email", inputmode: "email" }), phone = el("input", { type: "tel" }), lg = langSelect();
      var role = el("select", {}, L.staffRolesCallerCanCreate(me.role).map(function (r) { return opt(r, t("role." + r)); }));
      var cl = checks(classes.map(function (c) { return { id: c.id, label: c.name }; }));
      return {
        fields: [el("div", { class: "f-grid" }, [field(t("field.name"), name), field(t("field.email"), email), field(t("field.phone"), phone), field(t("field.role"), role), field(t("field.language"), lg)]), field(t("field.classes"), cl)],
        submit: async function () { await api("/api/portal-invite-staff", { email: email.value, full_name: name.value, phone: phone.value, language: lg.value, role: role.value, class_ids: cl.values() }); },
      };
    }));

    var msg = el("div", {}), tbody = el("tbody", {});
    list.forEach(function (p) {
      var isMe = p.id === me.id, canToggle = !isMe && L.canChangeActive(me.role, p.role), btn = null;
      if (canToggle) {
        btn = el("button", { class: "btn btn-outline btn-small", type: "button", text: t(p.active ? "staff.switchoff" : "staff.switchon") });
        btn.addEventListener("click", async function () {
          if (!window.confirm(t(p.active ? "staff.confirmoff" : "staff.confirmon"))) return;
          btn.disabled = true; msg.textContent = "";
          try { await api("/api/portal-set-active", { user_id: p.id, active: !p.active }); people(); }
          catch (e) { msg.appendChild(note("err", msgFromError(e))); btn.disabled = false; }
        });
      }
      tbody.appendChild(el("tr", {}, [
        el("td", {}, [el("strong", { text: p.full_name }), isMe ? " " + t("staff.you") : ""]), el("td", {}, [pill(t("role." + p.role))]),
        el("td", { text: p.phone || "" }), el("td", {}, [p.active ? "" : pill(t("staff.off"), "off")]), el("td", {}, [btn]),
      ]));
    });
    nodes.push(card([el("h2", { text: t("staff.list") }), msg, el("div", { class: "tbl-wrap" }, [el("table", { class: "tbl" }, [tbody])])]));
    show(nodes);
  }

  // ------------------------------------------------------------------ Investigations (manager / owner)
  var STEPS = ["opened", "parent_called", "facts_gathered", "findings", "actions_taken", "parent_informed", "closed"];
  function duration(hours) {
    var h = Number(hours);
    return h < 48 ? Math.round(h * 10) / 10 + " " + t("s.v.hours") : Math.round(h / 24 * 10) / 10 + " " + t("s.v.days");
  }
  function responseNote(resp) {
    if (resp === "disagreed") return note("err", "⚠ " + t("s.v.disagrees"));
    if (resp === "acknowledged") return note("ok", t("s.v.acked"));
    return el("small", { class: "promise", text: t("s.v.noresponse") });
  }

  async function investigations() {
    loadingView();
    var rows = await rpc("staff_investigations");
    var nodes = [card([el("h1", { text: t("s.v.title") })].concat(rows.length ? [] : [el("p", { class: "p-sub", text: t("s.v.none") })]))];
    rows.forEach(function (r) {
      nodes.push(el("a", { class: "case-item " + (r.parent_response === "disagreed" ? "due-overdue" : r.status === "open" ? "due-soon" : "due-done"), href: "#/investigation/" + r.id }, [
        el("div", { class: "case-top" }, [pill(t("s.v.kind." + r.kind), r.kind === "accident" ? "sev-needs_attention" : "urg-critical"),
          pill(t(r.status === "open" ? "s.v.open" : "s.v.closed")), r.ref_no ? el("strong", { text: L.refLabel(r.ref_no) }) : null,
          r.severity ? pill(t("s.i." + r.severity), "sev-" + r.severity) : null]),
        el("div", { class: "case-title", text: r.headline }),
        el("small", { text: r.child_name + " · " + t("s.v.step") + " " + r.steps_done + "/7 · " + t("s.step." + r.current_step) }),
        el("small", { text: (r.assigned_name ? t("s.v.assigned") + ": " + r.assigned_name + " · " : "") + (r.status === "open" ? t("s.v.running") : t("s.v.took")) + " " + duration(r.hours_taken) }),
        r.parent_response ? el("small", { class: r.parent_response === "disagreed" ? "due-text" : "", text: r.parent_response === "disagreed" ? "⚠ " + t("s.v.disagrees") : t("s.v.acked") }) : null,
      ]));
    });
    show(nodes);
  }

  async function investigationPage(id) {
    loadingView();
    var res = await Promise.all([
      client.rpc("staff_investigation", { p_id: id }),
      client.from("investigation_steps").select("step, completed_at, profiles(full_name)").eq("investigation_id", id),
    ]);
    var v = res[0].data && res[0].data[0];
    if (res[0].error || !v) return failView();
    var done = {}; (res[1].data || []).forEach(function (s) { done[s.step] = s; });
    var closed = v.status === "closed";
    var nodes = [link("#/investigations", t("s.v.back"))];
    if (flash) { nodes.push(note("ok", flash)); flash = null; }
    var reload = function (m) { flash = m || null; investigationPage(id); };

    nodes.push(card([
      el("div", { class: "case-top" }, [pill(t("s.v.kind." + v.kind), v.kind === "accident" ? "sev-needs_attention" : "urg-critical"), pill(t(closed ? "s.v.closed" : "s.v.open")),
        v.ref_no ? el("strong", { text: L.refLabel(v.ref_no) }) : null, v.severity ? pill(t("s.i." + v.severity), "sev-" + v.severity) : null]),
      el("h1", { text: v.headline }),
      kv(t("s.v.child"), v.child_name),
      v.occurred_at ? kv(t("s.v.where"), fmt(v.occurred_at) + " · " + v.location) : null,
      v.submission_id ? el("div", { class: "kv" }, [link("#/case/" + v.submission_id, t("s.nav.queue") + " →")]) : null,
      kv(t("s.v.what"), v.description),
      kv(t("s.v.assigned"), v.assigned_name || "—"),
      kv(closed ? t("s.v.took") : t("s.v.running"), duration(v.hours_taken)),
      responseNote(v.parent_response),
    ].filter(Boolean), v.parent_response === "disagreed" ? "overdue" : ""));

    // Notes (findings for the parent + the internal ones)
    var f = textarea(5), internal = textarea(4), statements = textarea(4), actions = textarea(3);
    f.value = (done.findings ? v.findings_for_parent : v.findings_draft) || v.findings_for_parent || "";
    internal.value = v.internal_findings || ""; statements.value = v.staff_statements || ""; actions.value = v.actions_taken || "";
    [f, internal, statements, actions].forEach(function (x) { x.disabled = closed; });
    var msg = el("div", {}), save = el("button", { class: "btn btn-pink btn-small", type: "submit", text: t("s.v.save") });
    save.hidden = closed;

    // Warn when the text names another child (parents must never see that).
    async function confirmNames() {
      var r = await client.rpc("investigation_name_warnings", { p_id: id, p_text: f.value });
      var found = (r.data || []).map(function (x) { return typeof x === "string" ? x : x.investigation_name_warnings; });
      if (!found.length) return true;
      return window.confirm(t("s.v.warn") + "\n\n• " + found.join("\n• ") + "\n\n" + t("s.v.warn2"));
    }
    async function saveNotes() {
      await rpc("save_investigation", { p_id: id, p_findings: f.value.trim() || null, p_internal: internal.value.trim() || null, p_statements: statements.value.trim() || null, p_actions: actions.value.trim() || null });
    }
    var notesForm = el("form", { novalidate: "novalidate" }, [
      el("h3", { text: t("s.v.findings") }), el("p", { class: "p-sub", text: t("s.v.findings.hint") }), f,
      el("div", { class: "internal-box" }, [
        el("p", { class: "internal-hint", text: "🔒 " + t("s.v.private") }),
        field(t("s.v.internal"), internal), field(t("s.v.statements"), statements), field(t("s.v.actions"), actions)]),
      msg, save,
    ]);
    notesForm.addEventListener("submit", async function (e) {
      e.preventDefault(); msg.textContent = ""; save.disabled = true;
      try { if (!(await confirmNames())) { save.disabled = false; return; } await saveNotes(); reload(t("s.v.saved")); }
      catch (err) { msg.appendChild(note("err", msgFromError(err))); save.disabled = false; }
    });

    // Steps, in order
    var nextStep = STEPS.filter(function (s) { return !done[s]; })[0];
    var list = el("ol", { class: "steps" });
    var stepMsg = el("div", {});
    STEPS.forEach(function (s) {
      var d = done[s], isNext = s === nextStep && !closed, kids = [el("strong", { text: t("s.step." + s) })];
      if (d) kids.push(el("small", { text: t("s.v.done") + " · " + fmt(d.completed_at) + " · " + t("s.v.by") + " " + (d.profiles && d.profiles.full_name ? d.profiles.full_name : t("s.v.system")) }));
      else if (!isNext) kids.push(el("small", { text: t("s.v.locked") }));
      if (isNext) {
        var b = el("button", { class: "btn btn-pink btn-small", type: "button", text: t("s.v.markdone") });
        b.addEventListener("click", async function () {
          stepMsg.textContent = ""; b.disabled = true;
          try {
            if ((s === "findings" || s === "closed") && !f.value.trim()) throw new Error(t("s.v.needfindings"));
            if (s === "closed" && !actions.value.trim()) throw new Error(t("s.v.needactions"));
            if (s === "findings" || s === "closed") { if (!(await confirmNames())) { b.disabled = false; return; } }
            await saveNotes();
            var r = await client.from("investigation_steps").insert({ investigation_id: id, step: s });
            if (r.error) throw new Error(r.error.message);
            reload(t("s.v.saved"));
          } catch (err) { stepMsg.appendChild(note("err", msgFromError(err))); b.disabled = false; }
        });
        kids.push(b);
      }
      list.appendChild(el("li", { class: d ? "done" : isNext ? "next" : "locked" }, kids));
    });
    nodes.push(card([el("h2", { text: t("s.v.steps") }), el("p", { class: "p-sub", text: t("s.v.stepsnote") }), list, stepMsg]));

    // Responsibility: only once the findings are written, and only confirmed responsibility counts against a person.
    var fb = await Promise.all([client.rpc("investigation_fault", { p_investigation: id }), loadStaff()]);
    var current = fb[0].data && fb[0].data[0];
    var fkids = [el("h2", { text: t("flt.title") }), el("p", { class: "p-sub", text: t("flt.hint") })];
    if (!done.findings) fkids.push(note("info", t("flt.locked")));
    else {
      if (current) fkids.push(el("p", { class: "preline", text: t("flt.current") + ": " + current.staff_name + " (" + t(current.confirmed ? "flt.confirmed" : "flt.notconfirmed") + ")" }));
      else fkids.push(el("p", { class: "p-sub", text: t("flt.none") }));
      var who = el("select", {}, [opt("", t("s.c.assign.pick"))].concat((fb[1] || []).filter(function (p) { return p.role !== "owner"; }).map(function (p) { return opt(p.id, p.full_name); })));
      if (current) who.value = current.staff_id;
      var yes = el("input", { type: "checkbox" }); yes.checked = !!(current && current.confirmed);
      var fmsg = el("div", {}), fbtn = el("button", { type: "submit", class: "btn btn-pink btn-small", text: t("flt.save") });
      var fform = el("form", { novalidate: "novalidate" }, [field(t("flt.person"), who), el("label", { class: "choice small" }, [yes, el("span", { text: t("flt.confirm") })]), fmsg, fbtn]);
      fform.addEventListener("submit", async function (e) {
        e.preventDefault(); fmsg.textContent = ""; fbtn.disabled = true;
        try { if (!who.value) throw new Error(t("s.c.needperson")); await rpc("confirm_investigation_fault", { p_investigation: id, p_staff: who.value, p_confirmed: yes.checked }); reload(t("s.v.saved")); }
        catch (err) { fmsg.appendChild(note("err", msgFromError(err))); fbtn.disabled = false; }
      });
      fkids.push(fform);
    }
    nodes.push(card(fkids));
    nodes.push(card([el("h2", { text: t("s.v.notes") }), closed ? note("info", t("s.v.closedlock")) : null, notesForm], "blue"));
    show(nodes);
  }

  // ------------------------------------------------------------------ Reports (manager / owner)
  var reportState = { kind: "week", from: "", to: "" };

  function reportTable(sec) {
    var head = el("tr", {}, sec.header.map(function (h) { return el("th", { text: h }); }));
    var body = sec.rows.length
      ? sec.rows.map(function (row) { return el("tr", {}, row.map(function (c) { return el("td", { text: c === null || c === undefined || c === "" ? "" : String(c) }); })); })
      : [el("tr", {}, [el("td", { colspan: String(sec.header.length), class: "p-sub", text: t("s.rp.none") })])];
    return card([el("h2", { text: sec.title }), el("div", { class: "tbl-wrap" }, [el("table", { class: "tbl" }, [el("thead", {}, [head]), el("tbody", {}, body)])])]);
  }

  async function reportsPage() {
    var period = reportState.kind === "custom" ? { from: reportState.from, to: reportState.to } : L.periodFor(reportState.kind, Date.now());
    if (reportState.kind === "custom" && !reportState.from) {
      var m = L.periodFor("month", Date.now()); reportState.from = m.from; reportState.to = m.to; period = m;
    }
    loadingView();

    // Controls
    var bar = el("div", { class: "actions" });
    [["week", "s.rp.week"], ["month", "s.rp.month"], ["custom", "s.rp.custom"]].forEach(function (o) {
      var b = el("button", { type: "button", class: "filter-pill" + (reportState.kind === o[0] ? " active" : ""), text: t(o[1]) });
      b.addEventListener("click", function () { reportState.kind = o[0]; reportsPage(); });
      bar.appendChild(b);
    });
    var from = el("input", { type: "date" }), to = el("input", { type: "date" });
    from.value = period.from; to.value = period.to;
    var custom = el("div", { class: "f-grid" }, [field(t("s.rp.from"), from), field(t("s.rp.to"), to)]);
    var go = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("s.rp.show") });
    var msg = el("div", {});
    go.addEventListener("click", function () {
      if (!from.value || !to.value || to.value < from.value) { msg.textContent = ""; msg.appendChild(note("err", t("s.rp.badperiod"))); return; }
      reportState.from = from.value; reportState.to = to.value; reportsPage();
    });
    var controls = card([el("h1", { text: t("s.rp.title") }), el("p", { class: "p-sub", text: t("s.rp.privacy") }), bar,
      reportState.kind === "custom" ? custom : null, reportState.kind === "custom" ? go : null, msg,
      el("p", { class: "p-sub", text: t("s.rp.period") + ": " + period.from + " → " + period.to }),
      el("p", { class: "p-sub small", text: t("s.rp.note") })].filter(Boolean));

    var r;
    try { r = await rpc("staff_report", { p_from: period.from, p_to: period.to }); } catch (e) { show([controls, note("err", msgFromError(e))]); return; }
    var sections = L.reportSections(r, function (k) { return CKA.t(k); });

    var csv = el("button", { type: "button", class: "btn btn-pink btn-small", text: "⬇ " + t("s.rp.csv") });
    csv.addEventListener("click", function () {
      var blob = new Blob(["﻿" + L.toCsv(sections)], { type: "text/csv;charset=utf-8" });
      var a = el("a", { href: URL.createObjectURL(blob), download: "cka-report-" + period.from + "_" + period.to + ".csv" });
      document.body.appendChild(a); a.click(); a.remove();
    });
    controls.appendChild(csv);

    // Headline tiles
    var ack = r.on_time.acknowledged, res = r.on_time.resolved;
    function tile(num, label, cls) { return el("div", { class: "tile " + (cls || "") }, [el("strong", { text: String(num) }), el("span", { text: label })]); }
    function pctText(x) { var p = L.pct(x.on_time, x.due); return p === null ? "—" : p + "%"; }
    var tiles = card([el("div", { class: "tiles" }, [
      tile(r.totals.received, t("rp.received")), tile(pctText(ack), t("rp.ack_on_time"), ack.due && ack.on_time / ack.due < 0.8 ? "bad" : "good"),
      tile(pctText(res), t("rp.res_on_time"), res.due && res.on_time / res.due < 0.8 ? "bad" : "good"),
      tile(r.totals.overdue_now, t("rp.overdue_now"), r.totals.overdue_now ? "bad" : "good"),
      tile(r.avg_resolve_hours == null ? "—" : r.avg_resolve_hours, t("rp.avg_resolve")), tile(r.incidents.open_investigations, t("rp.open_inv"))])], "blue");

    show([controls, tiles].concat(sections.map(reportTable)));
  }

  // ------------------------------------------------------------------ Router
  var routes = {
    reports: function () { return isTop() ? reportsPage() : queue(); },
    investigations: function () { return isTop() ? investigations() : queue(); },
    investigation: function (p) { return isTop() ? investigationPage(p[1]) : queue(); },
    "": queue, "case": function (p) { return casePage(p[1]); }, incident: incidentForm, accidents: accidents,
    ratings: function () { return isTop() ? ratings() : queue(); }, people: function () { return isMgmt() ? people() : queue(); },
  };
  // Shared with js/owner.js (the owner dashboard, attendance sheet and staff-concern form).
  window.CKAStaff = {
    routes: routes, me: function () { return me; }, isTop: isTop, isMgmt: isMgmt, isOwner: function () { return me.role === "owner"; },
    show: show, card: card, note: note, pill: pill, link: link, field: field, opt: opt, kv: kv, textarea: textarea,
    rpc: rpc, fmt: fmt, when: when, loadingView: loadingView, failView: failView, msgFromError: msgFromError, loadStaff: loadStaff,
    setFlash: function (m) { flash = m; }, takeFlash: function () { var m = flash; flash = null; return m; },
  };

  function go() {
    var parts = location.hash.replace(/^#\/?/, "").split("/"), name = parts[0] === "" ? "" : parts[0];
    var tab = name === "case" ? "queue" : name === "investigation" ? "investigations" : (name || "queue");
    document.querySelectorAll("#nav a").forEach(function (a) { a.classList.toggle("active", a.getAttribute("data-route") === tab); });
    window.scrollTo(0, 0);
    Promise.resolve((routes[name] || queue)(parts)).catch(function () { failView(); });
  }

  function labelNav() {
    document.querySelectorAll("#nav a").forEach(function (a) { a.textContent = t(a.getAttribute("data-key")); });
  }

  document.addEventListener("DOMContentLoaded", async function () {
    var res = await CKA.requireArea("staff");
    me = res.profile;
    if (me.language && !localStorage.getItem("cka_portal_lang")) CKA.setLang(me.language);
    document.querySelector('#nav [data-route="ratings"]').hidden = !isTop();
    document.querySelector('#nav [data-route="reports"]').hidden = !isTop();
    document.querySelector('#nav [data-route="investigations"]').hidden = !isTop();
    document.querySelector('#nav [data-route="people"]').hidden = !isMgmt();
    document.querySelector('#nav [data-route="owner"]').hidden = me.role !== "owner";
    document.querySelector('#nav [data-route="attendance"]').hidden = !isMgmt();
    document.getElementById("who").textContent = me.full_name + " · " + t("role." + me.role);
    document.getElementById("app").hidden = false;
    labelNav();
    window.addEventListener("hashchange", go);
    document.addEventListener("cka-lang", function () {
      labelNav(); document.getElementById("who").textContent = me.full_name + " · " + t("role." + me.role); go();
    });
    go();
  });
})();
