// A printable payment receipt (#/receipt/<id>) shared by the parent portal and the finance screen.
// The page is the receipt; "Print or save as PDF" uses the browser's own print dialog. Text is only ever inserted as text.
(function () {
  "use strict";
  var el = CKA.el, t = CKA.t, client = CKA.client;
  async function show(id, host, back) {
    var r = await client.rpc("payment_receipt", { p_id: id });
    var d = r.data;
    var loc = CKA.getLang() === "ar" ? "ar-EG" : "en-GB";
    function row(k, v) { return el("div", { class: "kv" }, [el("span", { class: "k", text: k }), el("strong", { text: v == null ? "" : String(v) })]); }
    var nodes = [el("a", { class: "p-link", href: back, text: t("rc.back") })];
    if (!d) { nodes.push(el("div", { class: "note err", text: t("p.error") || "?" })); host(nodes); return; }
    var month = new Intl.DateTimeFormat(loc, { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(String(d.month).slice(0, 10) + "T12:00:00Z"));
    var when = new Intl.DateTimeFormat(loc, { timeZone: "Africa/Cairo", dateStyle: "long" }).format(new Date(d.confirmed_at));
    var a = d.academy || {};
    var print = el("button", { type: "button", class: "btn btn-pink no-print", text: "🖨 " + t("rc.print") });
    print.addEventListener("click", function () { window.print(); });
    nodes.push(el("div", { class: "p-card receipt" }, [el("img", { class: "p-logo", src: "/images/logo.png", alt: "Cute Kids Academy" }), el("h1", { text: t("rc.title") }),
      row(t("rc.no"), "CKA-" + String(d.receipt_no).padStart(5, "0")), row(t("rc.date"), when), row(t("rc.child"), d.child_name), row(t("rc.parents"), d.parents), row(t("rc.month"), month),
      row(t("rc.amount"), Number(d.amount).toFixed(2) + " " + t("rc.egp")), row(t("rc.method"), t("pay.method." + d.method)), d.reference ? row(t("rc.ref"), d.reference) : null,
      el("p", { class: "p-sub", text: [a.phone, a.email, CKA.getLang() === "ar" ? a.address_ar || a.address_en : a.address_en || a.address_ar].filter(Boolean).join(" · ") }), el("p", { text: t("rc.thanks") }), print].filter(Boolean)));
    host(nodes);
  }
  window.CKAReceipt = { show: show };
})();
