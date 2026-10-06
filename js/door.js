// The door screen (#/door) and the attendance reports (#/attreport). Plugs into the staff page through window.CKAStaff.
// Staff check children in and out; at check-out they pick who is collecting from the child's authorised pickup list
// (with the ID photo). Anyone not on the list triggers a clear warning: keep the child and call the parent.
// The database decides who may do what (a teacher only for their own class); the screen only shows what it is given.
// Text from the database is only ever inserted as text.
(function () {
  "use strict";
  var S = window.CKAStaff, el = CKA.el, t = CKA.t, L = window.CKALogic, client = CKA.client;
  var panel = null;            // the child whose check-out panel is open (the page does not refresh while one is open)
  var flash = {};              // child id -> short message after an action
  var poll = null;
  var reportState = { kind: "week", from: "", to: "" };

  function lang() { return CKA.getLang(); }
  function hhmm(iso) { return new Intl.DateTimeFormat(lang() === "ar" ? "ar-EG" : "en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)); }
  function todayCairo() { return L.periodFor("week", Date.now()).to; }
  function telLink(p) { return el("a", { class: "p-link", href: "tel:" + String(p.phone || "").replace(/\s+/g, ""), dir: "ltr", text: "📞 " + p.full_name + (p.phone ? " " + p.phone : "") }); }

  // ------------------------------------------------------------------ Door screen
  async function door(opts) {
    if (!(opts && opts.quiet)) S.loadingView();
    var rows;
    try { rows = await S.rpc("door_list"); } catch (e) { return S.show([S.note("err", S.msgFromError(e))]); }
    startPoll();
    var present = 0, left = 0, absent = 0, waiting = 0;
    rows.forEach(function (r) {
      if (r.checked_out_at) left++; else if (r.checked_in_at) present++; else if (r.notice_kind === "absence") absent++; else waiting++;
    });
    function tile(n, label, cls) { return el("div", { class: "tile " + (cls || "") }, [el("strong", { text: String(n) }), el("span", { text: label })]); }
    var bar = el("div", { class: "actions" });
    var refresh = el("button", { type: "button", class: "btn btn-outline btn-small", text: "↻ " + t("dr.refresh") });
    refresh.addEventListener("click", function () { panel = null; flash = {}; door(); });
    bar.appendChild(refresh);

    var nodes = [S.card([el("h1", { text: t("dr.title") + " · " + t("dr.today") }), el("div", { class: "tiles" }, [
      tile(present, t("dr.t.present"), "good"), tile(waiting, t("dr.t.waiting"), waiting ? "bad" : ""), tile(left, t("dr.t.left")), tile(absent, t("dr.t.absent"))]), bar], "blue")];

    // admin: children flagged at 9:30
    var flagged = S.isMgmt() ? rows.filter(function (r) { return r.flagged; }) : [];
    if (flagged.length) nodes.push(flagCard(flagged));

    if (!rows.length) nodes.push(S.card([el("p", { class: "p-sub", text: t("dr.empty") })]));
    var byClass = {}, order = [];
    rows.forEach(function (r) { var k = r.class_name || "—"; if (!byClass[k]) { byClass[k] = []; order.push(k); } byClass[k].push(r); });
    order.forEach(function (k) {
      nodes.push(S.card([el("h2", { text: k })].concat(byClass[k].map(row))));
    });
    S.show(nodes);
  }

  function startPoll() {
    if (poll) return;
    poll = setInterval(function () {
      if (location.hash.replace(/^#\/?/, "") !== "door") { clearInterval(poll); poll = null; return; }
      if (!panel && !document.hidden) door({ quiet: true });
    }, 60000);
  }

  function statusText(r) {
    if (r.checked_out_at) return t("dr.status.out") + " " + hhmm(r.checked_out_at) + (r.collector_name ? " " + t("dr.by") + " " + r.collector_name : "");
    if (r.checked_in_at) return t("dr.status.in") + " " + hhmm(r.checked_in_at);
    return t("dr.status.waiting");
  }

  function row(r) {
    var kids = [el("strong", { text: r.child_name }), el("div", { class: "p-who", text: statusText(r) })];
    if (r.off_list) kids.push(S.pill("⚠ " + t("dr.off_list"), "urg-critical"));
    if (r.overtime_minutes > 0) kids.push(S.pill(t("dr.overtime") + ": " + r.overtime_minutes + " " + t("dr.min"), "urg-urgent"));
    if (r.notice_kind) {
      kids.push(el("div", { class: "internal-box" }, [el("strong", { text: t("dr.notice." + r.notice_kind) + (r.notice_arrival ? " · " + t("dr.expected") + " " + String(r.notice_arrival).slice(0, 5) : "") }),
        el("div", { class: "preline", text: r.notice_reason || "" }), r.notice_kind === "absence" && !r.checked_in_at ? el("small", { text: t("dr.came_anyway") }) : null].filter(Boolean)));
    }
    if (r.flagged && !r.called_at) kids.push(el("div", { class: "att-msg bad", text: "☎ " + t("dr.flagged") }));
    if (r.called_at) kids.push(el("small", { class: "att-msg ok", text: "✓ " + t("dr.called") + (r.call_note ? ": " + r.call_note : "") }));
    if (flash[r.child_id]) kids.push(el("div", { class: "att-msg ok", text: flash[r.child_id] }));

    var actions = el("div", { class: "actions" });
    if (!r.checked_in_at) actions.appendChild(button(t("dr.checkin"), "btn btn-pink btn-small", function () { return act(r, "door_check_in", { p_child: r.child_id }, t("dr.done_in")); }));
    else if (!r.checked_out_at) {
      actions.appendChild(button(t("dr.checkout"), "btn btn-pink btn-small", function () { panel = r.child_id; flash[r.child_id] = null; door({ quiet: true }); }));
      actions.appendChild(undoButton(r, "check_in"));
    } else actions.appendChild(undoButton(r, "check_out"));
    kids.push(actions);
    if (panel === r.child_id && r.checked_in_at && !r.checked_out_at) kids.push(checkoutPanel(r));
    return el("div", { class: "kid", style: "align-items:flex-start" }, [el("div", { class: "dot", text: r.checked_out_at ? "👋" : r.checked_in_at ? "🙂" : r.notice_kind === "absence" ? "🏠" : "⏳" }), el("div", { style: "flex:1;min-width:0" }, kids)]);
  }

  function button(text, cls, onClick) {
    var b = el("button", { type: "button", class: cls, text: text });
    b.addEventListener("click", async function () { b.disabled = true; try { await onClick(); } catch (e) { b.disabled = false; S.show([S.note("err", S.msgFromError(e)), el("button", { class: "btn btn-outline", type: "button", text: t("dr.refresh"), onclick: function () { door(); } })]); } });
    return b;
  }
  function undoButton(r, what) {
    var b = el("button", { type: "button", class: "p-link", text: t("dr.undo") });
    b.addEventListener("click", async function () {
      if (!window.confirm(t("dr.undo_confirm"))) return;
      b.disabled = true;
      try { await S.rpc("door_undo", { p_child: r.child_id, p_what: what }); flash[r.child_id] = t("dr.undone"); panel = null; door({ quiet: true }); }
      catch (e) { b.disabled = false; flash[r.child_id] = S.msgFromError(e); door({ quiet: true }); }
    });
    return b;
  }
  async function act(r, fn, args, msg) {
    await S.rpc(fn, args); flash[r.child_id] = msg; panel = null; await door({ quiet: true });
  }

  // ------------------------------------------------------------------ Check-out: who is collecting?
  function checkoutPanel(r) {
    var box = el("div", { class: "action", style: "margin-top:10px" }, [el("h3", { text: t("dr.out_title") }), el("p", { class: "p-sub", text: t("dr.out_hint") })]);
    var msg = el("div", {});
    var choice = { pickup: null, other: false };
    var list = el("div", {});
    var other = el("div", { class: "hidden" });
    var go = el("button", { type: "button", class: "btn btn-pink", text: t("dr.handover"), disabled: "disabled" });
    var cancel = el("button", { type: "button", class: "btn btn-outline", text: t("dr.cancel") });
    cancel.addEventListener("click", function () { panel = null; door({ quiet: true }); });
    box.appendChild(list); box.appendChild(other); box.appendChild(msg); box.appendChild(el("div", { class: "actions" }, [go, cancel]));

    var name = el("input", { type: "text", maxlength: "120" }), rel = el("input", { type: "text", maxlength: "60" }), note = el("input", { type: "text", maxlength: "300" });
    function refresh() {
      if (choice.other) go.disabled = !(name.value.trim().length >= 2 && rel.value.trim().length >= 2 && note.value.trim().length >= 3);
      else go.disabled = !choice.pickup;
    }
    [name, rel, note].forEach(function (i) { i.addEventListener("input", refresh); });

    Promise.all([S.rpc("door_pickups", { p_child: r.child_id }), S.rpc("door_parents", { p_child: r.child_id })]).then(function (res) {
      var people = res[0] || [], parents = res[1] || [];
      if (!people.length) list.appendChild(el("p", { class: "note info", text: t("dr.out_none") }));
      people.forEach(function (p) {
        var radio = el("input", { type: "radio", name: "who-" + r.child_id });
        radio.addEventListener("change", function () { choice = { pickup: p.id, other: false, name: p.full_name }; other.classList.add("hidden"); go.textContent = t("dr.handover_with") + " " + p.full_name; refresh(); });
        var photo = el("div", { class: "photos" });
        if (p.id_photo_path) {
          client.storage.from("child-files").createSignedUrl(p.id_photo_path, 300).then(function (s) {
            if (s.data) photo.appendChild(el("a", { href: s.data.signedUrl, target: "_blank", rel: "noopener" }, [el("img", { src: s.data.signedUrl, alt: t("dr.id_photo") + ": " + p.full_name })]));
          });
        }
        list.appendChild(el("label", { class: "choice" }, [radio, el("span", {}, [el("strong", { text: p.full_name }), el("small", { text: p.relationship + (p.phone ? " · " + p.phone : "") }),
          p.id_photo_path ? photo : el("small", { text: t("dr.no_photo") })])]));
      });
      var radioOther = el("input", { type: "radio", name: "who-" + r.child_id });
      radioOther.addEventListener("change", function () { choice = { pickup: null, other: true }; other.classList.remove("hidden"); go.textContent = t("dr.handover"); refresh(); });
      list.appendChild(el("label", { class: "choice" }, [radioOther, el("span", {}, [el("strong", { text: t("dr.someone_else") })])]));
      other.appendChild(el("div", { class: "call-box" }, [el("p", { text: "⛔ " + t("dr.warn") }), el("p", { class: "p-sub", text: t("dr.warn_hint") })].concat(parents.map(telLink))));
      other.appendChild(S.field(t("dr.p_name"), name)); other.appendChild(S.field(t("dr.p_rel"), rel)); other.appendChild(S.field(t("dr.p_note"), note));
    }).catch(function (e) { msg.appendChild(S.note("err", S.msgFromError(e))); });

    go.addEventListener("click", async function () {
      msg.textContent = ""; go.disabled = true; go.textContent = t("dr.working");
      var args = { p_child: r.child_id, p_pickup: choice.other ? null : choice.pickup, p_name: choice.other ? name.value : null, p_relationship: choice.other ? rel.value : null, p_note: choice.other ? note.value : null };
      try {
        var out = await S.rpc("door_check_out", args);
        flash[r.child_id] = t("dr.done_out") + (out && out.overtime_minutes > 0 ? " " + t("dr.overtime") + ": " + out.overtime_minutes + " " + t("dr.min") + "." : "");
        panel = null; door({ quiet: true });
      } catch (e) {
        go.disabled = false; go.textContent = t("dr.handover"); refresh();
        var m = String(e.message || "");
        msg.appendChild(S.note("err", /off_list_needs_details/.test(m) ? t("dr.err.details") : /off_list_needs_parent_approval/.test(m) ? t("dr.err.approval") : S.msgFromError(e)));
      }
    });
    return box;
  }

  // ------------------------------------------------------------------ Admin: not arrived by 9:30 and no notice
  function flagCard(flagged) {
    var holder = el("div", {});
    flagged.forEach(function (r) {
      var phones = el("div", {}), note = el("input", { type: "text", maxlength: "300", placeholder: t("dr.call_note") }), msg = el("div", {});
      var show = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("dr.show_phones") });
      show.addEventListener("click", async function () { show.disabled = true; try { (await S.rpc("door_parents", { p_child: r.child_id })).forEach(function (p) { phones.appendChild(telLink(p)); }); } catch (e) { msg.appendChild(S.note("err", S.msgFromError(e))); } });
      var save = el("button", { type: "button", class: "btn btn-pink btn-small", text: t("dr.i_called") });
      save.addEventListener("click", async function () {
        if (note.value.trim().length < 2) { msg.textContent = ""; msg.appendChild(S.note("err", t("dr.call_need"))); return; }
        save.disabled = true;
        try { await S.rpc("door_log_call", { p_child: r.child_id, p_note: note.value }); door({ quiet: true }); } catch (e) { save.disabled = false; msg.appendChild(S.note("err", S.msgFromError(e))); }
      });
      holder.appendChild(el("div", { class: "check-row" }, [el("strong", { text: r.child_name + (r.class_name ? " · " + r.class_name : "") }),
        r.called_at ? el("div", { class: "att-msg ok", text: "✓ " + t("dr.called") + (r.call_note ? ": " + r.call_note : "") }) : null, phones, msg,
        el("div", { class: "actions" }, [show]), el("div", { class: "note-row" }, [note]), el("div", { class: "actions" }, [save])].filter(Boolean)));
    });
    return S.card([el("h2", { text: "☎ " + t("dr.flag_title") }), el("p", { class: "p-sub", text: t("dr.flag_hint") }), holder]);
  }

  // ------------------------------------------------------------------ Attendance reports (management)
  function table(header, rows) {
    var head = el("tr", {}, header.map(function (h) { return el("th", { text: h }); }));
    var body = rows.length ? rows.map(function (r) { return el("tr", {}, r.map(function (c) { return el("td", { text: c === null || c === undefined ? "" : String(c) }); })); })
      : [el("tr", {}, [el("td", { colspan: String(header.length), class: "p-sub", text: t("ar.none") })])];
    return el("div", { class: "tbl-wrap" }, [el("table", { class: "tbl" }, [el("thead", {}, [head]), el("tbody", {}, body)])]);
  }

  async function attReport() {
    if (!S.isMgmt()) return S.routes[""]();
    var period = reportState.kind === "custom" ? { from: reportState.from, to: reportState.to } : L.periodFor(reportState.kind, Date.now());
    if (reportState.kind === "custom" && !reportState.from) { var m = L.periodFor("month", Date.now()); reportState.from = m.from; reportState.to = m.to; period = m; }
    S.loadingView();
    var bar = el("div", { class: "actions" });
    [["week", "ar.week"], ["month", "ar.month"], ["custom", "ar.custom"]].forEach(function (o) {
      var b = el("button", { type: "button", class: "filter-pill" + (reportState.kind === o[0] ? " active" : ""), text: t(o[1]) });
      b.addEventListener("click", function () { reportState.kind = o[0]; attReport(); });
      bar.appendChild(b);
    });
    var from = el("input", { type: "date" }), to = el("input", { type: "date" });
    from.value = period.from; to.value = period.to;
    var custom = el("div", { class: "f-grid" }, [S.field(t("ar.from"), from), S.field(t("ar.to"), to)]);
    var go = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("ar.show") });
    var msg = el("div", {});
    go.addEventListener("click", function () {
      if (!from.value || !to.value || to.value < from.value) { msg.textContent = ""; msg.appendChild(S.note("err", t("ar.badperiod"))); return; }
      reportState.from = from.value; reportState.to = to.value; attReport();
    });
    var controls = S.card([el("h1", { text: t("ar.title") }), el("p", { class: "p-sub", text: t("ar.privacy") }), bar,
      reportState.kind === "custom" ? custom : null, reportState.kind === "custom" ? go : null, msg,
      el("p", { class: "p-sub", text: period.from + " → " + period.to }), el("p", { class: "p-sub small", text: t("ar.note") })].filter(Boolean));

    var r;
    try { r = await S.rpc("attendance_report", { p_from: period.from, p_to: period.to }); } catch (e) { return S.show([controls, S.note("err", S.msgFromError(e))]); }
    var sections = [
      { id: "by_class", title: t("ar.by_class"), header: [t("ar.class"), t("ar.children"), t("ar.days"), t("ar.present"), t("ar.absent_rep"), t("ar.not_rep"), t("ar.late"), t("ar.ot_min")],
        rows: r.by_class.map(function (c) { return [c.class_name || "—", c.children, c.school_days, c.present_days, c.absent_reported, c.not_reported, c.late_notices, c.overtime_minutes]; }) },
      { id: "by_child", title: t("ar.by_child"), header: [t("ar.child"), t("ar.class"), t("ar.days"), t("ar.present"), t("ar.absent_rep"), t("ar.not_rep"), t("ar.late"), t("ar.ot_min")],
        rows: r.by_child.map(function (c) { return [c.child_name, c.class_name, c.school_days, c.present_days, c.absent_reported, c.not_reported, c.late_notices, c.overtime_minutes]; }) },
      { id: "overtime", title: t("ar.overtime"), header: [t("ar.child"), t("ar.class"), t("ar.parents"), t("ar.ot_days"), t("ar.ot_min")],
        rows: r.overtime.map(function (c) { return [c.child_name, c.class_name, c.parents, c.days, c.minutes]; }) },
    ];
    var csv = el("button", { type: "button", class: "btn btn-pink btn-small", text: "⬇ " + t("ar.csv") });
    csv.addEventListener("click", function () {
      var blob = new Blob(["﻿" + L.toCsv(sections)], { type: "text/csv;charset=utf-8" });
      var a = el("a", { href: URL.createObjectURL(blob), download: "cka-attendance-" + period.from + "_" + period.to + ".csv" });
      document.body.appendChild(a); a.click(); a.remove();
    });
    controls.appendChild(csv);
    S.show([controls].concat(sections.map(function (s) { return S.card([el("h2", { text: s.title }), table(s.header, s.rows)]); })));
  }

  S.routes.door = door;
  S.routes.attreport = attReport;
})();
