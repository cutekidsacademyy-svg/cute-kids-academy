// Staff screen: Birthdays (#/birthdays) for the manager, admin and owner. The children by month, who is on the public birthday wall
// (only with the parents' consent), the automatic 8:00 message to both parents (on or off, editable in both languages), and
// "send now". Text from the database is only ever inserted as text.
(function () {
  "use strict";
  var S = window.CKAStaff, el = CKA.el, t = CKA.t, client = CKA.client;
  var monthFilter = null, flash = null;

  function loc() { return CKA.getLang() === "ar" ? "ar-EG" : "en-GB"; }
  function monthName(m) { return new Intl.DateTimeFormat(loc(), { timeZone: "UTC", month: "long" }).format(new Date(Date.UTC(2024, m - 1, 15))); }

  async function page() {
    if (!S.isMgmt()) return S.routes[""]();
    S.loadingView();
    var res = await Promise.all([S.rpc("birthdays_list"), client.from("birthday_settings").select("*").maybeSingle()]);
    var list = res[0] || [], st = res[1].data || {};
    if (monthFilter == null) monthFilter = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", month: "numeric" }).format(new Date()));
    var nodes = [];
    if (flash) { nodes.push(S.note(flash.kind, flash.text)); flash = null; }

    // the automatic message
    var on = el("input", { type: "checkbox" }); on.checked = st.enabled !== false;
    var en = S.textarea(3, ""), ar = S.textarea(3, ""); en.value = st.template_en || ""; ar.value = st.template_ar || ""; ar.dir = "rtl";
    var msg = el("div", {}), save = el("button", { type: "button", class: "btn btn-pink", text: t("bd.save") });
    save.addEventListener("click", async function () {
      msg.textContent = ""; save.disabled = true;
      try { await S.rpc("birthday_settings_save", { p_enabled: on.checked, p_en: en.value, p_ar: ar.value }); msg.appendChild(S.note("ok", t("bd.saved"))); }
      catch (e) { msg.appendChild(S.note("err", S.msgFromError(e))); }
      save.disabled = false;
    });
    nodes.push(S.card([el("h1", { text: t("bd.title") }), el("p", { class: "p-sub", text: t("bd.hint") }),
      el("label", { class: "choice" }, [on, el("span", { text: t("bd.auto") })]), S.field(t("bd.msg_en"), en), S.field(t("bd.msg_ar"), ar), el("p", { class: "p-sub", text: t("bd.placeholder") }), msg, save], "blue"));

    // the list by month
    var bar = el("div", { class: "actions" });
    for (var m = 1; m <= 12; m++) (function (mm) {
      var b = el("button", { type: "button", class: "filter-pill" + (monthFilter === mm ? " active" : ""), text: monthName(mm) });
      b.addEventListener("click", function () { monthFilter = mm; page(); }); bar.appendChild(b);
    })(m);
    var shown = list.filter(function (b) { return b.month === monthFilter; });
    var rows = shown.length ? shown.map(function (b) {
      var send = el("button", { type: "button", class: "btn btn-outline btn-small", text: "✉ " + t("bd.send_now") });
      send.addEventListener("click", async function () {
        if (!window.confirm(t("bd.confirm"))) return;
        send.disabled = true;
        try { await S.rpc("birthday_send_now", { p_child: b.child_id }); flash = { kind: "ok", text: t("bd.sent") }; page(); } catch (e) { send.disabled = false; flash = { kind: "err", text: S.msgFromError(e) }; page(); }
      });
      return el("div", { class: "case-item", style: "cursor:default" }, [el("div", { class: "case-top" }, [el("strong", { text: b.day + " " + monthName(b.month) + " · " + b.child_name }), b.on_wall ? S.pill(t("bd.on_wall"), "st-resolved") : null].filter(Boolean)),
        el("small", { text: (b.class_name ? b.class_name + " · " : "") + t("bd.turning") + " " + b.turning + (b.sent_this_year ? " · ✓ " + t("bd.sent_this_year") : "") }), send]);
    }) : [el("p", { class: "p-sub", text: t("bd.none") })];
    nodes.push(S.card([el("h2", { text: t("bd.by_month") }), bar].concat(rows)));
    nodes.push(S.card([el("h2", { text: t("bd.wall") }), el("p", { class: "p-sub", text: t("bd.wall_hint") }), S.link("/birthdays/", t("bd.wall_open"), "btn btn-outline btn-small")]));
    S.show(nodes);
  }

  S.routes.birthdays = page;
})();
