// /staff: staff home. For now: invite parents, add staff, switch accounts on or off.
// (Prompts 6-9 add the case queue, accident log, investigations and reports.)
(function () {
  "use strict";
  var el = CKA.el, L = window.CKALogic, $ = function (id) { return document.getElementById(id); };
  var me = null, session = null, children = [], classes = [], people = [];

  function note(id, kind, text) { var n = $(id); n.className = "note " + kind; n.textContent = text; }
  function clearNote(id) { var n = $(id); n.className = "note hidden"; n.textContent = ""; }

  // Calls one of our server functions with the user's own login token.
  async function api(path, body) {
    var s = await CKA.client.auth.getSession();
    var res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + s.data.session.access_token },
      body: JSON.stringify(body),
    });
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok || !data.ok) throw new Error(data.error || CKA.t("login.error"));
    return data;
  }

  function checkboxes(container, items, name) {
    container.textContent = "";
    items.forEach(function (it) {
      container.appendChild(el("label", {}, [el("input", { type: "checkbox", name: name, value: it.id }), it.label]));
    });
  }
  function checked(container) {
    return Array.prototype.map.call(container.querySelectorAll("input:checked"), function (i) { return i.value; });
  }

  async function loadData() {
    var c = await CKA.client.from("children").select("id, full_name, classes(name)").eq("active", true).order("full_name");
    children = c.data || [];
    var k = await CKA.client.from("classes").select("id, name").order("name");
    classes = k.data || [];
    var p = await CKA.client.from("profiles").select("id, full_name, role, phone, active").order("full_name");
    people = p.data || [];
  }

  function renderForms() {
    var box = $("pChildren");
    if (!children.length) { box.textContent = CKA.t("staff.nochildren"); }
    else checkboxes(box, children.map(function (c) { return { id: c.id, label: c.full_name + (c.classes ? " (" + c.classes.name + ")" : "") }; }), "child");

    if (L.canManageStaff(me.role)) {
      $("staffCard").hidden = false;
      var sel = $("sRole"); sel.textContent = "";
      L.staffRolesCallerCanCreate(me.role).forEach(function (r) { sel.appendChild(el("option", { value: r, text: CKA.t("role." + r) })); });
      checkboxes($("sClasses"), classes.map(function (c) { return { id: c.id, label: c.name }; }), "class");
    }
  }

  function renderPeople() {
    var tbody = $("people-rows"); tbody.textContent = "";
    people.forEach(function (p) {
      var isMe = p.id === me.id;
      var canToggle = !isMe && L.canChangeActive(me.role, p.role);
      var btn = canToggle ? el("button", {
        class: "btn btn-outline btn-small", type: "button",
        text: CKA.t(p.active ? "staff.switchoff" : "staff.switchon"),
        onclick: function () { toggle(p, btn); },
      }) : null;
      tbody.appendChild(el("tr", {}, [
        el("td", {}, [el("strong", { text: p.full_name }), isMe ? " " + CKA.t("staff.you") : ""]),
        el("td", {}, [el("span", { class: "pill", text: CKA.t("role." + p.role) })]),
        el("td", { text: p.phone || "" }),
        el("td", {}, [p.active ? "" : el("span", { class: "pill off", text: CKA.t("staff.off") })]),
        el("td", {}, [btn]),
      ]));
    });
  }

  async function toggle(p, btn) {
    if (!window.confirm(CKA.t(p.active ? "staff.confirmoff" : "staff.confirmon"))) return;
    clearNote("listMsg"); btn.disabled = true;
    try {
      await api("/api/portal-set-active", { user_id: p.id, active: !p.active });
      p.active = !p.active;
      note("listMsg", "ok", CKA.t("staff.changed"));
    } catch (e) { note("listMsg", "err", e.message); }
    renderPeople();
  }

  async function submitInvite(form, msgId, path, payload) {
    clearNote(msgId);
    var btn = form.querySelector("button[type=submit]");
    btn.disabled = true; var label = btn.textContent; btn.textContent = CKA.t("staff.working");
    try {
      await api(path, payload);
      note(msgId, "ok", CKA.t("staff.invited"));
      form.reset();
      form.querySelectorAll(".checks input").forEach(function (i) { i.checked = false; });
      await loadData(); renderPeople();
    } catch (e) { note(msgId, "err", e.message); }
    finally { btn.disabled = false; btn.textContent = label; }
  }

  document.addEventListener("DOMContentLoaded", async function () {
    var res = await CKA.requireArea("staff");        // redirects away if this is not staff
    me = res.profile; session = res.session;
    // Use the account's own language the first time, before anything is drawn.
    if (me.language && !localStorage.getItem("cka_portal_lang")) CKA.setLang(me.language);
    $("hello").textContent = CKA.greeting(me.full_name);
    var badge = function () { $("roleBadge").textContent = CKA.t("role." + me.role); };
    badge();
    $("app").hidden = false;

    if (L.canInviteParents(me.role)) {
      $("people").hidden = false;
      await loadData();
      renderForms(); renderPeople();

      $("parentForm").addEventListener("submit", function (e) {
        e.preventDefault();
        var ids = checked($("pChildren"));
        if (!ids.length) { note("parentMsg", "err", CKA.t("staff.pickchild")); return; }
        submitInvite(e.target, "parentMsg", "/api/portal-invite-parent", {
          email: $("pEmail").value, full_name: $("pName").value, phone: $("pPhone").value, language: $("pLang").value, child_ids: ids,
        });
      });
      $("staffForm").addEventListener("submit", function (e) {
        e.preventDefault();
        submitInvite(e.target, "staffMsg", "/api/portal-invite-staff", {
          email: $("sEmail").value, full_name: $("sName").value, phone: $("sPhone").value, language: $("sLang").value,
          role: $("sRole").value, class_ids: checked($("sClasses")),
        });
      });
    }
    document.addEventListener("cka-lang", function () {
      badge(); $("hello").textContent = CKA.greeting(me.full_name);
      if (!$("people").hidden) { renderForms(); renderPeople(); }
    });
  });
})();
