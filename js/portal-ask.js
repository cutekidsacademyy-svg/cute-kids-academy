// Parent portal: "Ask a question" (#/ask) and "Report a missing item" (#/ask/missing). Each becomes a portal case: "can wait"
// unless the parent ticks "urgent". The academy's inbox and the admins are emailed; replies come back in the portal and by
// email. An "Ask on WhatsApp" button opens a chat with the academy's WhatsApp number with the parent's name, the child and the
// case reference already typed in (so admin can match it to the case). Text is only ever inserted as text.
(function () {
  "use strict";
  var P = window.CKAParent, el = CKA.el, t = CKA.t, L = window.CKALogic, client = CKA.client;
  var TOPICS = ["fees", "schedule", "food", "my_childs_day", "other"];

  function lang() { return CKA.getLang(); }
  function waUrl(number, text) { return "https://wa.me/" + number + "?text=" + encodeURIComponent(text); }
  function fill(s, o) { return s.replace(/\{(\w+)\}/g, function (m, k) { return o[k] != null ? o[k] : m; }); }
  async function whatsapp() { var r = await client.from("academy_settings").select("whatsapp").maybeSingle(); return r.data && r.data.whatsapp ? r.data.whatsapp : null; }

  async function page(parts) {
    var missing = parts && parts[1] === "missing";
    P.loadingView();
    var kids = P.children(), wa = await whatsapp();
    var draft = { child: kids.length === 1 ? kids[0].id : "", topic: "fees" };
    var child = el("select", { id: "qChild" }, [el("option", { value: "", text: "—" })].concat(kids.map(function (k) { return el("option", { value: k.id, text: k.full_name }); }))); child.value = draft.child;
    var topic = el("select", { id: "qTopic" }, TOPICS.map(function (k) { return el("option", { value: k, text: t("pq.t." + k) }); }));
    var text = el("textarea", { rows: "5", maxlength: "4000", id: "qText" });
    var item = el("input", { type: "text", maxlength: "150", id: "qItem" }), seen = el("input", { type: "text", maxlength: "200", id: "qSeen" });
    var photo = el("input", { type: "file", accept: "image/*", id: "qPhoto" });
    var urgent = el("input", { type: "checkbox", id: "qUrgent" });
    var err = el("div", { class: "note err hidden", role: "alert" }), send = el("button", { type: "submit", class: "btn btn-pink btn-block", text: t("pq.send") });
    function fail(key) { err.textContent = t(key); err.classList.remove("hidden"); err.scrollIntoView({ block: "center" }); }
    var form = el("form", { novalidate: "novalidate" }, [P.field(t("pq.child"), child, "qChild"), missing ? null : P.field(t("pq.topic"), topic, "qTopic"),
      missing ? P.field(t("pq.item"), item, "qItem") : null, missing ? P.field(t("pq.last_seen"), seen, "qSeen") : null,
      P.field(missing ? t("pq.desc") : t("pq.question"), text, "qText"), missing ? P.field(t("pq.photo"), photo, "qPhoto") : null,
      el("label", { class: "choice" }, [urgent, el("span", {}, [el("strong", { text: t("pq.urgent") }), el("small", { text: t("pq.urgent_hint") })])]), err, send].filter(Boolean));
    form.addEventListener("submit", async function (e) {
      e.preventDefault(); err.classList.add("hidden");
      if (!child.value) return fail("pq.need_child");
      if (missing && !item.value.trim()) return fail("pq.need_item");
      if (!text.value.trim() && !(missing && seen.value.trim())) return fail("pq.need_text");
      send.disabled = true; send.textContent = t("pq.sending");
      try {
        var blob = null;
        if (missing && photo.files && photo.files[0]) { try { blob = await P.prepareImage(photo.files[0]); } catch (x) { send.disabled = false; send.textContent = t("pq.send"); return fail("pq.photo_bad"); } }
        var id = crypto.randomUUID(), topicLabel = ({ fees: "Fees", schedule: "Schedule", food: "Food", my_childs_day: "My child's day", other: "Other" })[topic.value];
        var body = missing ? [seen.value.trim() ? "Last seen: " + seen.value.trim() : "", text.value.trim()].filter(Boolean).join("\n") : text.value.trim();
        var ins = await client.from("submissions").insert({ id: id, parent_id: P.profile().id, child_id: child.value, type: missing ? "missing_item" : "question", topic: missing ? null : topic.value,
          title: missing ? "Missing: " + item.value.trim().slice(0, 120) : topicLabel + ": " + text.value.trim().replace(/\s+/g, " ").slice(0, 70), description: body || item.value.trim(), urgency: urgent.checked ? "urgent" : "can_wait" });
        if (ins.error) throw ins.error;
        if (blob) {
          var path = id + "/" + crypto.randomUUID() + ".jpg", up = await client.storage.from("attachments").upload(path, blob, { contentType: "image/jpeg" });
          if (!up.error) await client.from("attachments").insert({ submission_id: id, uploaded_by: P.profile().id, storage_path: path, file_name: "photo.jpg", mime_type: "image/jpeg", size_bytes: blob.size });
        }
        await done(id, child.options[child.selectedIndex].text, wa, missing);
      } catch (x) { send.disabled = false; send.textContent = t("pq.send"); fail("pq.err"); }
    });
    P.show([P.card([el("h1", { text: missing ? t("pq.title_missing") : t("pq.title") }), form]), wa ? waCard(wa, "", child, false) : null].filter(Boolean));
  }

  function waCard(number, ref, childSel, ready) {
    var a = el("a", { class: "btn btn-outline btn-block", target: "_blank", rel: "noopener", text: "💬 " + t("pq.whatsapp") });
    function sync() {
      var name = childSel.options ? childSel.options[childSel.selectedIndex].text : childSel;
      var text = ref ? fill(t("pq.wa_text"), { parent: P.profile().full_name, child: name === "—" ? "" : name, ref: ref }) : fill(t("pq.wa_text_plain"), { parent: P.profile().full_name, child: name === "—" ? "" : name });
      a.href = waUrl(number, text);
    }
    if (childSel && childSel.addEventListener) childSel.addEventListener("change", sync); sync();
    return P.card([el("p", { class: "p-sub", text: t("pq.wa_hint") }), a], "blue");
  }

  async function done(id, childName, wa, missing) {
    var r = await client.rpc("parent_cases"), c = (r.data || []).filter(function (x) { return x.id === id; })[0] || {};
    var ref = c.ref_no ? L.refLabel(c.ref_no) : "";
    var nodes = [P.card([el("h1", { text: t("pq.sent") }), ref ? el("p", { class: "ref-big", text: t("pq.ref") + ": " + ref }) : null,
      c.acknowledge_by ? el("p", { class: "promise-big", text: t("pq.promise") + " " + L.whenText(c.acknowledge_by, Date.now(), lang()) }) : null,
      el("div", { class: "actions" }, [P.link("#/case/" + id, t("pq.view"), "btn btn-pink"), P.link(missing ? "#/ask/missing" : "#/ask", t("pq.another"), "btn btn-outline")])].filter(Boolean))];
    if (wa) nodes.push(waCard(wa, ref, childName, true));
    P.show(nodes);
  }

  P.routes.ask = page;
})();
