// Parent portal: School bus (#/transport) — the route, driver, stop and times for each child, and today's status. A home card
// shows today's status when the child rides the bus. Only the family's own children are returned by the database.
// Text is only ever inserted as text.
(function () {
  "use strict";
  var P = window.CKAParent, el = CKA.el, t = CKA.t, client = CKA.client;
  function hm(v) { return v ? String(v).slice(0, 5) : "—"; }

  async function load() { var r = await client.rpc("parent_transport"); return r.data || []; }
  function block(c) {
    function kv(k, v, ltr) { return el("div", { class: "kv" }, [el("span", { class: "k", text: k }), el("strong", ltr ? { dir: "ltr", text: v } : { text: v })]); }
    var st = function (s) { return t("pt.st." + (s || "none")); };
    return [el("h2", { text: c.child_name }), kv(t("pt.route"), c.route), kv(t("pt.driver"), [c.driver_name, c.driver_phone].filter(Boolean).join(" · ") || "—", true), kv(t("pt.stop"), c.stop || "—"),
      kv(t("pt.morning"), hm(c.morning_time) + " · " + t("pt.today") + ": " + st(c.morning_status)), kv(t("pt.afternoon"), hm(c.afternoon_time) + " · " + t("pt.today") + ": " + st(c.afternoon_status))];
  }
  async function page() {
    P.loadingView();
    var list = await load(), nodes = [P.card([el("h1", { text: t("pt.title") })])];
    if (!list.length) nodes.push(P.card([el("p", { class: "p-sub", text: t("pt.none") })]));
    list.forEach(function (c) { nodes.push(P.card(block(c), "blue")); });
    P.show(nodes);
  }
  P.routes.transport = page;
  P.homeCards.push(async function () {
    var list = await load();
    if (!list.length) return null;
    return P.card([el("h2", { text: "🚌 " + t("pt.title") })].concat(list.map(function (c) {
      return el("div", { class: "kv" }, [el("strong", { text: c.child_name }), el("small", { text: t("pt.morning") + ": " + t("pt.st." + (c.morning_status || "none")) + " · " + t("pt.afternoon") + ": " + t("pt.st." + (c.afternoon_status || "none")) })]);
    })).concat([P.link("#/transport", t("pt.title"))]), "blue");
  });
})();
