// The staff daily-reports screen (#/daily). Teachers tap entries for the children who are checked in (one child, or
// several at once), write one personal sentence, and send. Admin, manager and owner also see how the day is going,
// set the automatic-send time, and can change a report after it was sent (with a recorded reason).
// The database decides who may do what; this screen only shows what it is given. Text is only ever inserted as text.
(function () {
  "use strict";
  var S = window.CKAStaff, el = CKA.el, t = CKA.t, client = CKA.client;
  var LUNCH = ["more", "all", "half", "little", "none"], MOOD = ["happy", "calm", "tired", "upset"];
  var ITEMS = ["diapers", "wipes", "shower_gel", "cotton", "extra_clothes", "other"];
  var selected = {}, open = null, flash = null;

  function cairoMinutes() {
    var p = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()).split(":");
    return Number(p[0]) * 60 + Number(p[1]);
  }
  function sleepText(m) { return m == null ? "—" : Math.floor(m / 60) + t("dl.h") + " " + (m % 60) + t("dl.min"); }
  function errText(e) {
    var m = String((e && e.message) || "");
    if (/not_checked_in/.test(m)) return t("dl.err.checked_in");
    if (/already_sent/.test(m)) return t("dl.err.sent");
    if (/invalid_report_value/.test(m)) return t("dl.err.value");
    return S.msgFromError(e);
  }

  async function daily() {
    S.loadingView();
    var rows, ov = null;
    try {
      rows = await S.rpc("report_sheet");
      if (S.isMgmt()) ov = await S.rpc("report_overview");
    } catch (e) { return S.show([S.note("err", S.msgFromError(e))]); }
    var inCount = rows.length, drafts = rows.filter(function (r) { return r.status !== "sent" && r.has_content; }).length, sent = rows.filter(function (r) { return r.status === "sent"; }).length;
    var needNote = rows.filter(function (r) { return !(r.personal_note && r.personal_note.trim()); });
    function tile(n, label, cls) { return el("div", { class: "tile " + (cls || "") }, [el("strong", { text: String(n) }), el("span", { text: label })]); }

    var nodes = [];
    if (flash) { nodes.push(S.note(flash.kind, flash.text)); flash = null; }
    var head = S.card([el("h1", { text: t("dl.title") }), el("p", { class: "p-sub", text: t("dl.intro") }),
      el("div", { class: "tiles" }, [tile(inCount, t("dl.t.in")), tile(drafts, t("dl.t.draft"), drafts ? "bad" : ""), tile(sent, t("dl.t.sent"), "good"), tile(needNote.length, t("dl.t.note"))])], "blue");
    var refresh = el("button", { type: "button", class: "btn btn-outline btn-small", text: "↻ " + t("dl.refresh") });
    refresh.addEventListener("click", function () { daily(); });
    head.appendChild(el("div", { class: "actions" }, [refresh]));
    nodes.push(head);

    if (cairoMinutes() >= 16 * 60 && needNote.length) {
      nodes.push(S.card([el("h2", { text: "✍ " + t("dl.nudge") }), el("p", { text: needNote.map(function (r) { return r.child_name; }).join(" · ") })]));
    }
    if (ov) nodes.push(overviewCard(ov));

    if (!rows.length) { nodes.push(S.card([el("p", { class: "p-sub", text: t("dl.empty") })])); return S.show(nodes); }

    nodes.push(bulkCard(rows));
    var by = {}, order = [];
    rows.forEach(function (r) { var k = r.class_name || "—"; if (!by[k]) { by[k] = []; order.push(k); } by[k].push(r); });
    order.forEach(function (k) { nodes.push(S.card([el("h2", { text: k })].concat(by[k].map(childRow)))); });
    S.show(nodes);
  }

  // ------------------------------------------------------------------ Selecting several children
  function bulkCard(rows) {
    var ids = rows.filter(function (r) { return r.status !== "sent"; }).map(function (r) { return r.child_id; });
    var count = function () { return Object.keys(selected).filter(function (k) { return selected[k]; }); };
    var info = el("span", { class: "p-who", text: count().length + " " + t("dl.selected") });
    var all = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("dl.select_all") });
    all.addEventListener("click", function () { ids.forEach(function (i) { selected[i] = true; }); daily(); });
    var none = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("dl.select_none") });
    none.addEventListener("click", function () { selected = {}; daily(); });
    var msg = el("div", {});
    function apply(fields) {
      return async function () {
        var chosen = count();
        if (!chosen.length) { msg.textContent = ""; msg.appendChild(S.note("err", t("dl.bulk_none"))); return; }
        try { await S.rpc("report_save_many", { p_children: chosen, p_fields: fields }); flash = { kind: "ok", text: t("dl.saved") }; daily(); }
        catch (e) { msg.textContent = ""; msg.appendChild(S.note("err", errText(e))); }
      };
    }
    var lunch = el("div", { class: "actions" }, LUNCH.map(function (k) { var b = el("button", { type: "button", class: "btn btn-outline", text: t("dl.lunch." + k) }); b.addEventListener("click", apply({ lunch: k })); return b; }));
    var mood = el("div", { class: "actions" }, MOOD.map(function (k) { var b = el("button", { type: "button", class: "btn btn-outline", text: t("dl.mood." + k) }); b.addEventListener("click", apply({ mood: k })); return b; }));
    var sendAll = el("button", { type: "button", class: "btn btn-pink", text: t("dl.send_all") });
    sendAll.addEventListener("click", async function () {
      if (!window.confirm(t("dl.send_confirm"))) return;
      sendAll.disabled = true;
      try { var n = await S.rpc("report_send"); flash = n > 0 ? { kind: "ok", text: n + " " + t("dl.sent_n") } : { kind: "info", text: t("dl.nothing_to_send") }; daily(); }
      catch (e) { sendAll.disabled = false; msg.textContent = ""; msg.appendChild(S.note("err", errText(e))); }
    });
    return S.card([el("div", { class: "sec-head" }, [el("h2", { text: t("dl.bulk") }), info]), el("div", { class: "actions" }, [all, none]),
      el("h3", { text: t("dl.lunch") }), lunch, el("h3", { text: t("dl.mood") }), mood, msg, el("div", { class: "actions", style: "margin-top:16px" }, [sendAll])]);
  }

  // ------------------------------------------------------------------ One child
  function summary(r) {
    var bits = [];
    if (r.lunch) bits.push(t("dl.lunch") + ": " + t("dl.lunch." + r.lunch));
    if (r.mood) bits.push(t("dl.mood." + r.mood));
    if (r.water_cups != null) bits.push("💧 " + r.water_cups);
    if (r.milk_ml != null) bits.push("🥛 " + r.milk_ml);
    if (r.sleep_minutes != null) bits.push("😴 " + sleepText(r.sleep_minutes));
    if (r.diaper_changes != null) bits.push("🧷 " + r.diaper_changes);
    if (r.stool_count != null) bits.push("💩 " + r.stool_count);
    if (r.temperature != null) bits.push("🌡 " + r.temperature);
    return bits.join(" · ");
  }

  function childRow(r) {
    var editable = r.status !== "sent";
    var cb = el("input", { type: "checkbox", "aria-label": r.child_name });
    cb.checked = !!selected[r.child_id]; cb.disabled = !editable;
    cb.addEventListener("change", function () { selected[r.child_id] = cb.checked; });
    var stKey = r.status === "sent" ? "sent" : r.has_content ? "draft" : "none";
    var kids = [el("div", { class: "case-top" }, [el("strong", { text: r.child_name }), S.pill(t("dl.st." + stKey), stKey === "sent" ? "st-resolved" : stKey === "draft" ? "urg-urgent" : ""), r.checked_out ? S.pill(t("dl.checked_out")) : null,
      r.allergies ? S.pill("⚠ " + t("dl.allergy") + ": " + r.allergies, "urg-critical") : null].filter(Boolean))];
    var sm = summary(r); if (sm) kids.push(el("div", { class: "p-who", text: sm }));
    if (r.personal_note) kids.push(el("div", { class: "preline", text: "“" + r.personal_note + "”" }));
    var b = el("button", { type: "button", class: "btn btn-outline btn-small", text: open === r.child_id ? t("dl.close") : t("dl.open") });
    b.addEventListener("click", function () { open = open === r.child_id ? null : r.child_id; daily(); });
    kids.push(el("div", { class: "actions" }, [b]));
    if (open === r.child_id) kids.push(form(r));
    return el("div", { class: "kid", style: "align-items:flex-start" }, [editable ? cb : el("div", { class: "dot", text: "✓" }), el("div", { style: "flex:1;min-width:0" }, kids)]);
  }

  function choiceButtons(list, key, current, labelKey, onPick) {
    var box = el("div", { class: "actions" });
    list.forEach(function (k) {
      var b = el("button", { type: "button", class: "btn " + (current() === k ? "btn-pink" : "btn-outline"), text: t(labelKey + k) });
      b.addEventListener("click", function () { onPick(current() === k ? null : k); box.querySelectorAll("button").forEach(function (x, i) { x.className = "btn " + (list[i] === current() ? "btn-pink" : "btn-outline"); }); });
      box.appendChild(b);
    });
    return box;
  }
  function stepper(label, get, set, step, show) {
    var val = el("strong", { class: "ref-big", text: show(get()) });
    function refresh() { val.textContent = show(get()); }
    var minus = el("button", { type: "button", class: "btn btn-outline", text: "−", "aria-label": "− " + label });
    var plus = el("button", { type: "button", class: "btn btn-outline", text: "+", "aria-label": "+ " + label });
    minus.addEventListener("click", function () { set(Math.max(0, (get() == null ? 0 : get()) - step)); refresh(); });
    plus.addEventListener("click", function () { set((get() == null ? 0 : get()) + step); refresh(); });
    return el("div", { class: "check-row" }, [el("div", { class: "check-label", text: label }), el("div", { class: "actions", style: "align-items:center" }, [minus, val, plus])]);
  }

  function form(r) {
    var f = { lunch: r.lunch, mood: r.mood, water_cups: r.water_cups, milk_ml: r.milk_ml, sleep_minutes: r.sleep_minutes, diaper_changes: r.diaper_changes, stool_count: r.stool_count,
      temperature: r.temperature, personal_note: r.personal_note || "" };
    var items = (r.send_items || []).slice(), other = r.send_other || "";
    var sent = r.status === "sent";
    var box = el("div", { class: "action", style: "margin-top:10px" });
    var msg = el("div", {});

    if (sent && !S.isMgmt()) { box.appendChild(el("p", { class: "note info", text: t("dl.err.sent") })); return box; }
    if (r.allergies) box.appendChild(el("div", { class: "call-box" }, [el("p", { text: "⚠ " + t("dl.allergy_warn") + " " + r.allergies })]));

    box.appendChild(el("h3", { text: t("dl.lunch") }));
    box.appendChild(choiceButtons(LUNCH, "lunch", function () { return f.lunch; }, "dl.lunch.", function (v) { f.lunch = v; }));
    box.appendChild(el("h3", { text: t("dl.mood") }));
    box.appendChild(choiceButtons(MOOD, "mood", function () { return f.mood; }, "dl.mood.", function (v) { f.mood = v; }));
    var num = function (x) { return x == null ? "—" : String(x); };
    box.appendChild(stepper(t("dl.water"), function () { return f.water_cups; }, function (v) { f.water_cups = v; }, 1, num));
    box.appendChild(stepper(t("dl.milk"), function () { return f.milk_ml; }, function (v) { f.milk_ml = v; }, 50, num));
    box.appendChild(stepper(t("dl.sleep"), function () { return f.sleep_minutes; }, function (v) { f.sleep_minutes = v; }, 15, sleepText));
    box.appendChild(stepper(t("dl.diapers"), function () { return f.diaper_changes; }, function (v) { f.diaper_changes = v; }, 1, num));
    box.appendChild(stepper(t("dl.stool"), function () { return f.stool_count; }, function (v) { f.stool_count = v; }, 1, num));

    var temp = el("input", { type: "number", step: "0.1", min: "34", max: "43", inputmode: "decimal", dir: "ltr" });
    temp.value = f.temperature == null ? "" : f.temperature;
    var alertBox = el("div", { class: "hidden" }, [S.note("err", t("dl.temp_alert"))]);
    function tempCheck() { f.temperature = temp.value === "" ? null : Number(temp.value); alertBox.classList.toggle("hidden", !(f.temperature >= 38)); }
    temp.addEventListener("input", tempCheck); tempCheck();
    box.appendChild(S.field(t("dl.temp"), temp)); box.appendChild(alertBox);

    var note = S.textarea(3, t("dl.note_ph")); note.value = f.personal_note; note.maxLength = 1000;
    note.addEventListener("input", function () { f.personal_note = note.value; });
    box.appendChild(S.field(t("dl.note"), note));

    box.appendChild(el("h3", { text: t("dl.send_for") }));
    var chips = el("div", { class: "checks" });
    var otherInput = el("input", { type: "text", maxlength: "200", placeholder: t("dl.other_ph") }); otherInput.value = other;
    function syncOther() { otherInput.classList.toggle("hidden", items.indexOf("other") < 0); }
    ITEMS.forEach(function (k) {
      var c = el("input", { type: "checkbox" }); c.checked = items.indexOf(k) >= 0;
      c.addEventListener("change", function () { items = items.filter(function (x) { return x !== k; }); if (c.checked) items.push(k); syncOther(); });
      chips.appendChild(el("label", {}, [c, t("dl.i." + k)]));
    });
    otherInput.addEventListener("input", function () { other = otherInput.value; });
    box.appendChild(chips); box.appendChild(otherInput); syncOther();

    function fields() {
      return { lunch: f.lunch, mood: f.mood, water_cups: f.water_cups, milk_ml: f.milk_ml, sleep_minutes: f.sleep_minutes, diaper_changes: f.diaper_changes, stool_count: f.stool_count, temperature: f.temperature, personal_note: f.personal_note.trim() || null };
    }
    async function saveRequests() { await S.rpc("send_request_save", { p_child: r.child_id, p_items: items, p_other: items.indexOf("other") >= 0 ? other : null }); }

    var actions = el("div", { class: "actions" });
    if (sent) {
      var reason = el("input", { type: "text", maxlength: "300" });
      box.appendChild(el("h3", { text: t("dl.edit_sent") })); box.appendChild(S.field(t("dl.reason"), reason));
      var go = el("button", { type: "button", class: "btn btn-pink", text: t("dl.edit_save") });
      go.addEventListener("click", async function () {
        msg.textContent = "";
        if (reason.value.trim().length < 3) { msg.appendChild(S.note("err", t("dl.reason_need"))); return; }
        go.disabled = true;
        try { await S.rpc("report_edit_sent", { p_report: r.report_id, p_fields: fields(), p_reason: reason.value }); await saveRequests(); open = null; flash = { kind: "ok", text: t("dl.saved") }; daily(); }
        catch (e) { go.disabled = false; msg.appendChild(S.note("err", errText(e))); }
      });
      actions.appendChild(go);
    } else {
      var save = el("button", { type: "button", class: "btn btn-outline", text: t("dl.save") });
      var saveSend = el("button", { type: "button", class: "btn btn-pink", text: t("dl.save_send") });
      var run = function (andSend) {
        return async function () {
          msg.textContent = ""; save.disabled = saveSend.disabled = true;
          try {
            await S.rpc("report_save_many", { p_children: [r.child_id], p_fields: fields() });
            await saveRequests();
            if (andSend) await S.rpc("report_send", { p_children: [r.child_id] });
            open = null; flash = { kind: "ok", text: t("dl.saved") }; daily();
          } catch (e) { save.disabled = saveSend.disabled = false; msg.appendChild(S.note("err", errText(e))); }
        };
      };
      save.addEventListener("click", run(false)); saveSend.addEventListener("click", run(true));
      actions.appendChild(save); actions.appendChild(saveSend);
    }
    box.appendChild(msg); box.appendChild(actions);
    return box;
  }

  // ------------------------------------------------------------------ Admin, manager, owner: the day at a glance
  function overviewCard(o) {
    function tile(n, label, cls) { return el("div", { class: "tile " + (cls || "") }, [el("strong", { text: String(n) }), el("span", { text: label })]); }
    var kids = [el("h2", { text: t("dl.ov.title") }), el("div", { class: "tiles" }, [tile(o.present, t("dl.ov.present")), tile(o.sent, t("dl.ov.sent"), "good"), tile(o.ready, t("dl.ov.ready"), o.ready ? "bad" : ""), tile(o.not_started, t("dl.ov.notstarted"))])];
    kids.push(el("h3", { text: t("dl.ov.nonote") }));
    kids.push(el("p", { class: "p-sub", text: o.missing_note.length ? o.missing_note.map(function (c) { return c.child_name + (c.class_name ? " (" + c.class_name + ")" : ""); }).join(" · ") : t("dl.ov.none") }));
    kids.push(el("h3", { text: "🌡 " + t("dl.ov.fever") }));
    kids.push(el("p", { class: o.fever.length ? "att-msg bad" : "p-sub", text: o.fever.length ? o.fever.map(function (c) { return c.child_name + " " + c.temperature; }).join(" · ") : t("dl.ov.none") }));

    kids.push(el("h3", { text: t("dl.set.title") }));
    var auto = el("input", { type: "checkbox" }); auto.checked = !!o.settings.auto_send;
    var time = el("input", { type: "time", min: "12:00", max: "17:45" }); time.value = o.settings.auto_send_time;
    var msg = el("div", {});
    var save = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("dl.set.save") });
    save.addEventListener("click", async function () {
      msg.textContent = "";
      try { await S.rpc("report_settings_save", { p_auto: auto.checked, p_time: time.value }); msg.appendChild(S.note("ok", t("dl.set.saved"))); }
      catch (e) { msg.appendChild(S.note("err", t("dl.set.err"))); }
    });
    kids.push(el("label", { class: "choice" }, [auto, el("span", { text: t("dl.set.auto") })]), S.field(t("dl.set.time"), time), msg, save);
    return S.card(kids);
  }

  S.routes.daily = daily;
})();
