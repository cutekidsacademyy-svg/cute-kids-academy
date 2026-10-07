// Staff: class photos and videos (#/photos). Teachers upload to their class and tag the children in each file;
// anything tagged with a child whose parents did not agree to class photos is blocked. Admin and owner can mark items
// "OK to post" (only if every child agreed to social media); management can remove items and set how long they are kept.
// Files go to private storage and are only ever opened through links that expire after 5 minutes.
// The database enforces every rule; the screen only guides the teacher. Text is only ever inserted as text.
(function () {
  "use strict";
  var S = window.CKAStaff, el = CKA.el, t = CKA.t, L = window.CKALogic, client = CKA.client;
  var MAX_VIDEO_SECONDS = 60, MAX_BYTES = 52428800;
  var chosenClass = "", chosenDate = null, chosenEvent = "", files = [], flash = null;

  function lang() { return CKA.getLang(); }
  function today() { return L.periodFor("week", Date.now()).to; }
  function pick(en, ar) { var a = lang() === "ar" ? [ar, en] : [en, ar]; return (a[0] && a[0].trim()) ? a[0] : (a[1] || ""); }
  function dayText(s) { return new Intl.DateTimeFormat(lang() === "ar" ? "ar-EG" : "en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(s + "T12:00:00Z")); }

  function shrinkImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var s = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * s)); c.height = Math.max(1, Math.round(img.height * s));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error("read")); }, "image/jpeg", 0.82);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("read")); };
      img.src = url;
    });
  }
  function videoSeconds(file) {
    return new Promise(function (resolve, reject) {
      var v = document.createElement("video"), url = URL.createObjectURL(file);
      v.preload = "metadata";
      v.onloadedmetadata = function () { URL.revokeObjectURL(url); resolve(v.duration); };
      v.onerror = function () { URL.revokeObjectURL(url); reject(new Error("read")); };
      v.src = url;
    });
  }

  async function photos() {
    S.loadingView();
    var res = await Promise.all([client.from("classes").select("id, name").order("name"), client.from("events").select("id, title_en, title_ar, starts_at").order("starts_at", { ascending: false }).limit(30)]);
    var classes = res[0].data || [], events = res[1].data || [];
    if (!chosenDate) chosenDate = today();
    if (!chosenClass || !classes.some(function (c) { return c.id === chosenClass; })) chosenClass = classes.length ? classes[0].id : "";
    var nodes = [];
    if (flash) { nodes.push(S.note(flash.kind, flash.text)); flash = null; }
    nodes.push(S.card([el("h1", { text: t("ph.title") }), el("p", { class: "p-sub", text: t("ph.intro") })], "blue"));
    if (!classes.length) { nodes.push(S.card([el("p", { class: "p-sub", text: t("ph.no_children") })])); return S.show(nodes); }
    var kids = (await client.from("children").select("id, full_name").eq("class_id", chosenClass).eq("active", true).order("full_name")).data || [];
    var blocked = {};
    if (kids.length) { try { (await S.rpc("media_consent_check", { p_children: kids.map(function (k) { return k.id; }) })).forEach(function (b) { blocked[b.child_id] = true; }); } catch (e) {} }
    nodes.push(uploadCard(classes, events, kids, blocked));
    var gal = el("div", {});
    nodes.push(S.card([el("h2", { text: t("ph.gallery") }), gal]));
    if (S.isMgmt()) nodes.push(await retentionCard());
    S.show(nodes);
    drawGallery(gal);
  }

  // ------------------------------------------------------------------ Upload
  function uploadCard(classes, events, kids, blocked) {
    var cls = el("select", {}, classes.map(function (c) { return S.opt(c.id, c.name); })); cls.value = chosenClass;
    cls.addEventListener("change", function () { chosenClass = cls.value; files = []; photos(); });
    var date = el("input", { type: "date", max: today() }); date.value = chosenDate; date.addEventListener("change", function () { chosenDate = date.value || today(); });
    var ev = el("select", {}, [S.opt("", t("ph.no_event"))].concat(events.map(function (e) { return S.opt(e.id, pick(e.title_en, e.title_ar)); }))); ev.value = chosenEvent; ev.addEventListener("change", function () { chosenEvent = ev.value; });
    var input = el("input", { type: "file", accept: "image/*,video/*", multiple: "multiple" });
    var list = el("div", {}), msg = el("div", {});
    var up = el("button", { type: "button", class: "btn btn-pink", text: t("ph.upload") });
    var kidsBox = kids.length ? null : el("p", { class: "note info", text: t("ph.no_children") });

    function chips(setOf, onChange) {
      var box = el("div", { class: "checks" });
      kids.forEach(function (k) {
        var c = el("input", { type: "checkbox", value: k.id }); c.checked = !!setOf[k.id]; c.disabled = !!blocked[k.id];
        c.addEventListener("change", function () { if (c.checked) setOf[k.id] = true; else delete setOf[k.id]; if (onChange) onChange(); });
        box.appendChild(el("label", {}, [c, (blocked[k.id] ? "⚠ " : "") + k.full_name + (blocked[k.id] ? " · " + t("ph.no_consent") : "")]));
      });
      return box;
    }
    var all = {};
    function drawList() {
      list.textContent = "";
      if (!files.length) return;
      var allBox = chips(all, function () { files.forEach(function (f) { f.tags = Object.assign({}, all); }); drawList(); });
      list.appendChild(el("div", { class: "action" }, [el("h3", { text: t("ph.tag_all") }), allBox]));
      files.forEach(function (f) {
        var thumb = f.file.type.indexOf("video") === 0 ? el("div", { class: "dot", text: "🎬" }) : el("img", { src: f.url, alt: "", style: "width:72px;height:72px;object-fit:cover;border-radius:10px" });
        list.appendChild(el("div", { class: "action" }, [el("div", { class: "kid" }, [thumb, el("div", {}, [el("strong", { text: f.file.name }), f.status ? el("div", { class: f.ok ? "att-msg ok" : "att-msg bad", text: f.status }) : null].filter(Boolean))]),
          el("h3", { text: t("ph.tags") }), chips(f.tags)]));
      });
    }
    input.addEventListener("change", function () {
      files = Array.prototype.map.call(input.files || [], function (file) { return { file: file, url: file.type.indexOf("image") === 0 ? URL.createObjectURL(file) : null, tags: Object.assign({}, all), status: "", ok: false }; });
      drawList();
    });
    up.addEventListener("click", async function () {
      msg.textContent = ""; up.disabled = true; up.textContent = t("ph.uploading");
      var saved = 0;
      for (var i = 0; i < files.length; i++) {
        var f = files[i]; if (f.ok) continue;
        var ids = Object.keys(f.tags);
        if (!ids.length) { f.status = t("ph.need_tag"); continue; }
        try { await uploadOne(f, ids); f.ok = true; f.status = t("ph.saved"); saved++; }
        catch (e) { f.status = e.message; }
      }
      up.disabled = false; up.textContent = t("ph.upload"); drawList();
      if (saved && files.every(function (f) { return f.ok; })) { files = []; flash = { kind: "ok", text: t("ph.saved") }; photos(); }
    });
    async function uploadOne(f, ids) {
      var file = f.file, isVideo = file.type.indexOf("video") === 0, blob = file, mime = file.type, seconds = null;
      if (!isVideo && file.type.indexOf("image") !== 0) throw new Error(t("ph.bad_type"));
      if (isVideo) {
        try { seconds = Math.ceil(await videoSeconds(file)); } catch (e) { throw new Error(t("ph.bad_type")); }
        if (!(seconds >= 1) || seconds > MAX_VIDEO_SECONDS) throw new Error(t("ph.too_long"));
        if (file.size > MAX_BYTES) throw new Error(t("ph.too_big"));
        if (!/^video\/(mp4|quicktime|webm)$/.test(mime)) throw new Error(t("ph.bad_type"));
      } else {
        try { blob = await shrinkImage(file); mime = "image/jpeg"; } catch (e) { throw new Error(t("ph.bad_type")); }
      }
      var ext = isVideo ? (mime === "video/quicktime" ? "mov" : mime === "video/webm" ? "webm" : "mp4") : "jpg", id = crypto.randomUUID(), path = chosenClass + "/" + id + "." + ext;
      var u = await client.storage.from("media").upload(path, blob, { contentType: mime }); if (u.error) throw new Error(t("ph.err"));
      var r = await client.rpc("media_add", { p_id: id, p_class: chosenClass, p_event: chosenEvent || null, p_date: chosenDate, p_kind: isVideo ? "video" : "photo", p_path: path, p_name: file.name,
        p_mime: mime, p_size: blob.size, p_duration: seconds, p_children: ids });
      if (r.error) {
        await client.storage.from("media").remove([path]);                       // nothing is left behind when a photo is refused
        var m = String(r.error.message || ""), c = /no_photo_consent: (.*)$/.exec(m);
        throw new Error(c ? t("ph.consent_err") + " " + c[1] : /video_too_long/.test(m) ? t("ph.too_long") : t("ph.err"));
      }
    }
    return S.card([S.field(t("ph.class"), cls), el("div", { class: "f-grid" }, [S.field(t("ph.date"), date), S.field(t("ph.event"), ev)]), kidsBox, el("p", { class: "p-sub", text: t("ph.blocked_hint") }),
      S.field(t("ph.files"), input), list, msg, up].filter(Boolean));
  }

  // ------------------------------------------------------------------ Gallery of the class (with remove and "OK to post")
  async function drawGallery(box) {
    if (!chosenClass) return;
    var r = await client.from("media_items").select("*").eq("class_id", chosenClass).order("album_date", { ascending: false }).limit(60);
    var items = (r.data || []).slice().sort(function (a, b) { return a.album_date < b.album_date ? 1 : a.album_date > b.album_date ? -1 : (a.created_at < b.created_at ? 1 : -1); });
    if (!items.length) { box.appendChild(el("p", { class: "p-sub", text: t("ph.none") })); return; }
    var tags = (await client.from("media_tags").select("media_id, children(full_name)")).data || [], names = {};
    tags.forEach(function (x) { (names[x.media_id] = names[x.media_id] || []).push(x.children ? x.children.full_name : ""); });
    var urls = await client.storage.from("media").createSignedUrls(items.map(function (i) { return i.storage_path; }), 300);
    var byPath = {}; ((urls && urls.data) || []).forEach(function (u) { if (u.signedUrl) byPath[u.path] = u.signedUrl; });
    var grid = el("div", { class: "photos" });
    items.forEach(function (i) {
      var u = byPath[i.storage_path], media = !u ? el("div", { class: "dot", text: "…" }) : i.kind === "video" ? el("video", { src: u, controls: "controls", preload: "metadata", style: "width:160px;border-radius:12px" }) : el("a", { href: u, target: "_blank", rel: "noopener" }, [el("img", { src: u, alt: "" })]);
      var kids = [media, el("small", { text: dayText(i.album_date) + (i.removed ? " · " + t("ph.removed") : i.archived ? " · " + t("ph.archived") : "") }), el("small", { text: (names[i.id] || []).join(", ") })];
      if (i.ok_to_post) kids.push(S.pill("✓ " + t("ph.post_on"), "st-resolved"));
      var acts = el("div", { class: "actions" });
      if (S.isMgmt() && !i.removed) {
        var rm = el("button", { type: "button", class: "p-link", text: t("ph.remove") });
        rm.addEventListener("click", async function () { if (!window.confirm(t("ph.confirm_remove"))) return; try { await S.rpc("media_remove", { p_id: i.id }); photos(); } catch (e) {} });
        acts.appendChild(rm);
      }
      if ((S.me().role === "admin" || S.me().role === "owner") && !i.removed) {
        var pb = el("button", { type: "button", class: "p-link", text: i.ok_to_post ? t("ph.post_clear") : t("ph.post_mark") });
        pb.addEventListener("click", async function () {
          try { await S.rpc("media_mark_post", { p_id: i.id, p_ok: !i.ok_to_post }); photos(); }
          catch (e) { var c = /no_social_consent: (.*)$/.exec(String(e.message)); flash = { kind: "err", text: c ? t("ph.post_err") + " " + c[1] : t("ph.err") }; photos(); }
        });
        acts.appendChild(pb);
      }
      kids.push(acts);
      grid.appendChild(el("div", { style: "display:flex;flex-direction:column;gap:4px;max-width:170px" }, kids));
    });
    box.appendChild(grid);
  }

  // ------------------------------------------------------------------ How long items are kept
  async function retentionCard() {
    var r = await client.from("media_settings").select("*").maybeSingle(), cur = r.data || { retention_months: 12, action: "delete" };
    var months = el("select", {}, [3, 6, 12, 24, 36].map(function (m) { return S.opt(String(m), m + " " + t("ph.months")); }).concat([S.opt("", t("ph.forever"))]));
    months.value = cur.retention_months == null ? "" : String(cur.retention_months);
    var action = el("select", {}, [S.opt("delete", t("ph.a.delete")), S.opt("archive", t("ph.a.archive"))]); action.value = cur.action;
    var msg = el("div", {}), save = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("ph.save") });
    save.addEventListener("click", async function () {
      msg.textContent = "";
      try { await S.rpc("media_settings_save", { p_months: months.value === "" ? null : Number(months.value), p_action: action.value }); msg.appendChild(S.note("ok", t("ph.saved_setting"))); }
      catch (e) { msg.appendChild(S.note("err", t("ph.err"))); }
    });
    return S.card([el("h2", { text: t("ph.retention") }), S.field(t("ph.retention"), months), S.field(t("ph.after"), action), msg, save]);
  }

  S.routes.photos = photos;
})();
