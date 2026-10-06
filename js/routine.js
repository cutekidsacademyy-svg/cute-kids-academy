// The owner's Checklist & tasks screen (#/routine): morning walk and afternoon check, last 7 days,
// late tasks for the Thursday review, and the task tracker. Plugs into the staff page through
// window.CKAStaff. Everything is owner-only in the database; hiding the tab is only a convenience.
(function () {
  "use strict";
  var S = window.CKAStaff, el = CKA.el, t = CKA.t, L = window.CKALogic, client = CKA.client;
  var viewDate = null;

  function lang() { return CKA.getLang(); }
  function dayLabel(iso) {
    return new Intl.DateTimeFormat(lang() === "ar" ? "ar-EG" : "en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(iso + "T00:00:00Z"));
  }
  function bar(done, total) {
    var pct = total ? Math.round(done / total * 100) : 0;
    return el("div", { class: "progress", role: "img", "aria-label": done + " / " + total + " " + t("rt.progress") }, [el("span", { style: "width:" + pct + "%" }), el("small", { text: done + " / " + total + " " + t("rt.progress") })]);
  }

  async function routine() {
    if (!S.isOwner()) return S.routes[""]();
    S.loadingView();
    var r;
    try { r = await S.rpc("owner_routine", { p_date: viewDate }); } catch (e) { S.show([S.note("err", S.msgFromError(e))]); return; }
    var today = r.today, date = r.date, isToday = date === today;
    var nodes = [], flash = S.takeFlash();
    if (flash) nodes.push(S.note("ok", flash));

    // header with the day picker
    var picker = el("select", { "aria-label": t("rt.day") }, r.history.map(function (h) { return S.opt(h.date, (h.date === today ? t("rt.today") + " · " : "") + dayLabel(h.date)); }));
    picker.value = date;
    picker.addEventListener("change", function () { viewDate = picker.value === today ? null : picker.value; routine(); });
    nodes.push(S.card([el("h1", { text: "🔒 " + t("rt.title") }), el("p", { class: "p-sub", text: t("rt.privacy") }), S.field(t("rt.day"), picker)]));

    // Thursday review banner (late tasks to go through)
    if (r.is_thursday && isToday) nodes.push(S.card([el("h2", { text: "📋 " + t("rt.thu_title") }), el("p", { class: "p-sub", text: t("rt.thu_hint") + " (" + r.late_tasks + ")" })], "overdue"));

    // the two checklists
    ["morning", "afternoon"].forEach(function (key) {
      var list = r.lists[key], kids = [el("h2", { text: t("rt." + key) }), bar(list.done, list.total)];
      if (list.attention) kids.push(S.note("err", "⚠ " + list.attention + " " + t("rt.attention_n")));
      list.items.forEach(function (it) {
        var state = it.ok === null || it.ok === undefined ? "todo" : it.ok ? "ok" : "bad";
        var note = el("input", { type: "text", maxlength: "300", placeholder: t("rt.note_ph"), "aria-label": t("rt.note_ph") }); note.value = it.note || "";
        var noteRow = el("div", { class: "note-row" + (state === "bad" ? "" : " hidden") }, [note]);
        var msg = el("span", { class: "att-msg" });
        var okBtn = el("button", { type: "button", class: "check-btn" + (state === "ok" ? " on-ok" : ""), text: "✓ " + t("rt.ok"), "aria-pressed": String(state === "ok") });
        var badBtn = el("button", { type: "button", class: "check-btn" + (state === "bad" ? " on-bad" : ""), text: "⚠ " + t("rt.attention"), "aria-pressed": String(state === "bad") });
        var save = el("button", { type: "button", class: "btn btn-outline btn-small hidden", text: t("rt.save") });
        function send(ok) {
          msg.textContent = "";
          if (!ok && !note.value.trim()) { msg.textContent = t("rt.needs_note"); msg.className = "att-msg bad"; return; }
          S.rpc("owner_set_check", { p_item: it.id, p_date: date, p_ok: ok, p_note: ok ? null : note.value.trim() })
            .then(function () { S.setFlash(t("rt.saved")); routine(); })
            .catch(function () { msg.textContent = t("rt.err"); msg.className = "att-msg bad"; });
        }
        okBtn.addEventListener("click", function () { send(true); });
        badBtn.addEventListener("click", function () { noteRow.classList.remove("hidden"); save.classList.remove("hidden"); note.focus(); });
        save.addEventListener("click", function () { send(false); });
        if (state === "bad") save.classList.remove("hidden");
        kids.push(el("div", { class: "check-row " + state }, [el("div", { class: "check-label", text: it.label }), el("div", { class: "actions" }, [okBtn, badBtn]), noteRow, el("div", {}, [save, msg])]));
      });
      if (!list.items.length) kids.push(el("p", { class: "p-sub", text: t("rt.none") }));
      nodes.push(S.card(kids, key === "morning" ? "" : "blue"));
    });

    // last 7 days
    nodes.push(S.card([el("h2", { text: t("rt.history") }), el("div", { class: "tbl-wrap" }, [el("table", { class: "tbl" }, [
      el("thead", {}, [el("tr", {}, [t("rt.date"), t("rt.morning"), t("rt.afternoon")].map(function (h) { return el("th", { text: h }); }))]),
      el("tbody", {}, r.history.map(function (h) {
        function cell(done, total) { return !h.working_day && !done ? el("td", { class: "p-sub", text: t("rt.nonworking") }) : el("td", { text: total && done >= total ? "✓ " + t("rt.complete") : done + " / " + total }); }
        return el("tr", {}, [el("td", { text: dayLabel(h.date) }), cell(h.morning, h.morning_total), cell(h.afternoon, h.afternoon_total)]);
      }))])])]));

    // late tasks (for the Thursday review) and the tracker
    var late = r.tasks.filter(function (x) { return x.late; });
    nodes.push(S.card([el("h2", { text: "⚠ " + t("rt.late_tasks") + " (" + late.length + ")" })].concat(late.length
      ? late.map(function (x) { return el("div", { class: "case-item due-overdue" }, [el("strong", { text: x.what }), el("small", { text: (x.who || t("rt.unassigned")) + " · " + t("rt.due") + " " + x.due_date + " · " + daysLate(x.due_date, today) + " " + t("rt.days_late") })]); })
      : [el("p", { class: "p-sub", text: t("rt.no_late") })]), late.length ? "overdue" : ""));

    nodes.push(S.card([el("h2", { text: t("rt.tasks") }), addTaskForm()].concat(taskTable(r.tasks, today))));
    nodes.push(await editChecklist());
    S.show(nodes);
  }

  function daysLate(due, today) { return Math.max(1, Math.round((Date.parse(today) - Date.parse(due)) / 86400000)); }

  function taskTable(tasks, today) {
    if (!tasks.length) return [el("p", { class: "p-sub", text: t("rt.none") })];
    var open = tasks.filter(function (x) { return x.status !== "done"; }), done = tasks.filter(function (x) { return x.status === "done"; });
    function row(x) {
      var sel = el("select", { "aria-label": t("rt.status") }, ["not_started", "in_progress", "done"].map(function (s) { return S.opt(s, t("rt.st." + s)); })); sel.value = x.status;
      sel.addEventListener("change", async function () {
        var r = await client.from("owner_tasks").update({ status: sel.value }).eq("id", x.id);
        if (r.error) { sel.value = x.status; return; }
        S.setFlash(t("rt.saved")); routine();
      });
      var dueText = x.due_date + (x.late ? "  ⚠ " + t("rt.st.late") + " (" + daysLate(x.due_date, today) + " " + t("rt.days_late") + ")" : x.due_date === today && x.status !== "done" ? "  · " + t("rt.due_today") : "");
      return el("tr", { class: x.late ? "row-bad" : "" }, [el("td", { text: x.what }), el("td", { text: x.who || t("rt.unassigned") }), el("td", { text: dueText }), el("td", {}, [sel])]);
    }
    var head = el("thead", {}, [el("tr", {}, [t("rt.what"), t("rt.who"), t("rt.due"), t("rt.status")].map(function (h) { return el("th", { text: h }); }))]);
    var out = [el("div", { class: "tbl-wrap" }, [el("table", { class: "tbl" }, [head, el("tbody", {}, open.map(row))])])];
    if (done.length) out.push(el("details", { class: "action" }, [el("summary", { text: t("rt.done_recent") + " (" + done.length + ")" }), el("div", { class: "tbl-wrap" }, [el("table", { class: "tbl" }, [head.cloneNode(true), el("tbody", {}, done.map(row))])])]));
    return out;
  }

  function addTaskForm() {
    var what = el("input", { type: "text", maxlength: "200" }), due = el("input", { type: "date" }); due.value = L.periodFor("month", Date.now()).to;
    var who = el("select", {}, [S.opt("", t("rt.unassigned"))]);
    S.loadStaff().then(function (staff) { (staff || []).forEach(function (p) { who.appendChild(S.opt(p.id, p.full_name)); }); });
    var msg = el("div", {}), btn = el("button", { type: "submit", class: "btn btn-pink btn-small", text: t("rt.add") });
    var form = el("form", { novalidate: "novalidate" }, [el("div", { class: "f-grid" }, [S.field(t("rt.what"), what), S.field(t("rt.who"), who), S.field(t("rt.due"), due)]), msg, btn]);
    form.addEventListener("submit", async function (e) {
      e.preventDefault(); msg.textContent = "";
      if (!what.value.trim()) { msg.appendChild(S.note("err", t("rt.need_what"))); return; }
      btn.disabled = true;
      var r = await client.from("owner_tasks").insert({ what: what.value.trim(), assigned_to: who.value || null, due_date: due.value });
      if (r.error) { msg.appendChild(S.note("err", t("rt.err"))); btn.disabled = false; return; }
      S.setFlash(t("rt.saved")); routine();
    });
    return el("details", { class: "action", open: "open" }, [el("summary", { text: t("rt.add_task") }), form]);
  }

  async function editChecklist() {
    var q = await client.from("checklist_items").select("id, list, position, label, active").order("list").order("position");
    var items = q.data || [], kids = [el("summary", { text: t("rt.edit") }), el("p", { class: "p-sub", text: t("rt.edit_hint") }), el("p", { class: "p-sub small", text: t("rt.placeholder_note") })];
    ["morning", "afternoon"].forEach(function (key) {
      kids.push(el("h3", { text: t("rt." + key) }));
      var mine = items.filter(function (i) { return i.list === key; });
      mine.forEach(function (i) {
        var label = el("input", { type: "text", maxlength: "200" }); label.value = i.label;
        var act = el("input", { type: "checkbox" }); act.checked = i.active;
        label.addEventListener("change", function () { if (!label.value.trim()) { label.value = i.label; return; } client.from("checklist_items").update({ label: label.value.trim() }).eq("id", i.id).then(function (r) { if (r.error) label.value = i.label; else i.label = label.value.trim(); }); });
        act.addEventListener("change", function () { client.from("checklist_items").update({ active: act.checked }).eq("id", i.id).then(function (r) { if (r.error) act.checked = i.active; else i.active = act.checked; }); });
        kids.push(el("div", { class: "cat-row" }, [label, el("label", {}, [act, " " + t("rt.item_active")])]));
      });
      var nl = el("input", { type: "text", maxlength: "200", placeholder: t("rt.new_item") }), add = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("rt.add_item") });
      add.addEventListener("click", async function () {
        if (!nl.value.trim()) return;
        var pos = mine.reduce(function (m, i) { return Math.max(m, i.position); }, 0) + 1;
        var r = await client.from("checklist_items").insert({ list: key, position: pos, label: nl.value.trim() });
        if (!r.error) { S.setFlash(t("rt.saved")); routine(); }
      });
      kids.push(el("div", { class: "cat-row" }, [nl, add]));
    });
    return el("div", { class: "p-card" }, [el("details", { class: "action" }, kids)]);
  }

  S.routes.routine = routine;
})();
