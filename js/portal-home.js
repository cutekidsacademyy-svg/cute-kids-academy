// /portal: the parent's home page (a first version; Prompt 5 adds cases, forms and ratings).
(function () {
  "use strict";
  var el = CKA.el;
  var profile = null, children = [];

  function render() {
    document.getElementById("hello").textContent = CKA.t("portal.hello") + ", " + profile.full_name;
    var box = document.getElementById("kids");
    box.textContent = "";
    if (!children.length) { box.appendChild(el("p", { class: "p-sub", text: CKA.t("portal.nochildren") })); return; }
    children.forEach(function (c) {
      box.appendChild(el("div", { class: "kid" }, [
        el("div", { class: "dot", text: "🧒" }),
        el("div", {}, [
          el("strong", { text: c.full_name }),
          c.classes ? el("small", { text: CKA.t("portal.class") + ": " + c.classes.name }) : null,
        ]),
      ]));
    });
  }

  document.addEventListener("DOMContentLoaded", async function () {
    var res = await CKA.requireArea("portal");      // redirects away if this is not a parent
    profile = res.profile;
    if (profile.language && !localStorage.getItem("cka_portal_lang")) CKA.setLang(profile.language);
    // Row-level security returns only this parent's own children.
    var q = await CKA.client.from("children").select("id, full_name, classes(name)").order("full_name");
    children = q.data || [];
    document.getElementById("app").hidden = false;
    render();
    document.addEventListener("cka-lang", render);
  });
})();
