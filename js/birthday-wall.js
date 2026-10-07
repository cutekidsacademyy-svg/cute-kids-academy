// The public birthday wall (/birthdays/): this month's birthdays as a first name, one initial and the age — only children whose
// parents agreed. Everything from the server is inserted as text, never as HTML. No login and no secret key on this page.
(function () {
  "use strict";
  var LANG_KEY = "cka_portal_lang";
  var STR = {
    en: { back: "Back to website", privacy: "Privacy notice", title: "Birthdays this month", sub: "Happy birthday to our little stars!", none: "No birthdays to show this month.", today: "Today! 🎂", turning: "turns", err: "The birthdays could not be loaded. Please try again later.", loading: "Loading…", lang: "العربية" },
    ar: { back: "العودة إلى الموقع", privacy: "إشعار الخصوصية", title: "أعياد الميلاد هذا الشهر", sub: "كل عام وأنتم بخير يا نجومنا الصغار!", none: "لا أعياد ميلاد لعرضها هذا الشهر.", today: "اليوم! 🎂", turning: "يبلغ", err: "تعذّر تحميل أعياد الميلاد. يُرجى المحاولة لاحقاً.", loading: "جارٍ التحميل…", lang: "English" },
  };
  function getLang() { try { var v = localStorage.getItem(LANG_KEY); if (v === "ar" || v === "en") return v; } catch (e) {} return (navigator.language || "").slice(0, 2) === "ar" ? "ar" : "en"; }
  function t(k) { return STR[getLang()][k]; }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === "text") n.textContent = attrs[k]; else n.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  var data = null, failed = false;

  function render() {
    var lang = getLang(), app = document.getElementById("app");
    document.documentElement.lang = lang; document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    document.getElementById("homeLink").textContent = t("back"); document.getElementById("privacyLink").textContent = t("privacy"); document.getElementById("langToggle").textContent = t("lang");
    var card = el("div", { class: "p-card blue" }, [el("h1", { text: t("title") }), el("p", { class: "p-sub", text: t("sub") })]);
    if (failed) card.appendChild(el("div", { class: "note err", text: t("err") }));
    else if (!data) card.appendChild(el("p", { text: t("loading") }));
    else if (!data.length) card.appendChild(el("p", { text: t("none") }));
    else data.forEach(function (c) {
      var name = c.first_name + (c.initial ? " " + c.initial + "." : "");
      card.appendChild(el("div", { class: "kv" }, [el("strong", { text: "🎈 " + c.day + " · " + name }), el("small", { text: c.is_today ? t("today") : t("turning") + " " + c.turning })]));
    });
    app.textContent = ""; app.appendChild(card);
  }

  document.getElementById("langToggle").addEventListener("click", function () { try { localStorage.setItem(LANG_KEY, getLang() === "ar" ? "en" : "ar"); } catch (e) {} render(); });
  render();
  fetch("/api/birthday-wall", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
    .then(function (r) { return r.json(); })
    .then(function (j) { if (!j || !j.ok) throw new Error("x"); data = j.children || []; render(); })
    .catch(function () { failed = true; render(); });
})();
