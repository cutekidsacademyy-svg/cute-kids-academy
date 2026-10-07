// Parent portal: Messages from the academy (#/messages) — the check-in notes that follow an absence, birthday wishes and
// other short notes — and a home card that shows when something is unread. A parent only ever reads their own messages
// (row-level security). Text is only ever inserted as text.
(function () {
  "use strict";
  var P = window.CKAParent, el = CKA.el, t = CKA.t, client = CKA.client;

  function when(iso) { return new Intl.DateTimeFormat(CKA.getLang() === "ar" ? "ar-EG" : "en-GB", { timeZone: "Africa/Cairo", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)); }

  async function page() {
    P.loadingView();
    var r = await client.from("parent_messages").select("id, kind, body, created_at, read_at, children(full_name)").order("created_at", { ascending: false }).limit(50);
    var list = r.data || [], nodes = [P.card([el("h1", { text: t("ms.title") })])];
    if (!list.length) nodes.push(P.card([el("p", { class: "p-sub", text: t("ms.none") })]));
    list.forEach(function (m) {
      var kids = [el("div", { class: "case-top" }, [el("strong", { text: t("ms.k." + m.kind) + (m.children ? " · " + m.children.full_name : "") }), m.read_at ? null : P.pill(t("ms.new"), "urg-urgent")].filter(Boolean)),
        el("p", { class: "preline", text: m.body }), el("small", { text: when(m.created_at) })];
      nodes.push(P.card(kids, m.read_at ? "" : "blue"));
      if (!m.read_at) client.rpc("parent_message_read", { p_id: m.id });
    });
    P.show(nodes);
  }

  P.routes.messages = page;
  P.homeCards.push(async function () {
    var r = await client.from("parent_messages").select("id", { count: "exact", head: true }).is("read_at", null);
    var n = r.count || 0;
    if (!n) return null;
    return P.card([el("h2", { text: "✉ " + t("ms.home").replace("{n}", n) }), P.link("#/messages", t("ms.open"), "btn btn-pink btn-small")], "blue");
  });
})();
