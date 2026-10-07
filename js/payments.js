// Finance screen (#/payments) for the finance role and the owner: every family for a month (paid, waiting, due, overdue) with
// filter and search, the payments waiting for confirmation (match the reference to the bank statement, confirm or reject with a
// reason), recording cash or a bank transfer, adding or removing charges, fee plans, the owner's summary and settings, and a CSV
// for the accountant. Teachers, admin and manager never see this page; the database refuses them anyway.
// Text from the database is only ever inserted as text.
(function () {
  "use strict";
  var S = window.CKAStaff, el = CKA.el, t = CKA.t, L = window.CKALogic, client = CKA.client;
  var month = null, filter = "all", q = "", openChild = null, flash = null;

  function lang() { return CKA.getLang(); }
  function loc() { return lang() === "ar" ? "ar-EG" : "en-GB"; }
  function money(n) { return Number(n || 0).toLocaleString(loc(), { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
  function monthName(ymd) { return new Intl.DateTimeFormat(loc(), { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(String(ymd).slice(0, 10) + "T12:00:00Z")); }
  function addMonths(ymd, n) { var d = new Date(String(ymd).slice(0, 7) + "-01T12:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); }
  function input(type, attrs, v) { var i = el("input", Object.assign({ type: type }, attrs || {})); if (v != null) i.value = v; return i; }
  function allowed() { return S.me().role === "finance" || S.me().role === "owner"; }
  function stPill(s) { return S.pill(t("py.s." + s), s === "paid" ? "st-resolved" : s === "overdue" ? "urg-critical" : s === "waiting" ? "urg-urgent" : ""); }

  async function payments() {
    if (!allowed()) return S.routes[""]();
    S.loadingView();
    if (!month) month = L.periodFor("month", Date.now()).from;
    var res = await Promise.all([S.rpc("payments_month", { p_month: month }), S.rpc("payments_list", { p_month: null }), client.from("payment_settings").select("*").maybeSingle()]);
    var rows = res[0], list = res[1], s = res[2].data || {};
    var nodes = [];
    if (flash) { nodes.push(S.note(flash.kind, flash.text)); flash = null; }

    // month, tiles, filters, csv
    var prev = el("button", { type: "button", class: "btn btn-outline btn-small", text: "‹ " + t("py.prev") }), next = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("py.next") + " ›" });
    prev.addEventListener("click", function () { month = addMonths(month, -1); openChild = null; payments(); }); next.addEventListener("click", function () { month = addMonths(month, 1); openChild = null; payments(); });
    function count(st) { return rows.filter(function (r) { return r.status === st; }).length; }
    function tile(n, label, cls) { return el("div", { class: "tile " + (cls || "") }, [el("strong", { text: String(n) }), el("span", { text: label })]); }
    var csv = el("button", { type: "button", class: "btn btn-outline btn-small", text: "⬇ " + t("py.csv") });
    csv.addEventListener("click", function () {
      var sec = [{ title: t("py.title") + " " + monthName(month), header: [t("py.col_child"), t("py.col_parents"), t("py.col_charges"), t("py.col_paid"), t("py.col_waiting"), t("py.col_balance"), t("py.col_status")],
        rows: rows.filter(function (r) { return r.status !== "none"; }).map(function (r) { return [r.child_name, r.parents, r.charges, r.paid, r.waiting, r.balance, t("py.s." + r.status)]; }) }];
      var blob = new Blob(["﻿" + L.toCsv(sec)], { type: "text/csv;charset=utf-8" }), a = el("a", { href: URL.createObjectURL(blob), download: "cka-payments-" + month.slice(0, 7) + ".csv" });
      document.body.appendChild(a); a.click(); a.remove();
    });
    nodes.push(S.card([el("h1", { text: t("py.title") + " · " + monthName(month) }), el("div", { class: "actions" }, [prev, next, csv]),
      el("div", { class: "tiles" }, [tile(rows.filter(function (r) { return r.status !== "none"; }).length, t("py.t.families")), tile(count("paid"), t("py.t.paid"), "good"), tile(count("waiting"), t("py.t.waiting")), tile(count("due"), t("py.t.due")), tile(count("overdue"), t("py.t.overdue"), count("overdue") ? "bad" : "")])], "blue"));

    if (S.me().role === "owner") nodes.push(await ownerCard(s));

    // waiting for confirmation (all months)
    var waiting = list.filter(function (p) { return p.status === "waiting"; });
    nodes.push(S.card([el("h2", { text: "⏳ " + t("py.waiting_title") })].concat(waiting.length ? waiting.map(waitingRow) : [el("p", { class: "p-sub", text: t("py.no_waiting") })]), waiting.length ? "" : "blue"));

    // the families
    var bar = el("div", { class: "actions" });
    [["all", "py.f.all"], ["overdue", "py.s.overdue"], ["due", "py.s.due"], ["waiting", "py.s.waiting"], ["paid", "py.s.paid"]].forEach(function (o) {
      var b = el("button", { type: "button", class: "filter-pill" + (filter === o[0] ? " active" : ""), text: t(o[1]) }); b.addEventListener("click", function () { filter = o[0]; payments(); }); bar.appendChild(b);
    });
    var search = input("search", { placeholder: t("py.search"), "aria-label": t("py.search") }, q), box = el("div", {});
    function draw() {
      box.textContent = "";
      var ql = q.toLowerCase().trim();
      var f = rows.filter(function (r) { return (filter === "all" ? r.status !== "none" || ql : r.status === filter) && (!ql || r.child_name.toLowerCase().indexOf(ql) >= 0 || (r.parents || "").toLowerCase().indexOf(ql) >= 0); });
      if (!f.length) box.appendChild(el("p", { class: "p-sub", text: t("py.none") }));
      f.forEach(function (r) { box.appendChild(familyRow(r, list, s)); });
    }
    search.addEventListener("input", function () { q = search.value; draw(); }); draw();
    nodes.push(S.card([bar, search, box]));
    S.show(nodes);
  }

  function waitingRow(p) {
    var rej = input("text", { maxlength: "300", placeholder: t("py.reject_reason") }), msg = el("div", {});
    var ok = el("button", { type: "button", class: "btn btn-pink btn-small", text: t("py.confirm") }), no = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("py.reject") });
    ok.addEventListener("click", async function () { ok.disabled = no.disabled = true; try { await S.rpc("payment_confirm", { p_id: p.id }); flash = { kind: "ok", text: t("py.confirmed") }; payments(); } catch (e) { ok.disabled = no.disabled = false; msg.appendChild(S.note("err", S.msgFromError(e))); } });
    no.addEventListener("click", async function () {
      msg.textContent = ""; if (rej.value.trim().length < 3) { msg.appendChild(S.note("err", t("py.reject_need"))); return; }
      ok.disabled = no.disabled = true; try { await S.rpc("payment_reject", { p_id: p.id, p_reason: rej.value }); flash = { kind: "ok", text: t("py.rejected") }; payments(); } catch (e) { ok.disabled = no.disabled = false; msg.appendChild(S.note("err", S.msgFromError(e))); }
    });
    var kids = [el("strong", { text: p.child_name + " · " + monthName(p.month) + " · " + money(p.amount) + " " + t("rc.egp") }), el("div", { text: t("py.ref") + ": " + (p.reference || "—"), dir: "ltr" })];
    if (p.screenshot_path) {
      var v = el("button", { type: "button", class: "btn btn-outline btn-small", text: "🖼 " + t("py.screenshot") });
      v.addEventListener("click", async function () { var w = window.open("about:blank", "_blank"), r = await client.storage.from("payments").createSignedUrl(p.screenshot_path, 300); if (r.data && w) w.location.href = r.data.signedUrl; else if (w) w.close(); });
      kids.push(v);
    }
    kids.push(rej, msg, el("div", { class: "actions" }, [ok, no]));
    return el("div", { class: "action" }, kids);
  }

  function familyRow(r, list, s) {
    var head = el("div", { class: "case-top" }, [el("strong", { text: r.child_name }), stPill(r.status)]);
    var line = el("small", { text: (r.parents || "") + " · " + t("py.col_charges") + " " + money(r.charges) + " · " + t("py.col_paid") + " " + money(r.paid) + " · " + t("py.col_balance") + " " + money(r.balance) });
    var open = openChild === r.child_id, b = el("button", { type: "button", class: "btn btn-outline btn-small", text: open ? "✕" : t("py.open") });
    b.addEventListener("click", function () { openChild = open ? null : r.child_id; payments(); });
    var kids = [head, line, el("div", { class: "actions" }, [b])];
    var holder = el("div", {}); kids.push(holder);
    if (open) detail(r, holder, list, s);
    return el("div", { class: "case-item", style: "cursor:default" }, kids);
  }

  async function detail(r, holder, list, s) {
    var res = await Promise.all([client.from("charges").select("id, kind, description, amount, waived, removed, waived_reason").eq("child_id", r.child_id).eq("month", month), client.from("fee_plans").select("*").eq("child_id", r.child_id).order("starts_on", { ascending: false }).limit(1)]);
    var ch = (res[0].data || []).filter(function (c) { return !c.removed; }), plan = (res[1].data || [])[0], pays = list.filter(function (p) { return p.child_id === r.child_id && String(p.month).slice(0, 10) === month.slice(0, 10); });
    var msg = el("div", {});
    function done(text) { return function () { flash = { kind: "ok", text: text }; payments(); }; }
    function fail(e) { msg.textContent = ""; msg.appendChild(S.note("err", S.msgFromError(e))); }
    holder.appendChild(el("h3", { text: t("py.charges_list") }));
    ch.forEach(function (c) {
      var acts = el("div", { class: "actions" });
      if (c.kind !== "late_fee" && !c.waived) { var rm = el("button", { type: "button", class: "p-link", text: t("py.remove") }); rm.addEventListener("click", async function () { try { await S.rpc("charge_remove", { p_id: c.id }); done(t("py.removed"))(); } catch (e) { fail(e); } }); acts.appendChild(rm); }
      if (c.kind === "late_fee" && !c.waived && S.me().role === "owner") {
        var why = input("text", { maxlength: "200", placeholder: t("py.waive_reason") }), wv = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("py.waive") });
        wv.addEventListener("click", async function () { try { await S.rpc("late_fee_waive", { p_id: c.id, p_reason: why.value }); done(t("py.waived"))(); } catch (e) { fail(e); } });
        acts.appendChild(why); acts.appendChild(wv);
      }
      holder.appendChild(el("div", { class: "kv" }, [el("strong", { text: t("pay.k." + c.kind) + (c.description && c.description !== t("pay.k." + c.kind) ? " · " + c.description : "") + " · " + money(c.amount) + (c.waived ? " (" + t("pay.waived") + (c.waived_reason ? ": " + c.waived_reason : "") + ")" : "") }), acts]));
    });
    pays.forEach(function (p) { holder.appendChild(el("div", { class: "kv" }, [el("span", { text: t("pay.method." + p.method) + " · " + money(p.amount) + " · " + (p.reference || "—") + " · " + t("pay.st." + p.status) }), p.status === "confirmed" ? S.link("#/receipt/" + p.id, "🧾 CKA-" + String(p.receipt_no).padStart(5, "0")) : null].filter(Boolean))); });

    // record cash or a bank transfer
    var method = el("select", {}, [S.opt("cash", t("pay.method.cash")), S.opt("bank_transfer", t("pay.method.bank_transfer"))]), amt = input("number", { min: "1", step: "0.01" }, r.balance > 0 ? r.balance : ""), ref = input("text", { maxlength: "60" });
    var rec = el("button", { type: "button", class: "btn btn-pink btn-small", text: t("py.rec_btn") });
    rec.addEventListener("click", async function () { rec.disabled = true; try { await S.rpc("payment_record", { p_child: r.child_id, p_month: month, p_amount: Number(amt.value), p_method: method.value, p_reference: ref.value }); done(t("py.recorded"))(); } catch (e) { rec.disabled = false; fail(e); } });
    holder.appendChild(el("div", { class: "action" }, [el("h3", { text: t("py.record") }), el("div", { class: "f-grid" }, [S.field(t("py.method"), method), S.field(t("py.rec_amount"), amt)]), S.field(t("py.rec_ref"), ref), rec]));

    // add a charge
    var kind = el("select", {}, ["transport", "tuition", "event", "other"].map(function (k) { return S.opt(k, t("pay.k." + k)); })), desc = input("text", { maxlength: "200" }), camt = input("number", { min: "1", step: "0.01" });
    var addc = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("py.charge_btn") });
    addc.addEventListener("click", async function () { addc.disabled = true; try { await S.rpc("charge_add", { p_child: r.child_id, p_month: month, p_kind: kind.value, p_description: desc.value, p_amount: Number(camt.value) }); done(t("py.charge_added"))(); } catch (e) { addc.disabled = false; fail(e); } });
    holder.appendChild(el("div", { class: "action" }, [el("h3", { text: t("py.add_charge") }), el("div", { class: "f-grid" }, [S.field(t("py.kind"), kind), S.field(t("py.rec_amount"), camt)]), S.field(t("py.desc"), desc), addc]));

    // fee plan
    var prog = el("select", {}, ["nursery", "preschool", "after_school", "camp"].map(function (k) { return S.opt(k, t("py.prog." + k)); })); if (plan) prog.value = plan.programme;
    var pa = input("number", { min: "0", step: "0.01" }, plan ? plan.monthly_amount : ""), from = input("date", {}, month.slice(0, 10)), sp = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("py.plan_save") });
    sp.addEventListener("click", async function () { sp.disabled = true; try { await S.rpc("fee_plan_save", { p_child: r.child_id, p_programme: prog.value, p_amount: Number(pa.value), p_starts: from.value }); done(t("py.plan_saved"))(); } catch (e) { sp.disabled = false; fail(e); } });
    holder.appendChild(el("div", { class: "action" }, [el("h3", { text: t("py.plan") }), plan ? null : el("p", { class: "p-sub", text: t("py.no_plan") }), el("div", { class: "f-grid" }, [S.field(t("py.plan_prog"), prog), S.field(t("py.plan_amount"), pa)]), S.field(t("py.plan_from"), from), sp].filter(Boolean)));
    holder.appendChild(msg);
  }

  // ------------------------------------------------------------------ Owner: summary and settings
  async function ownerCard(s) {
    var o = await S.rpc("payments_owner_summary", { p_month: month });
    function tile(n, label, cls) { return el("div", { class: "tile " + (cls || "") }, [el("strong", { text: money(n) }), el("span", { text: label })]); }
    var kids = [el("h2", { text: t("py.owner") }), el("div", { class: "tiles" }, [tile(o.expected, t("py.o.expected")), tile(o.collected, t("py.o.collected"), "good"), tile(o.waiting, t("py.o.waiting")), tile(o.overdue_families, t("py.o.overdue"), o.overdue_families ? "bad" : ""), tile(o.late_fees_added, t("py.o.late_added")), tile(o.late_fees_waived, t("py.o.late_waived"))])];
    var due = input("number", { min: "1", max: "28" }, s.due_day), grace = input("number", { min: "0", max: "28" }, s.grace_days), on = el("input", { type: "checkbox" }); on.checked = !!s.late_fees_on;
    var kind = el("select", {}, [S.opt("fixed", t("py.set.fixed")), S.opt("percent", t("py.set.percent"))]); kind.value = s.late_fee_kind || "fixed";
    var val = input("number", { min: "0", step: "0.01" }, s.late_fee_value), rem = input("text", {}, (s.reminder_days || [25, 1, 5]).join(", ")), ot = input("number", { min: "0", step: "0.01" }, s.overtime_rate);
    var ipa = input("text", { maxlength: "100", dir: "ltr" }, s.instapay_ipa || ""), link = input("url", { maxlength: "500", dir: "ltr" }, s.instapay_link || ""), bank = S.textarea(3, ""); bank.value = s.bank_details || "";
    var msg = el("div", {}), save = el("button", { type: "button", class: "btn btn-pink", text: t("py.set.save") });
    save.addEventListener("click", async function () {
      msg.textContent = ""; save.disabled = true;
      try {
        await S.rpc("payment_settings_save", { p_due_day: Number(due.value), p_grace: Number(grace.value), p_late_on: on.checked, p_late_kind: kind.value, p_late_value: Number(val.value || 0),
          p_reminder_days: rem.value.split(/[,\s]+/).filter(Boolean).map(Number), p_overtime_rate: Number(ot.value || 0), p_ipa: ipa.value, p_link: link.value, p_bank: bank.value });
        msg.appendChild(S.note("ok", t("py.set.saved")));
      } catch (e) { msg.appendChild(S.note("err", S.msgFromError(e))); }
      save.disabled = false;
    });
    kids.push(el("details", { class: "action" }, [el("summary", { text: t("py.set.title") }), el("p", { class: "p-sub", text: t("py.set.note") }), el("div", { class: "f-grid" }, [S.field(t("py.set.due"), due), S.field(t("py.set.grace"), grace)]),
      el("label", { class: "choice" }, [on, el("span", { text: t("py.set.late_on") })]), el("div", { class: "f-grid" }, [S.field(t("py.set.late_kind"), kind), S.field(t("py.set.late_value"), val)]), S.field(t("py.set.reminders"), rem), S.field(t("py.set.overtime"), ot),
      S.field(t("py.set.ipa"), ipa), S.field(t("py.set.link"), link), S.field(t("py.set.bank"), bank), msg, save]));
    return S.card(kids);
  }

  S.routes.payments = payments;
  S.routes.receipt = function (parts) { return window.CKAReceipt.show(parts[1], function (nodes) { S.show(nodes); }, "#/payments"); };
})();
