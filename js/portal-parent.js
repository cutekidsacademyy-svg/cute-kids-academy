// /portal: everything a parent sees. Home, raise a concern, confirmation, case page with
// timeline, accident reports, monthly rating. All data goes through Supabase, which applies the
// privacy rules, so this script can only ever receive the signed-in parent's own information.
// Text from the database is always inserted as text (never as HTML).
(function () {
  "use strict";
  var el = CKA.el, t = CKA.t, L = window.CKALogic, client = CKA.client;
  var TZ = "Africa/Cairo";
  var profile = null, children = [], phone = "", staffNames = null;
  var view = document.getElementById("view");
  var lastPhotoFailed = false;
  var draft = blankDraft();
  var route = "";

  function blankDraft() { return { child: "", title: "", desc: "", safety: false, urgency: "urgent", about: false, staff: "" }; }
  function lang() { return CKA.getLang(); }
  function locale() { return lang() === "ar" ? "ar-EG" : "en-GB"; }
  function fmt(iso) { return new Intl.DateTimeFormat(locale(), { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)); }
  function when(iso) { return L.whenText(iso, Date.now(), lang()); }

  function show(nodes) { view.textContent = ""; nodes.forEach(function (n) { if (n) view.appendChild(n); }); }
  function card(kids, cls) { return el("div", { class: "p-card " + (cls || "") }, kids); }
  function note(kind, text) { return el("div", { class: "note " + kind, role: "status", "aria-live": "polite", text: text }); }
  function pill(text, cls) { return el("span", { class: "pill " + (cls || ""), text: text }); }
  function urgPill(u) { return pill(t("p.urg." + u), "urg-" + u); }
  function statusPill(s) { return pill(t("p.status." + s), "st-" + s); }
  function link(href, text, cls) { return el("a", { class: cls || "p-link", href: href, text: text }); }
  function field(labelText, control, forId) { return el("div", { class: "f-row" }, [el("label", { for: forId, text: labelText }), control]); }
  function loadingView() { show([el("p", { class: "p-sub", text: t("p.loading") })]); }
  function failView() { show([card([note("err", t("p.error")), link("#/", t("p.btn.home"))])]); }

  function callBox() {
    return el("div", { class: "call-box" }, [
      el("p", { text: t("p.safety.box") }),
      el("a", { class: "btn btn-pink", href: "tel:" + phone.replace(/\s+/g, ""), text: "📞 " + t("p.safety.call") + (phone ? " " + phone : "") }),
    ]);
  }

  async function loadStaffNames() {
    if (staffNames) return staffNames;
    var r = await client.rpc("list_staff_names");
    staffNames = r.data || [];
    return staffNames;
  }
  function staffSelect(id, selected, onChange) {
    var sel = el("select", { id: id }, [el("option", { value: "", text: t("p.new.pickstaff") })]);
    staffNames.forEach(function (s) { sel.appendChild(el("option", { value: s.id, text: s.full_name })); });
    sel.value = selected || "";
    sel.addEventListener("change", function () { onChange(sel.value); });
    return sel;
  }

  // ------------------------------------------------------------------ Home
  async function home() {
    loadingView();
    var res = await Promise.all([client.rpc("parent_cases"), client.rpc("parent_incidents")]);
    if (res[0].error) return failView();
    var cases = res[0].data || [], unread = (res[1].data || []).filter(function (i) { return !i.parent_signed_at; }).length;
    var open = cases.filter(function (c) { return c.status !== "closed"; });
    var closed = cases.filter(function (c) { return c.status === "closed"; });

    var reportsBtn = el("a", { class: "btn btn-outline", href: "#/reports" }, [t("p.btn.reports"), unread ? el("span", { class: "badge", text: String(unread) }) : null]);
    var hello = card([
      el("h1", { text: CKA.greeting(profile.full_name) }),
      el("div", { class: "actions" }, [
        link("#/new", t("p.btn.concern"), "btn btn-pink"),
        link("#/rate", t("p.btn.rate"), "btn btn-outline"),
        reportsBtn,
      ]),
    ]);

    var kids = card([el("h2", { text: CKA.t("portal.children") })].concat(children.length
      ? children.map(function (c) {
          return el("div", { class: "kid" }, [el("div", { class: "dot", text: "🧒" }), el("div", {}, [
            el("strong", { text: c.full_name }), c.classes ? el("small", { text: t("portal.class") + ": " + c.classes.name }) : null])]);
        })
      : [el("p", { class: "p-sub", text: t("portal.nochildren") })]), "blue");

    var casesCard = card([el("h2", { text: t("p.home.cases") })].concat(
      open.length ? open.map(caseItem) : [el("p", { class: "p-sub", text: t("p.home.nocases") })]));
    var nodes = [hello, kids, casesCard];
    if (closed.length) nodes.push(card([el("h2", { text: t("p.home.past") })].concat(closed.map(caseItem))));
    show(nodes);
  }

  function caseItem(c) {
    var promise = "";
    if (c.status === "received" && c.acknowledge_by) promise = t("p.respondby") + " " + when(c.acknowledge_by);
    else if ((c.status === "acknowledged" || c.status === "in_progress") && c.resolve_by) promise = t("p.resolveby") + " " + when(c.resolve_by);
    return el("a", { class: "case-item", href: "#/case/" + c.id }, [
      el("div", { class: "case-top" }, [el("strong", { text: L.refLabel(c.ref_no) }), statusPill(c.status), urgPill(c.urgency)]),
      el("div", { class: "case-title", text: c.title }),
      el("small", { text: c.handler_name ? t("p.handledby") + ": " + c.handler_name : t("p.unassigned") }),
      promise ? el("small", { class: "promise", text: promise }) : null,
    ]);
  }

  // ------------------------------------------------------------------ Raise a concern
  function newConcern() {
    if (!draft.child && children.length === 1) draft.child = children[0].id;
    var err = el("div", { class: "note err hidden", role: "alert" });

    var childSel = el("select", { id: "fChild" }, [el("option", { value: "", text: "—" })].concat(
      children.map(function (c) { return el("option", { value: c.id, text: c.full_name }); })));
    childSel.value = draft.child;
    childSel.addEventListener("change", function () { draft.child = childSel.value; });

    var title = el("input", { id: "fTitle", type: "text", maxlength: "120", placeholder: t("p.new.subject.ph") });
    title.value = draft.title; title.addEventListener("input", function () { draft.title = title.value; });
    var desc = el("textarea", { id: "fDesc", rows: "6", maxlength: "4000" });
    desc.value = draft.desc; desc.addEventListener("input", function () { draft.desc = desc.value; });

    var urgencyBox = el("div", { class: "f-row", id: "urgencyBox" });
    var safetyNotice = el("div", { id: "safetyNotice", class: "hidden" }, [callBox(), note("info", t("p.safety.critical"))]);
    var safety = el("input", { type: "checkbox", id: "fSafety" }); safety.checked = draft.safety;
    function syncSafety() {
      safetyNotice.classList.toggle("hidden", !draft.safety);
      urgencyBox.classList.toggle("hidden", draft.safety);
    }
    safety.addEventListener("change", function () { draft.safety = safety.checked; syncSafety(); });

    urgencyBox.appendChild(el("label", { text: t("p.new.urgency") }));
    [["urgent", "p.new.urgent", "p.new.urgent.ex"], ["can_wait", "p.new.canwait", "p.new.canwait.ex"]].forEach(function (o) {
      var r = el("input", { type: "radio", name: "urgency", value: o[0] }); r.checked = draft.urgency === o[0];
      r.addEventListener("change", function () { draft.urgency = o[0]; });
      urgencyBox.appendChild(el("label", { class: "choice" }, [r, el("span", {}, [el("strong", { text: t(o[1]) }), el("small", { text: t(o[2]) })])]));
    });

    var staffRow = el("div", { class: "f-row hidden", id: "staffRow" });
    var about = el("input", { type: "checkbox", id: "fAbout" }); about.checked = draft.about;
    async function syncAbout() {
      staffRow.classList.toggle("hidden", !draft.about);
      if (draft.about) {
        await loadStaffNames();
        staffRow.textContent = "";
        staffRow.appendChild(staffSelect("fStaff", draft.staff, function (v) { draft.staff = v; }));
      }
    }
    about.addEventListener("change", function () { draft.about = about.checked; syncAbout(); });

    var photo = el("input", { type: "file", id: "fPhoto", accept: "image/*" });
    var submit = el("button", { class: "btn btn-pink", type: "submit", text: t("p.new.send") });

    var form = el("form", { novalidate: "novalidate" }, [
      field(t("p.new.child"), childSel, "fChild"),
      field(t("p.new.subject"), title, "fTitle"),
      field(t("p.new.desc"), desc, "fDesc"),
      el("div", { class: "f-row" }, [el("label", { class: "choice" }, [safety, el("span", {}, [el("strong", { text: t("p.new.safety") }), el("small", { text: t("p.new.safety.hint") })])])]),
      safetyNotice, urgencyBox,
      el("div", { class: "f-row" }, [el("label", { class: "choice" }, [about, el("span", {}, [el("strong", { text: t("p.new.aboutstaff") }), el("small", { text: t("p.new.aboutstaff.hint") })])])]),
      staffRow,
      field(t("p.new.photo") + " — " + t("p.new.photo.hint"), photo, "fPhoto"),
      err, submit,
    ]);
    form.addEventListener("submit", function (e) { e.preventDefault(); sendConcern(photo, err, submit); });

    show([link("#/", t("p.back")), card([el("h1", { text: t("p.new.title") }), el("p", { class: "p-sub", text: t("p.new.intro") }), form])]);
    syncSafety(); syncAbout();
  }

  // Resize to at most 1600px and re-encode as JPEG: small upload, and it drops hidden
  // location data from the photo.
  function prepareImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var s = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * s)); c.height = Math.max(1, Math.round(img.height * s));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b && b.size <= 5242880 ? resolve(b) : reject(new Error("size")); }, "image/jpeg", 0.82);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("read")); };
      img.src = url;
    });
  }

  async function sendConcern(photoInput, err, submit) {
    function fail(key) { err.textContent = t(key); err.classList.remove("hidden"); err.scrollIntoView({ block: "center" }); }
    err.classList.add("hidden");
    if (!draft.child) return fail("p.new.needchild");
    if (!draft.title.trim()) return fail("p.new.needtitle");
    if (!draft.desc.trim()) return fail("p.new.needdesc");
    if (draft.about && !draft.staff) return fail("p.new.needstaff");

    submit.disabled = true; var label = submit.textContent; submit.textContent = t("p.sending");
    try {
      var blob = null;
      if (photoInput.files && photoInput.files[0]) {
        try { blob = await prepareImage(photoInput.files[0]); } catch (e) { fail("p.new.photobad"); return; }
      }
      var id = crypto.randomUUID();
      var ins = await client.from("submissions").insert({
        id: id, parent_id: profile.id, child_id: draft.child,
        type: draft.safety ? "safety_concern" : "complaint",
        title: draft.title.trim(), description: draft.desc.trim(),
        urgency: draft.safety ? "urgent" : draft.urgency,         // the database makes safety concerns critical
        about_staff_member: draft.about ? draft.staff : null,
      });
      if (ins.error) { fail("p.error"); return; }

      lastPhotoFailed = false;
      if (blob) {
        var path = id + "/" + crypto.randomUUID() + ".jpg";
        var up = await client.storage.from("attachments").upload(path, blob, { contentType: "image/jpeg" });
        var meta = up.error ? { error: up.error } : await client.from("attachments").insert({
          submission_id: id, uploaded_by: profile.id, storage_path: path, file_name: "photo.jpg", mime_type: "image/jpeg", size_bytes: blob.size });
        if (meta.error) lastPhotoFailed = true;
      }
      draft = blankDraft();
      location.hash = "#/done/" + id;
    } catch (e) { fail("p.error"); }
    finally { submit.disabled = false; submit.textContent = label; }
  }

  // ------------------------------------------------------------------ Confirmation
  async function done(id) {
    loadingView();
    var r = await client.rpc("parent_cases");
    var c = (r.data || []).filter(function (x) { return x.id === id; })[0];
    if (!c) return failView();
    var critical = c.urgency === "critical";
    show([card([
      el("h1", { text: "✅ " + t("p.done.title") }),
      lastPhotoFailed ? note("err", t("p.new.photofail")) : null,
      el("p", { class: "ref-big", text: t("p.done.keep") + " " + L.refLabel(c.ref_no) }),
      el("p", {}, [el("strong", { text: t("p.done.urgency") + ": " }), urgPill(c.urgency)]),
      el("p", { class: "promise-big", text: (critical ? t("p.done.critical") : t("p.done.deadline")) + " " + when(c.acknowledge_by) }),
      critical ? callBox() : null,
      el("div", { class: "actions" }, [link("#/case/" + c.id, t("p.btn.view"), "btn btn-pink"), link("#/", t("p.btn.home"), "btn btn-outline")]),
    ])]);
    lastPhotoFailed = false;
  }

  // ------------------------------------------------------------------ Case page
  function eventDetail(ev) {
    switch (ev.event_type) {
      case "parent_reply": case "update": return ev.message || "";
      case "urgency_changed": return t("p.urg." + ev.old_value) + " → " + t("p.urg." + ev.new_value) + (ev.message ? " — " + t("p.case.reason") + ": " + ev.message : "");
      case "assigned": return (ev.message || "").replace(/^Assigned to /, "");
      case "status_changed": return t("p.status." + ev.new_value);
      case "investigation_step": return t("p.step." + ev.new_value);
      default: return "";
    }
  }

  async function casePage(id) {
    loadingView();
    var res = await Promise.all([
      client.rpc("parent_cases"),
      client.from("submissions").select("description, children(full_name)").eq("id", id).maybeSingle(),
      client.from("submission_events").select("id, event_type, message, old_value, new_value, actor_name, created_at").eq("submission_id", id).order("created_at"),
      client.from("attachments").select("id, storage_path, file_name").eq("submission_id", id),
      client.from("investigations").select("id, status, findings_for_parent, parent_response").eq("submission_id", id).maybeSingle(),
    ]);
    var c = (res[0].data || []).filter(function (x) { return x.id === id; })[0];
    if (!c || !res[1].data) return failView();
    var body = res[1].data, events = res[2].data || [], files = res[3].data || [], inv = res[4].data;
    var nodes = [link("#/", t("p.back"))];

    var head = [
      el("div", { class: "case-top" }, [el("strong", { text: L.refLabel(c.ref_no) }), statusPill(c.status), urgPill(c.urgency)]),
      el("h1", { text: c.title }),
      body.children ? el("p", { class: "p-sub", text: body.children.full_name }) : null,
      el("p", { text: c.handler_name ? t("p.handledby") + ": " + c.handler_name : t("p.unassigned") }),
    ];
    if (c.status === "received" && c.acknowledge_by) head.push(el("p", { class: "promise", text: t("p.respondby") + " " + when(c.acknowledge_by) }));
    else if ((c.status === "acknowledged" || c.status === "in_progress") && c.resolve_by) head.push(el("p", { class: "promise", text: t("p.resolveby") + " " + when(c.resolve_by) }));
    var changes = events.filter(function (e) { return e.event_type === "urgency_changed"; });
    if (changes.length) {
      var last = changes[changes.length - 1];
      head.push(note("info", t("p.case.urgencychanged") + " " + t("p.urg." + last.new_value) + (last.message ? " — " + t("p.case.reason") + ": " + last.message : "")));
    }
    nodes.push(card(head));

    var mine = [el("h2", { text: t("p.case.desc") }), el("p", { class: "preline", text: body.description })];
    if (files.length) {
      var gallery = el("div", { class: "photos" });
      mine.push(el("h3", { text: t("p.case.photos") }), gallery);
      files.forEach(async function (f) {                     // short-lived links: they expire after 5 minutes
        var s = await client.storage.from("attachments").createSignedUrl(f.storage_path, 300);
        if (s.data) gallery.appendChild(el("a", { href: s.data.signedUrl, target: "_blank", rel: "noopener" }, [el("img", { src: s.data.signedUrl, alt: f.file_name })]));
      });
    }
    nodes.push(card(mine, "blue"));

    if (inv) {
      var st = await client.from("investigation_steps").select("investigation_id, step, completed_at").eq("investigation_id", inv.id);
      nodes.push(investigationCard(inv, function () { casePage(id); }, st.data || []));
    }

    if (c.status === "resolved") {
      var ask = el("div", { class: "actions" });
      var yes = el("button", { class: "btn btn-pink", type: "button", text: t("p.case.yes") });
      var no = el("button", { class: "btn btn-outline", type: "button", text: t("p.case.no") });
      [[yes, true], [no, false]].forEach(function (p) {
        p[0].addEventListener("click", async function () {
          yes.disabled = no.disabled = true;
          var r = await client.rpc("respond_to_resolution", { p_submission: id, p_satisfied: p[1] });
          if (r.error) { yes.disabled = no.disabled = false; ask.appendChild(note("err", t("p.error"))); return; }
          casePage(id);
        });
        ask.appendChild(p[0]);
      });
      nodes.push(card([el("h2", { text: t("p.case.satisfied") }), ask], "ask"));
    } else if (c.status === "closed" && c.parent_satisfied === true) {
      nodes.push(card([note("ok", t("p.case.thanks"))]));
    }

    var tl = el("ol", { class: "timeline" });
    events.forEach(function (ev) {
      if (ev.event_type === "internal_note") return;
      var label = t("p.ev." + ev.event_type);
      var detail = eventDetail(ev);
      tl.appendChild(el("li", {}, [
        el("div", { class: "tl-when", text: fmt(ev.created_at) }),
        el("div", { class: "tl-what" }, [el("strong", { text: label }), detail ? el("div", { class: "preline", text: detail }) : null]),
      ]));
    });
    nodes.push(card([el("h2", { text: t("p.case.timeline") }), tl]));

    if (c.status !== "closed") {
      var msgBox = el("textarea", { rows: "4", maxlength: "4000", placeholder: t("p.case.reply.ph"), "aria-label": t("p.case.reply") });
      var out = el("div", {});
      var send = el("button", { class: "btn btn-pink", type: "submit", text: t("p.case.send") });
      var form = el("form", {}, [el("h2", { text: t("p.case.reply") }), msgBox, out, send]);
      form.addEventListener("submit", async function (e) {
        e.preventDefault();
        if (!msgBox.value.trim()) return;
        send.disabled = true;
        var r = await client.from("submission_events").insert({ submission_id: id, event_type: "parent_reply", message: msgBox.value.trim(), visible_to_parent: true });
        if (r.error) { send.disabled = false; out.textContent = ""; out.appendChild(note("err", t("p.error"))); return; }
        casePage(id);
      });
      nodes.push(card([form]));
    } else nodes.push(note("info", t("p.case.closednote")));
    show(nodes);
  }

  // What the academy found, written for the parent (never other children's names or internal notes).
  function investigationCard(inv, reload, steps) {
    var kids = [el("h2", { text: t("p.case.investigation") })];
    if (steps && steps.length) {
      var ol = el("ol", { class: "timeline" });
      steps.slice().sort(function (x, y) { return new Date(x.completed_at) - new Date(y.completed_at); }).forEach(function (st) {
        ol.appendChild(el("li", {}, [el("div", { class: "tl-when", text: fmt(st.completed_at) }), el("div", { class: "tl-what" }, [el("strong", { text: t("p.step." + st.step) })])]));
      });
      kids.push(ol);
    }
    if (!inv.findings_for_parent) { kids.push(el("p", { class: "p-sub", text: t("p.case.nofindings") })); return card(kids, "blue"); }
    kids.push(el("h3", { text: t("p.case.findings") }), el("p", { class: "preline", text: inv.findings_for_parent }));
    if (inv.parent_response === "acknowledged") kids.push(note("ok", t("p.case.acked")));
    else if (inv.parent_response === "disagreed") kids.push(note("info", t("p.case.disagreed")));
    else {
      var row = el("div", { class: "actions" });
      [["acknowledged", "p.case.ack", "btn btn-pink"], ["disagreed", "p.case.disagree", "btn btn-outline"]].forEach(function (o) {
        var b = el("button", { class: o[2], type: "button", text: t(o[1]) });
        b.addEventListener("click", async function () {
          row.querySelectorAll("button").forEach(function (x) { x.disabled = true; });
          var r = await client.rpc("respond_to_investigation", { p_investigation: inv.id, p_response: o[0] });
          if (r.error) { row.appendChild(note("err", t("p.error"))); return; }
          reload();
        });
        row.appendChild(b);
      });
      kids.push(row);
    }
    return card(kids, "blue");
  }

  // ------------------------------------------------------------------ Accident reports
  async function reports() {
    loadingView();
    var res = await Promise.all([
      client.rpc("parent_incidents"),
      client.from("investigations").select("id, incident_id, status, findings_for_parent, parent_response").not("incident_id", "is", null),
      client.from("investigation_steps").select("investigation_id, step, completed_at"),
    ]);
    var stepsBy = {};
    (res[2] && res[2].data || []).forEach(function (x) { (stepsBy[x.investigation_id] = stepsBy[x.investigation_id] || []).push(x); });
    if (res[0].error) return failView();
    var list = res[0].data || [], invs = {};
    (res[1].data || []).forEach(function (i) { invs[i.incident_id] = i; });
    var nodes = [link("#/", t("p.back")), card([el("h1", { text: t("p.reports.title") })].concat(list.length ? [] : [el("p", { class: "p-sub", text: t("p.reports.none") })]))];
    list.forEach(function (i) {
      var rows = [
        [t("p.reports.when"), fmt(i.occurred_at)], [t("p.reports.where"), i.location], [t("p.reports.what"), i.what_happened],
        [t("p.reports.injury"), i.injury || "—"], [t("p.reports.firstaid"), i.first_aid || "—"],
        [t("p.reports.called"), i.parent_called_at ? fmt(i.parent_called_at) : t("p.reports.notcalled")],
        [t("p.reports.by"), i.reported_by_name || "—"],
      ];
      var kids = [el("div", { class: "case-top" }, [el("strong", { text: i.child_name }), pill(t("p.sev." + i.severity), "sev-" + i.severity)])];
      rows.forEach(function (r) { kids.push(el("div", { class: "kv" }, [el("span", { class: "k", text: r[0] }), el("span", { class: "preline", text: r[1] })])); });
      if (i.parent_signed_at) kids.push(note("ok", t("p.reports.readat") + " " + fmt(i.parent_signed_at)));
      else {
        var b = el("button", { class: "btn btn-pink", type: "button", text: t("p.reports.read") });
        b.addEventListener("click", async function () {
          b.disabled = true;
          var r = await client.rpc("mark_incident_read", { p_incident: i.id });
          if (r.error) { b.disabled = false; return; }
          reports();
        });
        kids.push(b);
      }
      if (invs[i.id]) kids.push(investigationCard(invs[i.id], reports, stepsBy[invs[i.id].id]));
      nodes.push(card(kids));
    });
    show(nodes);
  }

  // ------------------------------------------------------------------ Monthly rating
  function stars(label) {
    var value = 0, wrap = el("div", { class: "stars", role: "radiogroup", "aria-label": label }), btns = [];
    for (var n = 1; n <= 5; n++) (function (n) {
      var b = el("button", { type: "button", class: "star", role: "radio", "aria-checked": "false", "aria-label": n + " " + t("p.rate.stars"), text: "★" });
      b.addEventListener("click", function () {
        value = n;
        btns.forEach(function (x, i) { x.classList.toggle("on", i < n); x.setAttribute("aria-checked", i === n - 1 ? "true" : "false"); });
      });
      btns.push(b); wrap.appendChild(b);
    })(n);
    return { node: el("div", { class: "f-row" }, [el("label", { text: label }), wrap]), get: function () { return value; } };
  }

  async function rate() {
    loadingView();
    var month = L.monthKey(Date.now());
    var res = await Promise.all([client.from("ratings").select("child_id").eq("month", month), loadStaffNames()]);
    var rated = {}; (res[0].data || []).forEach(function (r) { rated[r.child_id] = true; });
    var nodes = [link("#/", t("p.back")), card([el("h1", { text: t("p.rate.title") }), el("p", { class: "p-sub", text: t("p.rate.intro") })])];

    children.forEach(function (c) {
      if (rated[c.id]) { nodes.push(card([note("ok", t("p.rate.done") + " " + c.full_name)])); return; }
      var care = stars(t("p.rate.care")), comm = stars(t("p.rate.comm")), daily = stars(t("p.rate.daily"));
      var comment = el("textarea", { rows: "3", maxlength: "2000" });
      var who = "", thanks = el("textarea", { rows: "2", maxlength: "1000", placeholder: t("p.rate.complimenttext") });
      var sel = staffSelect("c" + c.id, "", function (v) { who = v; });
      var err = el("div", { class: "note err hidden", role: "alert" });
      var send = el("button", { class: "btn btn-pink", type: "submit", text: t("p.rate.send") });
      var form = el("form", { novalidate: "novalidate" }, [
        el("h2", { text: c.full_name }), care.node, comm.node, daily.node,
        field(t("p.rate.comment"), comment), field(t("p.rate.compliment"), sel), thanks, err, send,
      ]);
      form.addEventListener("submit", async function (e) {
        e.preventDefault(); err.classList.add("hidden");
        if (!care.get() || !comm.get() || !daily.get()) { err.textContent = t("p.rate.needall"); err.classList.remove("hidden"); return; }
        send.disabled = true;
        var r = await client.from("ratings").insert({
          parent_id: profile.id, child_id: c.id, care_score: care.get(), communication_score: comm.get(), daily_reports_score: daily.get(),
          comment: comment.value.trim() || null, compliment_staff_id: who || null, compliment_text: who && thanks.value.trim() ? thanks.value.trim() : null,
        });
        if (r.error) { send.disabled = false; err.textContent = t("p.error"); err.classList.remove("hidden"); return; }
        form.replaceWith(note("ok", t("p.rate.thanks")));
      });
      nodes.push(card([form]));
    });
    show(nodes);
  }

  // Shared with the other parent pages (js/portal-child.js: "My child").
  window.CKAParent = {
    routes: {}, show: show, card: card, note: note, pill: pill, link: link, field: field, loadingView: loadingView, failView: failView,
    profile: function () { return profile; }, phone: function () { return phone; }, children: function () { return children; }, prepareImage: prepareImage, fmt: fmt, setProfile: function (p) { profile = p; },
  };

  // ------------------------------------------------------------------ Router
  function go() {
    var parts = location.hash.replace(/^#\/?/, "").split("/");
    route = parts[0] || "home";
    document.querySelectorAll("#nav a").forEach(function (a) { a.classList.toggle("active", a.getAttribute("data-route") === route || (route === "home" && a.getAttribute("data-route") === "home")); });
    window.scrollTo(0, 0);
    var run = { home: home, new: newConcern, done: function () { return done(parts[1]); }, "case": function () { return casePage(parts[1]); }, reports: reports, rate: rate }[route]
      || (window.CKAParent.routes[route] ? function () { return window.CKAParent.routes[route](parts); } : home);
    Promise.resolve(run()).catch(failView);
  }

  document.addEventListener("DOMContentLoaded", async function () {
    var res = await CKA.requireArea("portal");
    profile = res.profile;
    if (profile.language && !localStorage.getItem("cka_portal_lang")) CKA.setLang(profile.language);
    var q = await client.from("children").select("id, full_name, classes(name)").order("full_name");
    children = q.data || [];
    try { var s = await (await fetch("/content/settings.json")).json(); phone = s.phone || ""; } catch (e) { phone = ""; }
    document.getElementById("app").hidden = false;
    document.querySelectorAll("#nav a").forEach(function (a) { a.textContent = t(a.getAttribute("data-key")); });
    window.addEventListener("hashchange", go);
    document.addEventListener("cka-lang", function () {
      document.querySelectorAll("#nav a").forEach(function (a) { a.textContent = t(a.getAttribute("data-key")); });
      go();
    });
    go();
  });
})();
