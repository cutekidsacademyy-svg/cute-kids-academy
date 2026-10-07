// Parent portal: Photos (#/photos). A parent sees only the photos and videos in which their own child is tagged,
// grouped by day and event, and can download them. Files are opened through links that expire after 5 minutes;
// there are no public addresses. The database decides what a parent may see. Text is only ever inserted as text.
(function () {
  "use strict";
  var P = window.CKAParent, el = CKA.el, t = CKA.t, client = CKA.client;
  var chosen = "";

  function lang() { return CKA.getLang(); }
  function pick(en, ar) { var a = lang() === "ar" ? [ar, en] : [en, ar]; return (a[0] && a[0].trim()) ? a[0] : (a[1] || ""); }
  function dayText(s) { return new Intl.DateTimeFormat(lang() === "ar" ? "ar-EG" : "en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(s + "T12:00:00Z")); }

  // Short helper other pages use too: the newest items as small pictures (the home screen).
  async function latest(limit) {
    var items = ((await client.from("media_items").select("id, kind, storage_path, album_date, created_at").eq("kind", "photo").order("created_at", { ascending: false }).limit(limit || 6)).data || [])
      .slice().sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; }).slice(0, limit || 6);
    if (!items.length) return [];
    var urls = await client.storage.from("media").createSignedUrls(items.map(function (i) { return i.storage_path; }), 300), by = {};
    ((urls && urls.data) || []).forEach(function (u) { if (u.signedUrl) by[u.path] = u.signedUrl; });
    return items.map(function (i) { return { id: i.id, url: by[i.storage_path] }; }).filter(function (i) { return i.url; });
  }

  async function page() {
    P.loadingView();
    var kids = P.children(), nodes = [P.card([el("h1", { text: t("pp.title") })])];
    var res = await Promise.all([client.from("media_items").select("*").order("album_date", { ascending: false }).limit(120), client.from("media_tags").select("media_id, child_id"),
      client.from("events").select("id, title_en, title_ar")]);
    var items = (res[0].data || []).slice().sort(function (a, b) { return a.album_date < b.album_date ? 1 : a.album_date > b.album_date ? -1 : (a.created_at < b.created_at ? 1 : -1); });
    var tagsBy = {}; (res[1].data || []).forEach(function (x) { (tagsBy[x.media_id] = tagsBy[x.media_id] || []).push(x.child_id); });
    var events = {}; (res[2].data || []).forEach(function (e) { events[e.id] = pick(e.title_en, e.title_ar); });
    if (kids.length > 1) {
      var bar = el("div", { class: "actions" });
      [{ id: "", full_name: t("pp.all") }].concat(kids).forEach(function (k) {
        var b = el("button", { type: "button", class: "filter-pill" + (k.id === chosen ? " active" : ""), text: k.full_name });
        b.addEventListener("click", function () { chosen = k.id; page(); });
        bar.appendChild(b);
      });
      nodes.push(P.card([el("h2", { text: t("pp.pick") }), bar]));
    }
    if (chosen) items = items.filter(function (i) { return (tagsBy[i.id] || []).indexOf(chosen) >= 0; });
    if (!items.length) { nodes.push(P.card([el("p", { class: "p-sub", text: t("pp.none") })])); return P.show(nodes); }

    var paths = items.map(function (i) { return i.storage_path; });
    var view = await client.storage.from("media").createSignedUrls(paths, 300), dl = await client.storage.from("media").createSignedUrls(paths, 300, { download: true });
    var viewBy = {}, dlBy = {};
    ((view && view.data) || []).forEach(function (u) { if (u.signedUrl) viewBy[u.path] = u.signedUrl; });
    ((dl && dl.data) || []).forEach(function (u) { if (u.signedUrl) dlBy[u.path] = u.signedUrl; });

    var groups = {}, order = [];
    items.forEach(function (i) { var k = i.album_date + "|" + (i.event_id || ""); if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(i); });
    order.forEach(function (k) {
      var first = groups[k][0], title = dayText(first.album_date) + (first.event_id && events[first.event_id] ? " · " + t("pp.event") + ": " + events[first.event_id] : "");
      var grid = el("div", { class: "photos" });
      groups[k].forEach(function (i) {
        var u = viewBy[i.storage_path], d = dlBy[i.storage_path];
        var media = !u ? el("div", { class: "dot", text: "…" }) : i.kind === "video" ? el("video", { src: u, controls: "controls", preload: "metadata", playsinline: "playsinline", style: "width:160px;border-radius:12px" })
          : el("a", { href: u, target: "_blank", rel: "noopener" }, [el("img", { src: u, alt: "" })]);
        grid.appendChild(el("div", { style: "display:flex;flex-direction:column;gap:4px;max-width:170px" }, [media, d ? el("a", { class: "btn btn-outline btn-small", href: d, text: "⬇ " + t("pp.download") }) : null].filter(Boolean)));
      });
      nodes.push(P.card([el("h2", { text: title }), grid]));
    });
    P.show(nodes);
  }

  P.latestPhotos = latest;
  P.routes.photos = page;
})();
