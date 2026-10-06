// Parent portal: "My child" (#/child). The parent keeps their child's allergies and health notes up to date,
// manages the people who may collect the child (with an ID photo), sees the consents they gave, and edits
// their own name, phone and language. Everything goes through database functions that check the signed-in
// parent owns the child, tell the class staff, and keep a change log. Text is only ever inserted as text.
(function () {
  "use strict";
  var P = window.CKAParent, el = CKA.el, t = CKA.t, client = CKA.client;
  var CONSENTS = ["photos_class", "photos_social", "outings", "emergency_treatment", "birthday_wall"];
  var chosen = null, flash = null;

  function isPhone(s) { return /^[+0-9][0-9 ()+-]{6,19}$/.test(String(s || "").replace(/[٠-٩]/g, function (d) { return d.charCodeAt(0) - 1632; }).trim()); }
  function latin(s) { return String(s || "").replace(/[٠-٩]/g, function (d) { return d.charCodeAt(0) - 1632; }).trim(); }
  function input(type, value, attrs) { var i = el("input", Object.assign({ type: type, id: "f" + Math.random().toString(36).slice(2, 8) }, attrs || {})); i.value = value || ""; return i; }
  function area(value) { var a = el("textarea", { rows: "3", maxlength: "2000", id: "f" + Math.random().toString(36).slice(2, 8) }); a.value = value || ""; return a; }
  function row(label, control) { return P.field(label, control, control.id); }

  async function page() {
    P.loadingView();
    var kids = P.children();
    var nodes = [], me = P.profile();
    if (flash) { nodes.push(P.note("ok", flash)); flash = null; }
    nodes.push(P.card([el("h1", { text: t("pc.title") })]));
    if (!kids.length) { nodes.push(P.card([el("p", { class: "p-sub", text: t("pc.nokids") })])); }
    else {
      if (!chosen || !kids.some(function (k) { return k.id === chosen; })) chosen = kids[0].id;
      if (kids.length > 1) {
        var bar = el("div", { class: "actions" });
        kids.forEach(function (k) {
          var b = el("button", { type: "button", class: "filter-pill" + (k.id === chosen ? " active" : ""), text: k.full_name });
          b.addEventListener("click", function () { chosen = k.id; page(); });
          bar.appendChild(b);
        });
        nodes.push(P.card([el("h2", { text: t("pc.pick") }), bar]));
      }
      var kid = kids.filter(function (k) { return k.id === chosen; })[0];
      var res = await Promise.all([
        client.from("child_health").select("allergies, medical_conditions, medications, doctor_name, doctor_phone").eq("child_id", kid.id).maybeSingle(),
        client.from("child_pickups").select("id, full_name, relationship, phone, id_photo_path").eq("child_id", kid.id).eq("active", true).order("created_at"),
        client.from("child_consents").select("photos_class, photos_social, outings, emergency_treatment, birthday_wall").eq("child_id", kid.id).maybeSingle(),
      ]);
      nodes.push(P.card([el("h2", { text: kid.full_name }), kid.classes ? el("p", { class: "p-sub", text: t("pc.class") + ": " + kid.classes.name }) : null].filter(Boolean), "blue"));
      nodes.push(healthCard(kid, res[0].data || {}));
      nodes.push(pickupsCard(kid, res[1].data || []));
      if (res[2].data) nodes.push(consentsCard(res[2].data));
    }
    nodes.push(meCard(me));
    P.show(nodes);
  }

  // ------------------------------------------------------------------ Health
  function healthCard(kid, h) {
    var al = area(h.allergies), cond = area(h.medical_conditions), med = area(h.medications);
    var doc = input("text", h.doctor_name, { maxlength: "120" }), dphone = input("tel", h.doctor_phone, { inputmode: "tel", dir: "ltr" });
    var msg = el("div", {}), btn = el("button", { type: "button", class: "btn btn-pink", text: t("pc.save") });
    btn.addEventListener("click", async function () {
      msg.textContent = "";
      if (dphone.value.trim() && !isPhone(dphone.value)) { msg.appendChild(P.note("err", t("pc.bad_phone"))); return; }
      btn.disabled = true;
      var r = await client.rpc("parent_update_health", { p_child: kid.id, p_allergies: al.value, p_conditions: cond.value, p_medications: med.value, p_doctor_name: doc.value, p_doctor_phone: latin(dphone.value) });
      btn.disabled = false;
      if (r.error) { msg.appendChild(P.note("err", t("pc.err"))); return; }
      flash = t("pc.saved"); page();
    });
    return P.card([el("h2", { text: t("pc.health") }), el("p", { class: "p-sub", text: t("pc.health_hint") }),
      row(t("pc.allergies"), al), row(t("pc.conditions"), cond), row(t("pc.medications"), med),
      el("div", { class: "f-grid" }, [row(t("pc.doctor"), doc), row(t("pc.doctor_phone"), dphone)]), msg, btn]);
  }

  // ------------------------------------------------------------------ People who may collect the child
  function pickupsCard(kid, list) {
    var body = el("div", {});
    var holder = P.card([el("h2", { text: t("pc.pickups") }), el("p", { class: "p-sub", text: t("pc.pickups_hint") }), body]);
    function draw(editingId) {
      body.textContent = "";
      if (!list.length && editingId !== "new") body.appendChild(el("p", { class: "p-sub", text: t("pc.none_pickups") }));
      list.forEach(function (p) {
        if (editingId === p.id) { body.appendChild(pickupForm(kid, p, function () { draw(null); })); return; }
        var view = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("pc.view_id") });
        view.addEventListener("click", async function () {
          var w = window.open("about:blank", "_blank");
          var r = await client.storage.from("child-files").createSignedUrl(p.id_photo_path, 300);
          if (r.data && w) w.location.href = r.data.signedUrl; else if (w) w.close();
        });
        var edit = el("button", { type: "button", class: "p-link", text: t("pc.edit") }); edit.addEventListener("click", function () { draw(p.id); });
        var rm = el("button", { type: "button", class: "p-link", text: t("pc.remove") });
        rm.addEventListener("click", async function () {
          if (!window.confirm(t("pc.confirm_remove"))) return;
          var r = await client.rpc("parent_save_pickup", { p_child: kid.id, p_pickup: p.id, p_name: p.full_name, p_relationship: p.relationship, p_phone: p.phone, p_id_photo_path: null, p_active: false });
          if (r.error) { body.prepend(P.note("err", t("pc.err"))); return; }
          flash = t("pc.saved"); page();
        });
        body.appendChild(el("div", { class: "kv" }, [el("strong", { text: p.full_name + " · " + p.relationship }), el("span", { dir: "ltr", text: p.phone }),
          p.id_photo_path ? el("small", { text: "✓ " + t("pc.p_photo_have") }) : null, el("div", { class: "actions" }, [p.id_photo_path ? view : null, edit, rm])]));
      });
      if (editingId === "new") body.appendChild(pickupForm(kid, null, function () { draw(null); }));
      else if (list.length < 8) {
        var add = el("button", { type: "button", class: "btn btn-outline", text: "+ " + t("pc.add") });
        add.addEventListener("click", function () { draw("new"); });
        body.appendChild(add);
      } else body.appendChild(el("p", { class: "p-sub", text: t("pc.p_max") }));
    }
    draw(null);
    return holder;
  }

  function pickupForm(kid, p, close) {
    var name = input("text", p && p.full_name, { maxlength: "120" }), rel = input("text", p && p.relationship, { maxlength: "60" }), phone = input("tel", p && p.phone, { inputmode: "tel", dir: "ltr" });
    var photo = el("input", { type: "file", accept: "image/*", id: "f" + Math.random().toString(36).slice(2, 8) });
    var msg = el("div", {}), save = el("button", { type: "submit", class: "btn btn-pink", text: t("pc.save") });
    var cancel = el("button", { type: "button", class: "btn btn-outline", text: t("pc.cancel") }); cancel.addEventListener("click", close);
    var form = el("form", { class: "action", novalidate: "novalidate" }, [row(t("pc.p_name"), name), row(t("pc.p_rel"), rel), row(t("pc.p_phone"), phone),
      row(p && p.id_photo_path ? t("pc.p_photo_new") : t("pc.p_photo"), photo), msg, el("div", { class: "actions" }, [save, cancel])]);
    form.addEventListener("submit", async function (e) {
      e.preventDefault(); msg.textContent = "";
      if (name.value.trim().length < 2 || rel.value.trim().length < 2 || !isPhone(phone.value)) { msg.appendChild(P.note("err", t("pc.p_need"))); return; }
      save.disabled = true;
      var path = null;
      if (photo.files && photo.files[0]) {
        try {
          var blob = await P.prepareImage(photo.files[0]);
          path = kid.id + "/pickups/" + crypto.randomUUID() + ".jpg";
          var up = await client.storage.from("child-files").upload(path, blob, { contentType: "image/jpeg" });
          if (up.error) throw up.error;
        } catch (err) { save.disabled = false; msg.appendChild(P.note("err", t("pc.p_photo_bad"))); return; }
      }
      var r = await client.rpc("parent_save_pickup", { p_child: kid.id, p_pickup: p ? p.id : null, p_name: name.value, p_relationship: rel.value, p_phone: latin(phone.value), p_id_photo_path: path, p_active: true });
      if (r.error) { save.disabled = false; msg.appendChild(P.note("err", t("pc.err"))); return; }
      flash = t("pc.saved"); page();
    });
    return form;
  }

  // ------------------------------------------------------------------ Consents (read only)
  function consentsCard(c) {
    return P.card([el("h2", { text: t("pc.consents") }), el("p", { class: "p-sub", text: t("pc.consents_hint") })].concat(CONSENTS.map(function (k) {
      return el("div", { class: "kv" }, [el("span", { class: "k", text: t("pc.c." + k) }), el("strong", { text: c[k] ? t("pc.yes") : t("pc.no") })]);
    })));
  }

  // ------------------------------------------------------------------ The parent's own details
  function meCard(me) {
    var name = input("text", me.full_name, { maxlength: "120" }), phone = input("tel", me.phone, { inputmode: "tel", dir: "ltr" });
    var lang = el("select", { id: "f" + Math.random().toString(36).slice(2, 8) }, [el("option", { value: "ar", text: t("lang.ar") }), el("option", { value: "en", text: t("lang.en") })]);
    lang.value = me.language === "en" ? "en" : "ar";
    var msg = el("div", {}), btn = el("button", { type: "button", class: "btn btn-pink", text: t("pc.save") });
    btn.addEventListener("click", async function () {
      msg.textContent = "";
      if (name.value.trim().length < 2 || (phone.value.trim() && !isPhone(phone.value))) { msg.appendChild(P.note("err", t("pc.bad_phone"))); return; }
      btn.disabled = true;
      var upd = { full_name: name.value.trim(), phone: latin(phone.value) || null, language: lang.value };
      var r = await client.from("profiles").update(upd).eq("id", me.id);
      btn.disabled = false;
      if (r.error) { msg.appendChild(P.note("err", t("pc.err"))); return; }
      P.setProfile(Object.assign({}, me, upd)); flash = t("pc.me_saved"); page();
    });
    return P.card([el("h2", { text: t("pc.me") }), row(t("pc.me_name"), name), row(t("pc.me_phone"), phone), row(t("pc.me_lang"), lang), msg, btn], "blue");
  }

  P.routes.child = page;
})();
