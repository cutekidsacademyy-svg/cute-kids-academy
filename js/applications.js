// Staff: registration applications (#/applications, #/application/<id>) and the teacher's "My class" page (#/class).
// Plugs into the staff page through window.CKAStaff (see js/staff.js). The database decides who may see or do
// what (admin, manager and owner only for applications; teachers see only allergies of their own class);
// hiding the menu items is only a convenience. Text from the database is only ever inserted as text.
(function () {
  "use strict";
  var S = window.CKAStaff, el = CKA.el, t = CKA.t, client = CKA.client;
  var filter = "open", approvalResults = {};
  var CONSENTS = ["photos_class", "photos_social", "outings", "emergency_treatment", "birthday_wall"];
  var CHANGEABLE = ["new", "missing_documents", "tour_booked", "waitlist", "declined"];

  function stPill(s) { return S.pill(t("ap.st." + s), "ap-" + s); }
  function yn(b) { return b ? t("ap.yes") : t("ap.no_"); }
  function tel(num) { return num ? el("a", { class: "p-link", href: "tel:" + String(num).replace(/\s+/g, ""), text: num, dir: "ltr" }) : null; }
  async function api(path, body) {
    var s = await client.auth.getSession();
    var res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + s.data.session.access_token }, body: JSON.stringify(body) });
    var data = {}; try { data = await res.json(); } catch (e) {}
    if (!res.ok || !data.ok) throw new Error(data.error || t("s.error"));
    return data;
  }
  // Private files open through a link that stops working after 5 minutes.
  function fileButton(path, label) {
    var b = el("button", { type: "button", class: "btn btn-outline btn-small", text: label });
    b.addEventListener("click", async function () {
      var w = window.open("about:blank", "_blank");
      var r = await client.storage.from("registrations").createSignedUrl(path, 300);
      if (r.data && w) w.location.href = r.data.signedUrl; else if (w) w.close();
    });
    return b;
  }

  // ------------------------------------------------------------------ List
  async function list() {
    S.loadingView();
    var rows = await S.rpc("registration_list", { p_status: null });
    var counts = { open: 0, all: rows.length };
    rows.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; if (r.status !== "approved" && r.status !== "declined") counts.open++; });
    var box = el("div", {});
    var bar = el("div", { class: "actions" });
    [["open", t("ap.f.open")], ["new", t("ap.st.new")], ["missing_documents", t("ap.st.missing_documents")], ["tour_booked", t("ap.st.tour_booked")], ["waitlist", t("ap.st.waitlist")],
      ["approved", t("ap.st.approved")], ["declined", t("ap.st.declined")], ["all", t("ap.f.all")]].forEach(function (o) {
      var b = el("button", { type: "button", class: "filter-pill" + (filter === o[0] ? " active" : ""), text: o[1] + " (" + (counts[o[0]] || 0) + ")" });
      b.addEventListener("click", function () { filter = o[0]; list(); });
      bar.appendChild(b);
    });
    var shown = rows.filter(function (r) { return filter === "all" || (filter === "open" ? r.status !== "approved" && r.status !== "declined" : r.status === filter); });
    if (!shown.length) box.appendChild(el("p", { class: "p-sub", text: t("ap.none") }));
    shown.forEach(function (r) {
      box.appendChild(el("a", { class: "case-item", href: "#/application/" + r.id }, [
        el("div", { class: "case-top" }, [el("strong", { text: "#" + r.application_no }), stPill(r.status), S.pill(t("ap.prog." + r.programme))]),
        el("div", { class: "case-title", text: r.child_name }),
        el("small", { text: t("ap.parent") + ": " + (r.parent_name || "—") + (r.parent_phone ? " · " + r.parent_phone : "") }),
        el("small", { text: t("ap.birth") + ": " + (r.has_birth_certificate ? "✓ " + t("ap.have") : "✗ " + t("ap.lack")) + " · " + t("ap.vacc") + ": " + (r.has_vaccination_record ? "✓ " + t("ap.have") : "✗ " + t("ap.lack")) }),
        el("small", { text: t("ap.submitted") + ": " + S.fmt(r.created_at) }),
      ]));
    });
    var flash = S.takeFlash();
    S.show([S.card([el("h1", { text: t("ap.title") }), el("p", { class: "p-sub", text: t("ap.intro") }), flash ? S.note("ok", flash) : null, bar, box].filter(Boolean))]);
  }

  // ------------------------------------------------------------------ One application
  async function detail(id) {
    S.loadingView();
    var a = await S.rpc("registration_get", { p_id: id });
    if (!a) return S.failView();
    var flash = S.takeFlash(), nodes = [S.link("#/applications", t("ap.back"))];
    if (flash) nodes.push(S.note("ok", flash));
    var open = a.status !== "approved" && a.status !== "declined";

    nodes.push(S.card([
      el("div", { class: "case-top" }, [el("strong", { text: t("ap.no") + " #" + a.application_no }), stPill(a.status)]),
      el("h1", { text: a.child_name }),
      S.kv(t("ap.dob"), a.child_dob), S.kv(t("ap.programme"), t("ap.prog." + a.programme)),
      a.preferred_start ? S.kv(t("ap.start"), a.preferred_start) : null,
      S.kv(t("ap.submitted"), S.fmt(a.created_at)), S.kv(t("ap.lang"), t("lang." + a.language)),
      a.class_name ? S.kv(t("ap.class"), a.class_name) : null,
      a.status_note ? S.kv(t("ap.note"), a.status_note) : null,
    ].filter(Boolean)));

    var photoBox = el("div", { class: "photos" });
    var photoDoc = a.child_photo_path;
    if (photoDoc) {
      nodes[nodes.length - 1].appendChild(photoBox);
      client.storage.from("registrations").createSignedUrl(photoDoc, 300).then(function (r) {
        if (r.data) photoBox.appendChild(el("a", { href: r.data.signedUrl, target: "_blank", rel: "noopener" }, [el("img", { src: r.data.signedUrl, alt: a.child_name })]));
      });
    }

    nodes.push(S.card([el("h2", { text: t("ap.parents") })].concat((a.parents || []).map(function (p) {
      return el("div", { class: "kv" }, [el("span", { class: "k", text: t("ap.rel." + p.relationship) }), el("strong", { text: p.full_name }), tel(p.phone),
        el("a", { class: "p-link", href: "mailto:" + p.email, text: p.email, dir: "ltr" })]);
    }))));

    nodes.push(S.card([el("h2", { text: t("ap.health") }),
      S.kv(t("ap.allergies"), a.allergies || "—"), S.kv(t("ap.conditions"), a.medical_conditions || "—"), S.kv(t("ap.medications"), a.medications || "—"),
      S.kv(t("ap.doctor"), [a.doctor_name, a.doctor_phone].filter(Boolean).join(" · ") || "—")], "blue"));

    var pk = a.pickups || [];
    nodes.push(S.card([el("h2", { text: t("ap.pickups") })].concat(pk.length ? pk.map(function (p) {
      return el("div", { class: "kv" }, [el("strong", { text: p.full_name + " · " + p.relationship }), tel(p.phone), p.id_photo_path ? fileButton(p.id_photo_path, t("ap.id_photo")) : null].filter(Boolean));
    }) : [el("p", { class: "p-sub", text: t("ap.no_pickups") })])));

    nodes.push(S.card([el("h2", { text: t("ap.consents") })].concat(CONSENTS.map(function (c) { return S.kv(t("ap.c." + c), yn(a["consent_" + c])); }))));

    var docs = a.documents || [];
    nodes.push(S.card([el("h2", { text: t("ap.documents") })].concat(docs.length ? docs.map(function (d) {
      return el("div", { class: "kv" }, [el("strong", { text: t(d.kind === "birth_certificate" ? "ap.birth" : d.kind === "vaccination_record" ? "ap.vacc" : "ap.documents") + (d.file_name ? " · " + d.file_name : "") }), fileButton(d.storage_path, t("ap.open_file"))]);
    }) : [el("p", { class: "p-sub", text: t("ap.no_docs") })])));

    // Approval results from this session (who was invited, who was linked, who failed)
    var res = approvalResults[a.id];
    if (res) nodes.push(resultsCard(a, res));
    else if (a.status === "approved" && a.child_id) nodes.push(S.card([el("h2", { text: t("ap.results") }), retryButton(a)], "blue"));

    if (open) nodes.push(statusCard(a), approveCard(a));

    nodes.push(S.card([el("h2", { text: t("ap.history") }), el("ul", { class: "timeline" }, (a.events || []).map(function (e) {
      return el("li", {}, [el("div", { class: "tl-when", text: S.fmt(e.created_at) + (e.actor_name ? " · " + e.actor_name : "") }), el("div", { class: "tl-what", text: t("ap.ev." + e.kind) + (e.note ? ": " + e.note : "") })]);
    }))]));
    S.show(nodes);
  }

  function statusCard(a) {
    var sel = el("select", {}, CHANGEABLE.map(function (s) { return S.opt(s, t("ap.st." + s)); }));
    sel.value = CHANGEABLE.indexOf(a.status) >= 0 ? a.status : "new";
    var noteBox = S.textarea(3, "");
    var msg = el("div", {});
    var btn = el("button", { type: "button", class: "btn btn-pink", text: t("ap.save_status") });
    btn.addEventListener("click", async function () {
      msg.textContent = "";
      if ((sel.value === "missing_documents" || sel.value === "declined") && !noteBox.value.trim()) { msg.appendChild(S.note("err", t("ap.need_note"))); return; }
      btn.disabled = true;
      try { await S.rpc("registration_set_status", { p_id: a.id, p_status: sel.value, p_note: noteBox.value.trim() || null }); S.setFlash(sel.value === "new" ? t("ap.saved_quiet") : t("ap.saved")); detail(a.id); }
      catch (e) { btn.disabled = false; msg.appendChild(S.note("err", S.msgFromError(e))); }
    });
    return S.card([el("h2", { text: t("ap.change") }), S.field(t("ap.new_status"), sel), S.field(t("ap.note"), noteBox), el("p", { class: "p-sub", text: t("ap.note_hint") }), msg, btn]);
  }

  function approveCard(a) {
    var holder = S.card([el("h2", { text: t("ap.approve") }), el("p", { class: "p-sub", text: t("ap.approve_hint") })], "blue");
    client.from("classes").select("id, name").order("name").then(function (r) {
      var classes = r.data || [];
      if (!classes.length) { holder.appendChild(S.note("info", t("ap.class_empty"))); return; }
      var sel = el("select", {}, [S.opt("", t("ap.choose_class"))].concat(classes.map(function (c) { return S.opt(c.id, c.name); })));
      var msg = el("div", {});
      var btn = el("button", { type: "button", class: "btn btn-pink", text: t("ap.approve_btn") });
      btn.addEventListener("click", async function () {
        msg.textContent = "";
        if (!sel.value) { msg.appendChild(S.note("err", t("ap.need_class"))); return; }
        if (!window.confirm(t("ap.confirm"))) return;
        btn.disabled = true; btn.textContent = t("ap.working");
        try { var out = await api("/api/portal-approve", { application_id: a.id, class_id: sel.value }); approvalResults[a.id] = out.results; S.setFlash(t("ap.approved_done")); detail(a.id); }
        catch (e) { btn.disabled = false; btn.textContent = t("ap.approve_btn"); msg.appendChild(S.note("err", S.msgFromError(e))); }
      });
      holder.appendChild(S.field(t("ap.class"), sel)); holder.appendChild(msg); holder.appendChild(btn);
    });
    return holder;
  }

  function retryButton(a) {
    var msg = el("div", {}), btn = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("ap.retry") });
    btn.addEventListener("click", async function () {
      btn.disabled = true; msg.textContent = "";
      try { var out = await api("/api/portal-approve", { application_id: a.id, retry: true }); approvalResults[a.id] = out.results; detail(a.id); }
      catch (e) { btn.disabled = false; msg.appendChild(S.note("err", S.msgFromError(e))); }
    });
    return el("div", {}, [el("p", { class: "p-sub", text: t("ap.retry_hint") }), msg, btn]);
  }
  function resultsCard(a, results) {
    var failed = results.some(function (r) { return r.outcome === "failed"; });
    return S.card([el("h2", { text: t("ap.results") })].concat(results.map(function (r) {
      return el("div", { class: "kv" }, [el("strong", { text: r.name }), el("span", { dir: "ltr", text: r.email }),
        el("span", { class: r.outcome === "failed" ? "att-msg bad" : "att-msg ok", text: (r.outcome === "failed" ? "✗ " : "✓ ") + t("ap.out." + r.outcome) + (r.error ? ": " + r.error : "") })]);
    })).concat(failed ? [retryButton(a)] : []), "blue");
  }

  // ------------------------------------------------------------------ Teacher: My class (allergies)
  async function myClass() {
    S.loadingView();
    var rows = await S.rpc("class_allergies");
    var byClass = {}, order = [];
    rows.forEach(function (r) { if (!byClass[r.class_name]) { byClass[r.class_name] = []; order.push(r.class_name); } byClass[r.class_name].push(r); });
    var nodes = [S.card([el("h1", { text: t("mc.title") }), el("p", { class: "p-sub", text: t("mc.intro") }), !rows.length ? el("p", { class: "p-sub", text: t("mc.empty") }) : null].filter(Boolean))];
    order.forEach(function (name) {
      nodes.push(S.card([el("h2", { text: name + " · " + byClass[name].length + " " + t("mc.count") })].concat(byClass[name].map(function (r) {
        return el("div", { class: "kid" }, [el("div", { class: "dot", text: r.allergies ? "⚠" : "✓" }),
          el("div", {}, [el("strong", { text: r.child_name }), el("small", { class: r.allergies ? "att-msg bad" : "", text: r.allergies || t("mc.none") })])]);
      })), "blue"));
    });
    S.show(nodes);
  }

  S.routes.applications = function () { return S.isMgmt() ? list() : S.routes[""](); };
  S.routes.application = function (p) { return S.isMgmt() ? detail(p[1]) : S.routes[""](); };
  S.routes["class"] = myClass;
})();
