// Parent portal: News (#/news) and Settings (#/settings: what to be told about, push on this device).
// A parent only receives announcements meant for them (the database enforces it). Text is only ever inserted as text.
(function () {
  "use strict";
  var P = window.CKAParent, el = CKA.el, t = CKA.t, client = CKA.client;

  function lang() { return CKA.getLang(); }
  function pick(en, ar) { var a = lang() === "ar" ? [ar, en] : [en, ar]; return (a[0] && a[0].trim()) ? a[0] : (a[1] || ""); }
  function when(iso) { return new Intl.DateTimeFormat(lang() === "ar" ? "ar-EG" : "en-GB", { timeZone: "Africa/Cairo", dateStyle: "medium" }).format(new Date(iso)); }
  var reads = {};

  async function news(parts) {
    P.loadingView();
    var res = await Promise.all([client.from("announcements").select("*").order("created_at", { ascending: false }).limit(60), client.from("announcement_reads").select("announcement_id")]);
    var list = (res[0].data || []).slice().sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });
    reads = {}; (res[1].data || []).forEach(function (r) { reads[r.announcement_id] = true; });
    if (parts && parts[1]) {
      var a = list.filter(function (x) { return x.id === parts[1]; })[0];
      if (a) return detail(a);
    }
    var nodes = [P.card([el("h1", { text: t("pn.title") })])];
    if (!list.length) nodes.push(P.card([el("p", { class: "p-sub", text: t("pn.none") })]));
    list.forEach(function (a) {
      var unread = !reads[a.id];
      nodes.push(el("a", { class: "case-item", href: "#/news/" + a.id }, [
        el("div", { class: "case-top" }, [unread ? P.pill(t("pn.new"), "urg-urgent") : null, a.important ? P.pill("★ " + t("pn.important"), "urg-critical") : null, a.kind === "weekly_update" ? P.pill(t("pn.weekly")) : null].filter(Boolean)),
        el("div", { class: "case-title", text: pick(a.title_en, a.title_ar) }), el("small", { text: when(a.created_at) })]));
    });
    P.show(nodes);
  }

  async function detail(a) {
    var nodes = [P.link("#/news", t("pn.back"))];
    var kids = [el("div", { class: "case-top" }, [a.important ? P.pill("★ " + t("pn.important"), "urg-critical") : null, a.kind === "weekly_update" ? P.pill(t("pn.weekly")) : null].filter(Boolean)),
      el("h1", { text: pick(a.title_en, a.title_ar) }), el("small", { class: "p-who", text: when(a.created_at) }), el("p", { class: "preline", text: pick(a.body_en, a.body_ar) })];
    if (a.attachment_path) {
      var box = el("div", {});
      kids.push(el("h3", { text: t("pn.attachment") }), box);
      var s = await client.storage.from("announcements").createSignedUrl(a.attachment_path, 300);
      if (s.data) {
        if (/\.pdf$/i.test(a.attachment_path)) box.appendChild(el("a", { class: "btn btn-outline", href: s.data.signedUrl, target: "_blank", rel: "noopener", text: "📄 " + (a.attachment_name || t("pn.open")) }));
        else box.appendChild(el("a", { href: s.data.signedUrl, target: "_blank", rel: "noopener" }, [el("img", { src: s.data.signedUrl, alt: a.attachment_name || "", style: "max-width:100%;border-radius:12px" })]));
      }
    }
    nodes.push(P.card(kids));
    P.show(nodes);
    if (!reads[a.id]) client.rpc("announcement_mark_read", { p_id: a.id });
  }

  // ------------------------------------------------------------------ Settings
  async function settings() {
    P.loadingView();
    var r = await client.from("notification_prefs").select("*").maybeSingle();
    var p = r.data || { reports: true, announcements: true, events: true, cases: true };
    var boxes = {}, rows = [];
    ["reports", "announcements", "events", "cases"].forEach(function (k) {
      var c = el("input", { type: "checkbox" }); c.checked = p[k] !== false; boxes[k] = c;
      rows.push(el("label", { class: "choice" }, [c, el("span", { text: t("ps." + k) })]));
    });
    var msg = el("div", {}), save = el("button", { type: "button", class: "btn btn-pink", text: t("ps.save") });
    save.addEventListener("click", async function () {
      msg.textContent = ""; save.disabled = true;
      var res = await client.rpc("notification_prefs_save", { p_reports: boxes.reports.checked, p_announcements: boxes.announcements.checked, p_events: boxes.events.checked, p_cases: boxes.cases.checked });
      save.disabled = false;
      msg.appendChild(res.error ? P.note("err", t("ps.err")) : P.note("ok", t("ps.saved")));
    });
    var nodes = [P.card([el("h1", { text: t("ps.title") })]), P.card([el("h2", { text: t("ps.notify") }), el("p", { class: "p-sub", text: t("ps.notify_hint") })].concat(rows, [msg, save]))];

    var pushBox = el("div", {});
    nodes.push(P.card([el("h2", { text: t("ps.push") }), el("p", { class: "p-sub", text: t("ps.push_hint") }), pushBox], "blue"));
    nodes.push(P.card([el("h2", { text: t("ps.install") }), el("p", { class: "p-sub", text: t("ps.install_hint") })]));
    P.show(nodes);
    drawPush(pushBox);
  }

  async function drawPush(box) {
    box.textContent = "";
    var K = window.CKAPush;
    if (!K || !K.available()) { box.appendChild(el("p", { class: "p-sub", text: t("ps.push_unavailable") })); return; }
    if (K.denied()) { box.appendChild(el("p", { class: "p-sub", text: t("ps.push_denied") })); return; }
    var on = await K.isOn();
    var b = el("button", { type: "button", class: on ? "btn btn-outline" : "btn btn-pink", text: on ? t("ps.push_off") : t("ps.push_on") });
    b.addEventListener("click", async function () {
      b.disabled = true;
      try { if (on) await K.disable(client); else await K.enable(client); } catch (e) {}
      drawPush(box);
    });
    if (on) box.appendChild(P.note("ok", t("ps.push_enabled")));
    box.appendChild(b);
  }

  P.routes.news = news;
  P.routes.settings = settings;
})();
