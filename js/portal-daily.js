// Parent portal: the daily report (#/daily) and the "Kindly send for tomorrow" card on the home screen.
// Parents only ever receive SENT reports about their own children (the database enforces it).
// Text is only ever inserted as text.
(function () {
  "use strict";
  var P = window.CKAParent, el = CKA.el, t = CKA.t, L = window.CKALogic, client = CKA.client;
  var chosen = null, day = null;
  var ITEMS = ["diapers", "wipes", "shower_gel", "cotton", "extra_clothes", "other"];

  function loc() { return CKA.getLang() === "ar" ? "ar-EG" : "en-GB"; }
  function dayText(ymd) { return new Intl.DateTimeFormat(loc(), { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(ymd + "T12:00:00Z")); }
  function hhmm(iso) { return new Intl.DateTimeFormat(loc(), { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)); }
  function today() { return L.periodFor("week", Date.now()).to; }
  function sleepText(m) { return Math.floor(m / 60) + t("pd.h") + " " + (m % 60) + t("pd.min"); }
  function itemsText(r) { return r.items.map(function (k) { return k === "other" && r.other_text ? r.other_text : t("pd.i." + k); }).join(" · "); }

  // The Report tab also holds the accident reports (what happened, first aid, when the family was called) with the "I've read this" button.
  async function accidentCard() {
    var r = await client.rpc("parent_incidents"), list = r.data || [], unread = list.filter(function (i) { return !i.parent_signed_at; }).length;
    var kids = [el("h2", { text: "⚠ " + t("pd.acc_title") })];
    kids.push(el("p", { class: unread ? "att-msg bad" : "p-sub", text: list.length ? (unread ? unread + " " + t("pd.acc_unread") : t("pd.acc_all_read")) : t("pd.acc_none") }));
    if (list.length) kids.push(P.link("#/reports", t("pd.acc_open"), "btn btn-outline btn-small"));
    return P.card(kids);
  }
  async function page() {
    P.loadingView();
    var kids = P.children(), nodes = [P.card([el("h1", { text: t("pd.title") })])];
    if (!kids.length) return P.show(nodes);
    if (!chosen || !kids.some(function (k) { return k.id === chosen; })) { chosen = kids[0].id; day = null; }
    if (kids.length > 1) {
      var bar = el("div", { class: "actions" });
      kids.forEach(function (k) {
        var b = el("button", { type: "button", class: "filter-pill" + (k.id === chosen ? " active" : ""), text: k.full_name });
        b.addEventListener("click", function () { chosen = k.id; day = null; page(); });
        bar.appendChild(b);
      });
      nodes.push(P.card([el("h2", { text: t("pd.pick") }), bar]));
    }
    var kid = kids.filter(function (k) { return k.id === chosen; })[0];
    var res = await client.from("daily_reports").select("*").eq("child_id", kid.id).order("report_date", { ascending: false }).limit(30);
    var reports = (res.data || []).slice().sort(function (a, b) { return a.report_date < b.report_date ? 1 : -1; });
    if (!reports.length) { nodes.push(P.card([el("p", { class: "p-sub", text: t("pd.none") })])); nodes.push(await accidentCard().catch(function () { return null; })); return P.show(nodes); }
    var r = reports.filter(function (x) { return x.report_date === day; })[0] || reports[0];
    day = r.report_date;

    var sr = await client.from("send_requests").select("for_date, items, other_text").eq("child_id", kid.id).gte("for_date", r.report_date).order("for_date");
    var next = (sr.data || []).filter(function (x) { return x.for_date > r.report_date; })[0];
    nodes.push(reportCard(kid, r, next));
    if (reports.length > 1) {
      var past = el("div", { class: "actions" });
      reports.forEach(function (x) {
        var b = el("button", { type: "button", class: "filter-pill" + (x.report_date === day ? " active" : ""), text: dayText(x.report_date) });
        b.addEventListener("click", function () { day = x.report_date; page(); });
        past.appendChild(b);
      });
      nodes.push(P.card([el("h2", { text: t("pd.past") }), past]));
    }
    nodes.push(await accidentCard().catch(function () { return null; }));
    P.show(nodes);
  }

  function line(icon, label, value, cls) {
    return el("div", { class: "kv" }, [el("span", { class: "k", text: icon + " " + label }), el("strong", { class: cls || "", text: value })]);
  }

  function reportCard(kid, r, next) {
    var rows = [];
    if (r.lunch) rows.push(line("🍽", t("pd.lunch"), t("pd.lunch." + r.lunch)));
    if (r.mood) rows.push(line("🙂", t("pd.mood"), t("pd.mood." + r.mood)));
    if (r.water_cups != null) rows.push(line("💧", t("pd.water"), r.water_cups + " " + t("pd.cups")));
    if (r.milk_ml != null) rows.push(line("🥛", t("pd.milk"), r.milk_ml + " ml"));
    if (r.sleep_minutes != null) rows.push(line("😴", t("pd.sleep"), sleepText(r.sleep_minutes)));
    if (r.diaper_changes != null) rows.push(line("🧷", t("pd.diapers"), String(r.diaper_changes)));
    if (r.stool_count != null) rows.push(line("🚼", t("pd.stool"), String(r.stool_count)));
    if (r.temperature != null) rows.push(line("🌡", t("pd.temp"), r.temperature + " °C", Number(r.temperature) >= 38 ? "att-msg bad" : ""));
    var kids = [el("h2", { text: kid.full_name + " · " + dayText(r.report_date) })].concat(rows);
    if (r.temperature != null && Number(r.temperature) >= 38) kids.push(P.note("err", t("pd.fever")));
    if (r.personal_note) kids.push(el("div", { class: "internal-box", style: "background:var(--pink-light);border-color:var(--pink)" }, [el("strong", { text: t("pd.note") }), el("p", { class: "preline", text: r.personal_note })]));
    if (next) kids.push(el("div", { class: "call-box" }, [el("p", { text: "🎒 " + t("pd.send_for") + " (" + dayText(next.for_date) + ")" }), el("p", { text: itemsText(next) })]));
    if (r.sent_at) kids.push(el("small", { class: "p-who", text: t("pd.sent_at") + " " + hhmm(r.sent_at) }));
    return P.card(kids, "blue");
  }

  // Home screen: what each child should bring tomorrow
  P.homeCards.push(async function () {
    var kids = P.children();
    if (!kids.length) return null;
    var res = await client.from("send_requests").select("child_id, for_date, items, other_text").gte("for_date", today()).order("for_date");
    var rows = res.data || [];
    if (!rows.length) return null;
    var names = {}; kids.forEach(function (k) { names[k.id] = k.full_name; });
    return P.card([el("h2", { text: "🎒 " + t("pd.home_title") })].concat(rows.map(function (r) {
      return el("div", { class: "kv" }, [el("strong", { text: (names[r.child_id] || "") + " · " + t("pd.home_for") + " " + dayText(r.for_date) }), el("span", { text: itemsText(r) })]);
    })), "blue");
  });

  P.routes.daily = page;
})();
