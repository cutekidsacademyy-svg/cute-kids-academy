// Parent portal: Payments (#/payments) and receipts (#/receipt/<id>). A parent sees what they owe for their own children, the
// itemised charges, the late-fee rule in plain words, how to pay with InstaPay (the address and a unique payment note, each with
// a copy button; or the bank's payment link), a form to say "I've paid" with the transaction reference, and the payment history
// with printable receipts. InstaPay cannot tell us a payment arrived, so finance confirms each reference against the bank statement.
// The database only shows a family their own money. Text is only ever inserted as text.
(function () {
  "use strict";
  var P = window.CKAParent, el = CKA.el, t = CKA.t, L = window.CKALogic, client = CKA.client;
  var chosen = null, flash = null;
  var MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

  function lang() { return CKA.getLang(); }
  function loc() { return lang() === "ar" ? "ar-EG" : "en-GB"; }
  function money(n) { return Number(n).toLocaleString(loc(), { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + " " + t("rc.egp"); }
  function monthName(ymd) { return new Intl.DateTimeFormat(loc(), { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(String(ymd).slice(0, 10) + "T12:00:00Z")); }
  function dayName(ymd) { return new Intl.DateTimeFormat(loc(), { timeZone: "UTC", day: "numeric", month: "long" }).format(new Date(String(ymd).slice(0, 10) + "T12:00:00Z")); }
  function iso(d) { return String(d).slice(0, 10); }
  function fill(s, o) { return s.replace(/\{(\w+)\}/g, function (m, k) { return o[k] != null ? o[k] : m; }); }
  function copyButton(text) {
    var b = el("button", { type: "button", class: "btn btn-outline btn-small", text: "⧉ " + t("pay.copy") });
    b.addEventListener("click", function () {
      function ok() { b.textContent = t("pay.copied"); setTimeout(function () { b.textContent = "⧉ " + t("pay.copy"); }, 1800); }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, ok); else { var i = document.createElement("textarea"); i.value = text; document.body.appendChild(i); i.select(); try { document.execCommand("copy"); } catch (e) {} i.remove(); ok(); }
    });
    return b;
  }
  function boxRow(label, value, copy) { return el("div", { class: "kv" }, [el("span", { class: "k", text: label }), el("div", { class: "actions", style: "align-items:center" }, [el("strong", { dir: "ltr", class: "ref-big", text: value }), copy ? copyButton(value) : null].filter(Boolean))]); }

  async function page() {
    P.loadingView();
    var kids = P.children(), nodes = [];
    if (flash) { nodes.push(P.note(flash.kind, flash.text)); flash = null; }
    nodes.push(P.card([el("h1", { text: t("pay.title") })]));
    if (!kids.length) return P.show(nodes);
    if (!chosen || !kids.some(function (k) { return k.id === chosen; })) chosen = kids[0].id;
    if (kids.length > 1) {
      var bar = el("div", { class: "actions" });
      kids.forEach(function (k) { var b = el("button", { type: "button", class: "filter-pill" + (k.id === chosen ? " active" : ""), text: k.full_name }); b.addEventListener("click", function () { chosen = k.id; page(); }); bar.appendChild(b); });
      nodes.push(P.card([el("h2", { text: t("pay.child") }), bar]));
    }
    var kid = kids.filter(function (k) { return k.id === chosen; })[0];
    var res = await Promise.all([client.from("payment_settings").select("*").maybeSingle(), client.rpc("payment_balances", { p_child: kid.id }),
      client.from("charges").select("id, month, kind, description, amount, waived").eq("child_id", kid.id).order("month", { ascending: false }).limit(80),
      client.from("payments").select("id, month, amount, method, reference, status, reject_reason, submitted_at, receipt_no").eq("child_id", kid.id).order("submitted_at", { ascending: false }).limit(40)]);
    var s = res[0].data || {}, bals = (res[1].data || []).slice(), charges = res[2].data || [], pays = (res[3].data || []).slice().sort(function (a, b) { return a.submitted_at < b.submitted_at ? 1 : -1; });
    var due = bals.filter(function (b) { return Number(b.balance) > 0; }), totalDue = due.reduce(function (a, b) { return a + Number(b.balance); }, 0), waiting = due.reduce(function (a, b) { return a + Number(b.waiting); }, 0);
    var toSend = Math.max(0, totalDue - waiting);

    // what is due now
    var head = [el("h2", { text: kid.full_name }), totalDue > 0 ? el("p", { class: "ref-big att-msg bad", text: t("pay.due_now") + ": " + money(totalDue) }) : el("p", { class: "promise-big", text: "✓ " + t("pay.all_paid") })];
    if (waiting > 0) head.push(el("p", { class: "p-sub", text: t("pay.waiting") + ": " + money(waiting) }));
    due.forEach(function (b) {
      var months = charges.filter(function (c) { return iso(c.month) === iso(b.month) && !c.waived; });
      head.push(el("div", { class: "action" }, [el("strong", { text: monthName(b.month) + " · " + t("pay.balance") + ": " + money(b.balance) }),
        el("small", { text: t("pay.due_date") + ": " + dayName(b.due_date) + (b.overdue ? " ⚠" : "") })].concat(months.map(function (c) { return el("div", { class: "kv" }, [el("span", { text: t("pay.k." + c.kind) + (c.description && c.description !== t("pay.k." + c.kind) ? " · " + c.description : "") }), el("strong", { text: money(c.amount) })]); }))));
    });
    // the late-fee rule in plain words
    var rule = t("pay.late_rule_off");
    if (s.late_fees_on) {
      var feeText = s.late_fee_kind === "percent" ? fill(t("pay.fee_percent"), { n: s.late_fee_value }) : fill(t("pay.fee_fixed"), { n: s.late_fee_value });
      var m0 = L.periodFor("month", Date.now()).from, last = new Date(m0 + "T12:00:00Z"); last.setUTCDate(s.due_day + s.grace_days);
      rule = fill(t("pay.late_rule"), { date: dayName(last.toISOString()), fee: feeText });
    }
    head.push(el("p", { class: "p-sub", text: rule }));
    nodes.push(P.card(head, "blue"));

    // how to pay
    if (toSend > 0 || due.length) {
      var month = due.length ? iso(due[due.length - 1].month) : iso(L.periodFor("month", Date.now()).from);
      var note = "CKA-" + String(kid.full_name).split(/\s+/)[0].replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 12) + "-" + MON[Number(month.slice(5, 7)) - 1];
      var how = [el("h2", { text: t("pay.how") })];
      if (!s.instapay_ipa && !s.instapay_link && !s.bank_details) how.push(el("p", { class: "p-sub", text: t("pay.no_settings") }));
      if (s.instapay_link) how.push(el("a", { class: "btn btn-pink btn-block", href: s.instapay_link, target: "_blank", rel: "noopener", text: "🔗 " + t("pay.link") }));
      how.push(boxRow(t("pay.amount"), String(toSend), true));
      if (s.instapay_ipa) how.push(boxRow(t("pay.ipa"), s.instapay_ipa, true));
      how.push(boxRow(t("pay.note"), note, true));
      if (s.bank_details) how.push(el("div", { class: "kv" }, [el("span", { class: "k", text: t("pay.bank") }), el("span", { class: "preline", text: s.bank_details })]));
      nodes.push(P.card(how));
      nodes.push(paidForm(kid, due, month, toSend));
    }

    // history
    nodes.push(P.card([el("h2", { text: t("pay.history") })].concat(pays.length ? pays.map(function (p) {
      return el("div", { class: "kv" }, [el("strong", { text: monthName(p.month) + " · " + money(p.amount) }), el("small", { text: t("pay.method." + p.method) + (p.reference ? " · " + p.reference : "") }),
        el("span", { class: p.status === "confirmed" ? "att-msg ok" : p.status === "rejected" ? "att-msg bad" : "p-who", text: t("pay.st." + p.status) + (p.status === "rejected" && p.reject_reason ? ": " + p.reject_reason : "") }),
        p.status === "confirmed" ? P.link("#/receipt/" + p.id, "🧾 " + t("pay.receipt") + " CKA-" + String(p.receipt_no).padStart(5, "0")) : null].filter(Boolean));
    }) : [el("p", { class: "p-sub", text: t("pay.none") })])));
    P.show(nodes);
  }

  function paidForm(kid, due, month, toSend) {
    var months = due.length ? due.map(function (b) { return iso(b.month); }) : [month];
    var sel = el("select", { id: "pm" }, months.map(function (m) { return el("option", { value: m, text: monthName(m) }); })); sel.value = month;
    var amount = el("input", { type: "number", min: "1", step: "0.01", inputmode: "decimal", id: "pa" }); amount.value = toSend > 0 ? String(toSend) : "";
    var ref = el("input", { type: "text", maxlength: "60", id: "pr", dir: "ltr" }), shot = el("input", { type: "file", accept: "image/*", id: "ps" });
    var err = el("div", { class: "note err hidden", role: "alert" }), send = el("button", { type: "submit", class: "btn btn-pink btn-block", text: t("pay.send") });
    function fail(k) { err.textContent = t(k); err.classList.remove("hidden"); err.scrollIntoView({ block: "center" }); }
    var form = el("form", { novalidate: "novalidate" }, [P.field(t("pay.month"), sel, "pm"), P.field(t("pay.sent_amount"), amount, "pa"), P.field(t("pay.reference"), ref, "pr"), P.field(t("pay.screenshot"), shot, "ps"), err, send]);
    form.addEventListener("submit", async function (e) {
      e.preventDefault(); err.classList.add("hidden");
      if (!(Number(amount.value) > 0)) return fail("pay.need_amount");
      if (ref.value.trim().length < 4) return fail("pay.need_ref");
      send.disabled = true;
      try {
        var path = null;
        if (shot.files && shot.files[0]) {
          try { var blob = await P.prepareImage(shot.files[0]); path = kid.id + "/" + crypto.randomUUID() + ".jpg"; var up = await client.storage.from("payments").upload(path, blob, { contentType: "image/jpeg" }); if (up.error) throw up.error; }
          catch (x) { send.disabled = false; return fail("pay.shot_bad"); }
        }
        var r = await client.rpc("payment_submit", { p_child: kid.id, p_month: sel.value, p_amount: Number(amount.value), p_reference: ref.value, p_screenshot: path });
        if (r.error) { send.disabled = false; return fail(/reference_used/.test(r.error.message) ? "pay.ref_used" : "pay.err"); }
        flash = { kind: "ok", text: t("pay.thanks") }; page();
      } catch (x) { send.disabled = false; fail("pay.err"); }
    });
    return P.card([el("h2", { text: t("pay.paid_form") }), el("p", { class: "p-sub", text: t("pay.paid_hint") }), form]);
  }

  P.routes.payments = page;
  P.routes.receipt = function (parts) { return window.CKAReceipt.show(parts[1], function (nodes) { P.show(nodes); }, "#/payments"); };
})();
