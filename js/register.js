// Public registration form (Prompt 11). Seven steps, English and Arabic, answers kept on this device for 7 days.
// Safety: every piece of text is shown with textContent (never as HTML); files go straight into PRIVATE storage
// through a one-time upload link from our server; nothing secret lives here.
(function () {
  "use strict";
  var KEY = "cka_reg_draft_v1", LANG_KEY = "cka_portal_lang", TTL = 7 * 24 * 3600 * 1000;
  var MAX_BYTES = 5242880, STEPS = 7, MAX_PICKUPS = 6;
  var TYPES = { "image/jpeg": 1, "image/png": 1, "image/webp": 1, "image/heic": 1, "application/pdf": 1 };
  var EXT = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", pdf: "application/pdf" };
  var DOC_KINDS = [["birth_certificate", "doc_birth", 1], ["vaccination_record", "doc_vacc", 2], ["other", "doc_other", 2]];
  var CONSENTS = ["photos_class", "photos_social", "outings", "emergency_treatment", "birthday_wall"];

  var app = document.getElementById("app");
  var cfg = window.CKA_PORTAL || {};
  var started = Date.now();
  var refs = {}, idn = 0, note = null, busy = false, client = null;

  // ---------------------------------------------------------------- language
  function getLang() {
    var s = null; try { s = localStorage.getItem(LANG_KEY); } catch (e) {}
    if (s === "ar" || s === "en") return s;
    return (navigator.language || "").toLowerCase().indexOf("ar") === 0 ? "ar" : "en";
  }
  function t(k) { var l = window.REG_STR[getLang()]; return (l && l[k]) || window.REG_STR.en[k] || k; }
  function applyLang() {
    var l = getLang();
    document.documentElement.lang = l; document.documentElement.dir = l === "ar" ? "rtl" : "ltr";
    document.title = t("title") + " | " + t("brand");
    document.getElementById("langToggle").textContent = l === "ar" ? "English" : "العربية";
    document.getElementById("homeLink").textContent = t("done_home");
    var p = t("privacy"); document.getElementById("privacyLink").textContent = l === "en" ? p.charAt(0).toUpperCase() + p.slice(1) : p;
  }

  // ---------------------------------------------------------------- tiny element builder (text only, never HTML)
  function append(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(el, x); }); return; }
    el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k]; if (v == null || v === false) return;
      if (k === "class") el.className = v;
      else if (k.slice(0, 2) === "on") el[k] = v;
      else if (k === "checked" || k === "disabled") el[k] = !!v;
      else el.setAttribute(k, v === true ? "" : v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function nid() { return "f" + (++idn); }

  // ---------------------------------------------------------------- saved answers
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var x = Array.prototype.map.call(b, function (n) { return ("0" + n.toString(16)).slice(-2); }).join("");
    return x.slice(0, 8) + "-" + x.slice(8, 12) + "-" + x.slice(12, 16) + "-" + x.slice(16, 20) + "-" + x.slice(20);
  }
  function fresh() {
    return { v: 1, saved_at: Date.now(), draft_id: uuid(), step: 0, restored: false, data: {
      child: { name: "", dob: "", programme: "", preferred_start: "", photo: null },
      language: null,
      parents: [{ full_name: "", phone: "", email: "", relationship: "" }],
      health: { allergies: "", medical_conditions: "", medications: "", doctor_name: "", doctor_phone: "" },
      pickups: [],
      consents: { photos_class: null, photos_social: null, outings: null, emergency_treatment: null, birthday_wall: null },
      documents: [], confirm: false } };
  }
  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || "null");
      if (s && s.v === 1 && Date.now() - s.saved_at < TTL && s.data && s.draft_id) { s.restored = s.step > 0 || !!s.data.child.name; return s; }
    } catch (e) {}
    try { localStorage.removeItem(KEY); } catch (e) {}
    return fresh();
  }
  var S = load();
  function save() { S.saved_at = Date.now(); try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
  function wipe() { try { localStorage.removeItem(KEY); } catch (e) {} }

  // ---------------------------------------------------------------- field helpers
  function latin(s) { return String(s || "").replace(/[٠-٩]/g, function (d) { return d.charCodeAt(0) - 1632; }).replace(/[۰-۹]/g, function (d) { return d.charCodeAt(0) - 1776; }); }
  function text(obj, key, ref, attrs, tag) {
    var el = h(tag || "input", Object.assign({ id: nid() }, tag ? {} : { type: "text" }, attrs || {}));
    el.value = obj[key] || "";
    el.oninput = function () { obj[key] = el.value; el.classList.remove("bad"); save(); };
    if (ref) refs[ref] = el;
    return el;
  }
  function select(obj, key, ref, options, withChoose) {
    var el = h("select", { id: nid() });
    if (withChoose) el.appendChild(h("option", { value: "" }, t("choose")));
    options.forEach(function (o) { el.appendChild(h("option", { value: o[0] }, o[1])); });
    el.value = obj[key] || "";
    el.onchange = function () { obj[key] = el.value; el.classList.remove("bad"); save(); };
    if (ref) refs[ref] = el;
    return el;
  }
  function row(label, el, opts) {
    opts = opts || {};
    return h("div", { class: "f-row" }, h("label", { for: el.id }, label, opts.optional ? " (" + t("optional") + ")" : ""), el, opts.hint ? h("small", { class: "p-who" }, opts.hint) : null);
  }
  function setNote(kind, msg) {
    if (!note) return;
    note.className = "note " + kind + (msg ? "" : " hidden"); note.textContent = msg || "";
    if (msg) note.scrollIntoView({ block: "nearest" });
  }

  // ---------------------------------------------------------------- validation (mirrors the database rules)
  function isEmail(s) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) && s.length <= 254; }
  function isPhone(s) { return /^[+0-9][0-9 ()+-]{6,19}$/.test(latin(s).trim()); }
  function parseDate(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(latin(s).trim()); if (!m) return null; var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return d.getUTCMonth() === +m[2] - 1 ? d : null; }
  function today() { var n = new Date(); return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())); }
  function validDob(s) { var d = parseDate(s), n = today(); return !!d && d <= n && d >= new Date(Date.UTC(n.getUTCFullYear() - 20, n.getUTCMonth(), n.getUTCDate())); }
  function validStart(s) { var d = parseDate(s), n = today(); return !!d && d >= new Date(n.getTime() - 30 * 864e5) && d <= new Date(n.getTime() + 800 * 864e5); }
  function len(s, min) { return String(s || "").trim().length >= min; }

  function validate(n) {
    var d = S.data, miss = [];
    function need(ok, ref) { if (!ok) miss.push(ref); }
    if (n === 1) {
      need(len(d.child.name, 2) && d.child.name.length <= 120, "c_name"); need(validDob(d.child.dob), "c_dob"); need(!!d.child.programme, "c_prog");
      need(!d.child.preferred_start || validStart(d.child.preferred_start), "c_start");
    } else if (n === 2) {
      d.parents.forEach(function (p, i) {
        need(len(p.full_name, 2) && p.full_name.length <= 120, "p" + i + "_name"); need(isPhone(p.phone), "p" + i + "_phone");
        need(isEmail(String(p.email || "").trim().toLowerCase()), "p" + i + "_email"); need(!!p.relationship, "p" + i + "_rel");
      });
    } else if (n === 3) {
      need(len(d.health.allergies, 1), "h_allergies");
      need(!d.health.doctor_phone || isPhone(d.health.doctor_phone), "h_dphone");
      ["allergies", "medical_conditions", "medications"].forEach(function (k) { need(String(d.health[k] || "").length <= 2000, "h_" + (k === "allergies" ? "allergies" : k)); });
    } else if (n === 4) {
      d.pickups.forEach(function (p, i) { need(len(p.full_name, 2), "k" + i + "_name"); need(len(p.relationship, 2), "k" + i + "_rel"); need(isPhone(p.phone), "k" + i + "_phone"); });
    } else if (n === 5) {
      CONSENTS.forEach(function (k) { need(typeof d.consents[k] === "boolean", "con_" + k); });
    } else if (n === 7) {
      need(d.confirm === true, "confirm");
    }
    return miss;
  }
  function flagMissing(miss) {
    if (!miss.length) return true;
    miss.forEach(function (m) { if (refs[m]) refs[m].classList.add("bad"); });
    var first = refs[miss[0]]; if (first) { first.scrollIntoView({ block: "center" }); if (first.focus) try { first.focus({ preventScroll: true }); } catch (e) {} }
    setNote("err", miss.indexOf("confirm") >= 0 && miss.length === 1 ? t("need_confirm") : t("required"));
    return false;
  }

  // ---------------------------------------------------------------- talking to our server and to private storage
  function api(path, body) {
    return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || !j.ok) { var e = new Error(j.error || "failed"); e.code = j.code || ""; e.status = r.status; throw e; }
        return j;
      });
    });
  }
  function storage() {
    if (!client) client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    return client;
  }
  function fileType(f) { var ext = (f.name.split(".").pop() || "").toLowerCase(); return TYPES[f.type] ? f.type : (EXT[ext] || ""); }
  // Phone photos are often huge; shrink pictures in the browser (HEIC and PDF are sent as they are).
  function shrink(file, type) {
    if (!/^image\/(jpeg|png|webp)$/.test(type) || !window.createImageBitmap) return Promise.resolve({ blob: file, type: type });
    return createImageBitmap(file).then(function (bmp) {
      var s = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
      var c = document.createElement("canvas"); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      return new Promise(function (ok) { c.toBlob(function (b) { ok(b && b.size < file.size ? { blob: b, type: "image/jpeg" } : { blob: file, type: type }); }, "image/jpeg", 0.85); });
    }).catch(function () { return { blob: file, type: type }; });
  }
  function upload(kind, file) {
    var type = fileType(file);
    if (!type) return Promise.reject(Object.assign(new Error("bad_type"), { code: "bad_type" }));
    return shrink(file, type).then(function (r) {
      if (r.blob.size > MAX_BYTES) throw Object.assign(new Error("too_big"), { code: "too_big" });
      return api("/api/portal-register-upload", { draft_id: S.draft_id, kind: kind, mime_type: r.type, size_bytes: r.blob.size }).then(function (j) {
        return storage().storage.from(j.bucket).uploadToSignedUrl(j.path, j.token, r.blob, { contentType: r.type }).then(function (res) {
          if (res.error) throw new Error("upload_failed");
          return { path: j.path, name: String(file.name || "file").slice(0, 200) };
        });
      });
    });
  }
  function uploadError(e) {
    if (e && e.code === "bad_type") return t("bad_type");
    if (e && e.code === "too_big") return t("too_big");
    if (e && e.code === "rate") return t("rate");
    return t("upload_failed");
  }

  // A file chooser that uploads at once and reports back. `onDone(file|null)` stores the result.
  function fileBox(kind, current, onDone, label) {
    var st = h("span", { class: "p-who", role: "status" }, current ? current.name + " ✓ " + t("uploaded") : "");
    var inp = h("input", { type: "file", accept: "image/*,.heic,.pdf,application/pdf", class: "hidden", id: nid() });
    var add = h("button", { type: "button", class: "btn btn-outline btn-small" }, current ? t("edit") : t("doc_add"));
    add.onclick = function () { inp.click(); };
    inp.onchange = function () {
      var f = inp.files && inp.files[0]; if (!f) return;
      add.disabled = true; st.textContent = t("uploading"); setNote("", "");
      upload(kind, f).then(function (r) { onDone(r); save(); render(); }, function (e) { add.disabled = false; st.textContent = ""; inp.value = ""; setNote("err", uploadError(e)); });
    };
    var rm = current ? h("button", { type: "button", class: "p-link" }, t("doc_remove")) : null;
    if (rm) rm.onclick = function () { onDone(null); save(); render(); };
    return h("div", { class: "f-row" }, label ? h("label", { for: inp.id }, label) : null, h("div", { class: "actions" }, add, rm, st), inp);
  }

  // ---------------------------------------------------------------- steps
  function stepChild() {
    var c = S.data.child, today_ = new Date().toISOString().slice(0, 10);
    return [
      row(t("child_name"), text(c, "name", "c_name", { autocomplete: "off", maxlength: 120 })),
      h("div", { class: "f-grid" },
        row(t("child_dob"), text(c, "dob", "c_dob", { type: "date", max: today_ })),
        row(t("programme"), select(c, "programme", "c_prog", [["nursery", t("prog.nursery")], ["preschool", t("prog.preschool")], ["after_school", t("prog.after_school")], ["camp", t("prog.camp")]], true))),
      row(t("preferred_start"), text(c, "preferred_start", "c_start", { type: "date" }), { optional: true }),
      fileBox("child_photo", c.photo, function (r) { c.photo = r; }, t("child_photo") + " (" + t("optional") + ")"),
    ];
  }
  function stepParents() {
    var d = S.data, out = [];
    d.parents.forEach(function (p, i) {
      out.push(h("h3", null, t("parent_n") + " " + (i + 1)));
      out.push(row(t("full_name"), text(p, "full_name", "p" + i + "_name", { autocomplete: "name", maxlength: 120 })));
      out.push(h("div", { class: "f-grid" },
        row(t("phone"), text(p, "phone", "p" + i + "_phone", { type: "tel", inputmode: "tel", autocomplete: "tel", dir: "ltr" })),
        row(t("email"), text(p, "email", "p" + i + "_email", { type: "email", inputmode: "email", autocomplete: "email", dir: "ltr" }), i === 0 ? { hint: t("email_hint") } : {})));
      out.push(row(t("relationship"), select(p, "relationship", "p" + i + "_rel", [["mother", t("rel.mother")], ["father", t("rel.father")], ["guardian", t("rel.guardian")], ["other", t("rel.other")]], true)));
      if (i === 1) { var rm = h("button", { type: "button", class: "btn btn-outline btn-small" }, t("remove")); rm.onclick = function () { d.parents.pop(); save(); render(); }; out.push(rm); }
    });
    if (d.parents.length < 2) { var add = h("button", { type: "button", class: "btn btn-outline" }, "+ " + t("add_parent")); add.onclick = function () { d.parents.push({ full_name: "", phone: "", email: "", relationship: "" }); save(); render(); }; out.push(add); }
    var lang = { v: d.language || getLang() };
    var sel = select(lang, "v", null, [["en", t("lang.en")], ["ar", t("lang.ar")]], false);
    sel.addEventListener("change", function () { d.language = lang.v; save(); });
    out.push(h("div", { class: "f-row", style: "margin-top:16px" }, h("label", { for: sel.id }, t("email_lang")), sel));
    return out;
  }
  function stepHealth() {
    var hl = S.data.health;
    return [h("p", { class: "p-sub" }, t("health_intro")),
      row(t("allergies"), text(hl, "allergies", "h_allergies", { rows: 3, maxlength: 2000 }, "textarea")),
      row(t("medical_conditions"), text(hl, "medical_conditions", "h_medical_conditions", { rows: 3, maxlength: 2000 }, "textarea"), { optional: true }),
      row(t("medications"), text(hl, "medications", "h_medications", { rows: 2, maxlength: 2000 }, "textarea"), { optional: true }),
      h("div", { class: "f-grid" },
        row(t("doctor_name"), text(hl, "doctor_name", "h_dname", { maxlength: 120 }), { optional: true }),
        row(t("doctor_phone"), text(hl, "doctor_phone", "h_dphone", { type: "tel", inputmode: "tel", dir: "ltr" }), { optional: true }))];
  }
  function stepPickup() {
    var d = S.data, out = [h("p", { class: "p-sub" }, t("pickup_intro"))];
    if (!d.pickups.length) out.push(h("p", { class: "p-who" }, t("pickup_none")));
    d.pickups.forEach(function (p, i) {
      var rm = h("button", { type: "button", class: "p-link" }, t("remove")); rm.onclick = function () { d.pickups.splice(i, 1); save(); render(); };
      out.push(h("div", { class: "action" },
        h("div", { class: "sec-head" }, h("h3", null, t("pickup_n") + " " + (i + 1)), rm),
        row(t("full_name"), text(p, "full_name", "k" + i + "_name", { maxlength: 120 })),
        h("div", { class: "f-grid" },
          row(t("relationship"), text(p, "relationship", "k" + i + "_rel", { maxlength: 60 })),
          row(t("phone"), text(p, "phone", "k" + i + "_phone", { type: "tel", inputmode: "tel", dir: "ltr" }))),
        fileBox("pickup_id", p.id, function (r) { p.id = r; }, t("pickup_id") + " (" + t("optional") + ")")));
    });
    if (d.pickups.length < MAX_PICKUPS) { var add = h("button", { type: "button", class: "btn btn-outline" }, "+ " + t("pickup_add")); add.onclick = function () { d.pickups.push({ full_name: "", relationship: "", phone: "", id: null }); save(); render(); }; out.push(add); }
    return out;
  }
  function stepConsents() {
    var c = S.data.consents, out = [h("p", { class: "p-sub" }, t("consent_intro"))];
    CONSENTS.forEach(function (k) {
      var name = "con_" + k;
      function opt(val, label) {
        var r = h("input", { type: "radio", name: name, checked: c[k] === val });
        r.onchange = function () { c[k] = val; refs[name].classList.remove("bad"); save(); };
        return h("label", { class: "choice" }, r, h("span", null, label));
      }
      var box = h("div", { class: "yn" }, opt(true, t("yes")), opt(false, t("no")));
      refs[name] = h("fieldset", { class: "action consent" }, h("legend", { class: "check-label" }, t("c." + k)), box);
      out.push(refs[name]);
    });
    return out;
  }
  function stepDocs() {
    var d = S.data, out = [h("p", { class: "p-sub" }, t("docs_intro"))];
    DOC_KINDS.forEach(function (k) {
      var mine = d.documents.filter(function (x) { return x.kind === k[0]; });
      out.push(h("h3", null, t(k[1])));
      mine.forEach(function (doc) {
        out.push(fileBox(k[0], { name: doc.file_name }, function (r) { d.documents = d.documents.filter(function (x) { return x !== doc; }); if (r) d.documents.push({ kind: k[0], path: r.path, file_name: r.name }); }));
      });
      if (mine.length < k[2]) out.push(fileBox(k[0], null, function (r) { if (r) d.documents.push({ kind: k[0], path: r.path, file_name: r.name }); }));
    });
    return out;
  }
  function kv(k, v) { return h("div", { class: "kv" }, h("span", { class: "k" }, k), h("span", { class: "preline" }, v || t("review_none"))); }
  function section(title, stepNo, rows) {
    var ed = h("button", { type: "button", class: "p-link" }, t("edit")); ed.onclick = function () { go(stepNo); };
    return h("div", { class: "action" }, h("div", { class: "sec-head" }, h("h3", null, title), ed), rows);
  }
  function stepReview() {
    var d = S.data, c = d.child, out = [h("p", { class: "p-sub" }, t("review_intro"))];
    out.push(section(t("s.1"), 1, [kv(t("child_name"), c.name), kv(t("child_dob"), c.dob), kv(t("programme"), c.programme && t("prog." + c.programme)), kv(t("preferred_start"), c.preferred_start), kv(t("child_photo"), c.photo && c.photo.name)]));
    out.push(section(t("s.2"), 2, d.parents.map(function (p, i) { return kv(t("parent_n") + " " + (i + 1), [p.full_name, latin(p.phone), p.email, t("rel." + p.relationship)].filter(Boolean).join("\n")); })));
    out.push(section(t("s.3"), 3, [kv(t("allergies"), d.health.allergies), kv(t("medical_conditions"), d.health.medical_conditions), kv(t("medications"), d.health.medications), kv(t("doctor_name"), [d.health.doctor_name, latin(d.health.doctor_phone)].filter(Boolean).join(" · "))]));
    out.push(section(t("s.4"), 4, d.pickups.length ? d.pickups.map(function (p, i) { return kv(t("pickup_n") + " " + (i + 1), [p.full_name, p.relationship, latin(p.phone), p.id ? "✓ ID" : ""].filter(Boolean).join(" · ")); }) : [kv(t("s.4"), "")]));
    out.push(section(t("s.5"), 5, CONSENTS.map(function (k) { return kv(t("c." + k), d.consents[k] ? t("yes") : t("no")); })));
    out.push(section(t("s.6"), 6, d.documents.length ? d.documents.map(function (x) { return kv(t(DOC_KINDS.filter(function (k) { return k[0] === x.kind; })[0][1]), x.file_name); }) : [kv(t("s.6"), "")]));
    var cb = h("input", { type: "checkbox", id: nid(), checked: d.confirm });
    cb.onchange = function () { d.confirm = cb.checked; cb.parentNode.classList.remove("bad"); save(); };
    var priv = h("a", { href: "/privacy/", target: "_blank", rel: "noopener" }, t("privacy"));
    refs.confirm = h("label", { class: "choice" }, cb, h("span", null, t("confirm") + " ", priv, "."));
    out.push(refs.confirm);
    // a field no person can see: only a robot fills it in
    out.push(h("div", { class: "hp", "aria-hidden": "true" }, h("label", { for: "hpsite" }, t("trap_label")), h("input", { type: "text", id: "hpsite", name: "hp_site", tabindex: "-1", autocomplete: "off" })));
    return out;
  }

  var BUILD = [null, stepChild, stepParents, stepHealth, stepPickup, stepConsents, stepDocs, stepReview];

  // ---------------------------------------------------------------- navigation
  function go(n) { S.step = n; save(); render(); window.scrollTo(0, 0); }
  function next() { var m = validate(S.step); if (flagMissing(m)) go(S.step + 1); }

  function submit(btn) {
    var m = validate(7); if (!flagMissing(m)) return;
    for (var n = 1; n <= 5; n++) { var mm = validate(n); if (mm.length) { setNote("err", t("required")); go(n); setTimeout(function () { flagMissing(mm); }, 0); return; } }
    var d = S.data;
    var payload = {
      draft_id: S.draft_id, language: d.language || getLang(),
      child: { name: d.child.name.trim(), dob: latin(d.child.dob).trim(), programme: d.child.programme, preferred_start: latin(d.child.preferred_start || "").trim(), photo_path: d.child.photo ? d.child.photo.path : "" },
      parents: d.parents.map(function (p) { return { full_name: p.full_name.trim(), phone: latin(p.phone).trim(), email: p.email.trim().toLowerCase(), relationship: p.relationship }; }),
      health: { allergies: d.health.allergies.trim(), medical_conditions: d.health.medical_conditions.trim(), medications: d.health.medications.trim(), doctor_name: d.health.doctor_name.trim(), doctor_phone: latin(d.health.doctor_phone).trim() },
      pickups: d.pickups.map(function (p) { return { full_name: p.full_name.trim(), relationship: p.relationship.trim(), phone: latin(p.phone).trim(), id_photo_path: p.id ? p.id.path : "" }; }),
      consents: d.consents,
      documents: d.documents.map(function (x) { return { kind: x.kind, path: x.path, file_name: x.file_name }; }),
    };
    var trap = document.getElementById("hpsite");
    busy = true; btn.disabled = true; btn.textContent = t("sending"); setNote("", "");
    api("/api/portal-register", { started_at: started, website: trap ? trap.value : "", application: payload }).then(function (j) {
      wipe(); S = fresh(); busy = false; done(j.application_no, payload.parents[0].email);
    }, function (e) {
      busy = false; btn.disabled = false; btn.textContent = t("submit");
      var c = e && e.code, msg = t("err_generic");
      if (c === "duplicate_application") msg = t("err_dup");
      else if (c === "rate") msg = t("err_rate");
      else if (c === "missing_file" || c === "invalid_file") msg = t("err_missing");
      else if (c === "too_fast") msg = t("err_fast");
      else if (e && e.status >= 400 && e.status < 500 && getLang() === "en" && e.message) msg = e.message;
      setNote("err", msg);
    });
  }

  // ---------------------------------------------------------------- drawing
  function clearBtn() {
    var b = h("button", { type: "button", class: "p-link" }, t("clear"));
    b.onclick = function () { if (window.confirm(t("clear") + "?")) { wipe(); S = fresh(); render(); setNote("ok", t("cleared")); } };
    return b;
  }
  function done(no, email) {
    refs = {}; app.textContent = "";
    app.appendChild(h("div", { class: "p-card blue", role: "status" },
      h("h1", null, t("done_title")),
      h("p", { class: "promise-big" }, t("done_no") + " ", h("span", { class: "ref-big" }, no && no > 0 ? "#" + no : "")),
      h("p", null, t("done_email") + " ", h("strong", { dir: "ltr" }, email), "."),
      h("p", { class: "p-sub", style: "margin-top:10px" }, t("done_next")),
      h("div", { class: "call-box" }, h("p", null, t("done_call"))),
      h("a", { class: "btn btn-pink", href: "/" }, t("done_home")),
      h("p", { style: "margin-top:14px" }, clearBtn())));
    window.scrollTo(0, 0);
  }
  function render() {
    if (busy) return;
    refs = {}; app.textContent = "";
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase) { app.appendChild(h("div", { class: "p-card" }, h("p", null, t("off")))); return; }
    var n = S.step;
    note = h("div", { class: "note hidden", role: "alert" });
    var card = h("div", { class: "p-card" }, note);
    if (n === 0) {
      card.appendChild(h("h1", null, t("title")));
      card.appendChild(h("p", { class: "p-sub" }, t("intro")));
      if (S.restored) card.appendChild(h("div", { class: "note info" }, t("saved")));
      var go1 = h("button", { type: "button", class: "btn btn-pink btn-block" }, t("next")); go1.onclick = function () { go(1); };
      card.appendChild(go1);
      card.appendChild(h("p", { class: "p-sub", style: "margin-top:12px;font-size:.9rem" }, t("shared")));
      card.appendChild(h("p", null, clearBtn()));
      app.appendChild(card); return;
    }
    var bar = h("span"); bar.style.width = Math.round(n / STEPS * 100) + "%";
    card.appendChild(h("div", { class: "progress", role: "progressbar", "aria-valuemin": "1", "aria-valuemax": String(STEPS), "aria-valuenow": String(n) }, bar, h("small", null, t("step") + " " + n + " " + t("of") + " " + STEPS)));
    card.appendChild(h("h2", null, t("s." + n)));
    append(card, BUILD[n]());
    var back = h("button", { type: "button", class: "btn btn-outline" }, t("back")); back.onclick = function () { go(n - 1); };
    var fwd = h("button", { type: "button", class: "btn btn-pink" }, n === STEPS ? t("submit") : t("next"));
    fwd.onclick = function () { n === STEPS ? submit(fwd) : next(); };
    card.appendChild(h("div", { class: "actions" }, back, fwd));
    card.appendChild(h("p", { class: "p-who", style: "margin-top:14px" }, t("saved") + " ", clearBtn()));
    app.appendChild(card);
  }

  document.getElementById("langToggle").onclick = function () {
    try { localStorage.setItem(LANG_KEY, getLang() === "ar" ? "en" : "ar"); } catch (e) {}
    if (!S.data.language) { /* the emails follow the language in use when the form is sent */ }
    applyLang(); render();
  };
  applyLang();
  render();
})();
