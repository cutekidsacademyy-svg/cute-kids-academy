// Staff screen: Transport (#/transport). Management sets up the bus routes (driver, the staff member who rides, stops with morning
// and afternoon times, the children and the monthly fee that becomes a charge in Payments). The person riding a bus, and
// management, open "the run": every stop with its children, mark each child on board, absent or dropped off, and tell the families
// "the bus is 10 minutes away". Text from the database is only ever inserted as text.
(function () {
  "use strict";
  var S = window.CKAStaff, el = CKA.el, t = CKA.t, client = CKA.client;
  var session = "morning", flash = null, editing = null;

  function input(type, attrs, v) { var i = el("input", Object.assign({ type: type }, attrs || {})); if (v != null) i.value = v; return i; }
  function hm(v) { return v ? String(v).slice(0, 5) : ""; }

  async function page(parts) {
    S.loadingView();
    var routes = (await client.from("bus_routes").select("*").order("name")).data || [];
    var nodes = [];
    if (flash) { nodes.push(S.note(flash.kind, flash.text)); flash = null; }
    nodes.push(S.card([el("h1", { text: t("tr.title") })]));
    if (parts && parts[1]) return runView(parts[1], nodes);
    if (!routes.length) nodes.push(S.card([el("p", { class: "p-sub", text: t("tr.none") })]));
    routes.forEach(function (r) {
      var run = S.link("#/transport/" + r.id, "🚌 " + t("tr.open_run"), "btn btn-pink btn-small");
      var kids = [el("div", { class: "case-top" }, [el("strong", { text: r.name }), r.active ? null : S.pill(t("tr.inactive"))].filter(Boolean)),
        el("small", { text: [r.driver_name, r.driver_phone].filter(Boolean).join(" · ") }), el("div", { class: "actions" }, [run])];
      if (S.isMgmt()) { var ed = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("tr.edit") }); ed.addEventListener("click", function () { editing = editing === r.id ? null : r.id; page(); }); kids[2].appendChild(ed); }
      var holder = el("div", {}); kids.push(holder);
      if (editing === r.id && S.isMgmt()) editor(r, holder);
      nodes.push(S.card(kids));
    });
    if (S.isMgmt()) {
      var nw = el("div", {}); if (editing === "new") editor(null, nw);
      var add = el("button", { type: "button", class: "btn btn-outline", text: "＋ " + t("tr.new") }); add.addEventListener("click", function () { editing = editing === "new" ? null : "new"; page(); });
      nodes.push(S.card([add, nw]));
    }
    S.show(nodes);
  }

  async function editor(r, holder) {
    var staff = (await S.loadStaff()).filter(function (p) { return p.role === "teacher" || p.role === "admin"; });
    var name = input("text", { maxlength: "80" }, r ? r.name : ""), driver = input("text", { maxlength: "80" }, r ? r.driver_name || "" : ""), phone = input("tel", { maxlength: "40", dir: "ltr" }, r ? r.driver_phone || "" : "");
    var rider = el("select", {}, [S.opt("", t("tr.rider_none"))].concat(staff.map(function (p) { return S.opt(p.id, p.full_name); }))); rider.value = r && r.rider_id ? r.rider_id : "";
    var rname = input("text", { maxlength: "80" }, r ? r.rider_name || "" : ""), fee = input("number", { min: "0", step: "0.01" }, r ? r.monthly_fee : 0);
    var act = el("input", { type: "checkbox" }); act.checked = r ? r.active : true;
    var msg = el("div", {}), save = el("button", { type: "button", class: "btn btn-pink btn-small", text: t("tr.save") });
    save.addEventListener("click", async function () {
      msg.textContent = ""; save.disabled = true;
      try { await S.rpc("route_save", { p_id: r ? r.id : null, p_name: name.value, p_driver: driver.value, p_driver_phone: phone.value, p_rider: rider.value || null, p_rider_name: rname.value, p_fee: Number(fee.value || 0), p_active: act.checked });
        flash = { kind: "ok", text: t("tr.saved") }; editing = null; page(); }
      catch (e) { save.disabled = false; msg.appendChild(S.note("err", S.msgFromError(e))); }
    });
    holder.appendChild(el("div", { class: "action" }, [S.field(t("tr.f.name"), name), el("div", { class: "f-grid" }, [S.field(t("tr.f.driver"), driver), S.field(t("tr.f.phone"), phone)]), S.field(t("tr.f.rider"), rider), S.field(t("tr.f.rider_name"), rname),
      S.field(t("tr.f.fee"), fee), el("label", { class: "choice" }, [act, el("span", { text: t("tr.f.active") })]), msg, save]));
    if (!r) return;
    // stops and children of this route
    var res = await Promise.all([client.from("route_stops").select("*").eq("route_id", r.id).order("position"), client.from("route_children").select("child_id, stop_id, children(full_name)").eq("route_id", r.id),
      client.from("children").select("id, full_name").eq("active", true).order("full_name"), client.from("route_children").select("child_id")]);
    var stops = res[0].data || [], inRoute = res[1].data || [], allKids = res[2].data || [], taken = {}; (res[3].data || []).forEach(function (x) { taken[x.child_id] = true; });
    var box = el("div", { class: "action" }, [el("h3", { text: t("tr.stops") })]), emsg = el("div", {});
    stops.forEach(function (s) {
      var rm = el("button", { type: "button", class: "p-link", text: t("tr.remove") });
      rm.addEventListener("click", async function () { try { await S.rpc("stop_delete", { p_stop: s.id }); page(); } catch (e) { emsg.appendChild(S.note("err", S.msgFromError(e))); } });
      box.appendChild(el("div", { class: "kv" }, [el("strong", { text: s.position + ". " + s.name }), el("small", { text: "☀ " + hm(s.morning_time) + " · 🌙 " + hm(s.afternoon_time) }), rm]));
    });
    var sn = input("text", { maxlength: "100", placeholder: t("tr.stop_name") }), mt = input("time", {}), at = input("time", {}), add = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("tr.add_stop") });
    add.addEventListener("click", async function () {
      emsg.textContent = ""; if (!sn.value.trim()) { emsg.appendChild(S.note("err", t("tr.stop_need"))); return; }
      try { await S.rpc("stop_save", { p_id: null, p_route: r.id, p_position: stops.reduce(function (m, s) { return Math.max(m, s.position); }, 0) + 1, p_name: sn.value, p_morning: mt.value || null, p_afternoon: at.value || null }); page(); }
      catch (e) { emsg.appendChild(S.note("err", S.msgFromError(e))); }
    });
    box.appendChild(sn); box.appendChild(el("div", { class: "f-grid" }, [S.field(t("tr.morning"), mt), S.field(t("tr.afternoon"), at)])); box.appendChild(add);
    holder.appendChild(box);

    var kbox = el("div", { class: "action" }, [el("h3", { text: t("tr.children") })]);
    inRoute.forEach(function (rc) {
      var sel = el("select", {}, [S.opt("", t("tr.no_stop"))].concat(stops.map(function (s) { return S.opt(s.id, s.name); }))); sel.value = rc.stop_id || "";
      sel.addEventListener("change", async function () { try { await S.rpc("route_child_set", { p_route: r.id, p_child: rc.child_id, p_stop: sel.value || null }); } catch (e) { emsg.appendChild(S.note("err", S.msgFromError(e))); } });
      var rm = el("button", { type: "button", class: "p-link", text: t("tr.remove") });
      rm.addEventListener("click", async function () { try { await S.rpc("route_child_remove", { p_child: rc.child_id }); page(); } catch (e) { emsg.appendChild(S.note("err", S.msgFromError(e))); } });
      kbox.appendChild(el("div", { class: "kv" }, [el("strong", { text: rc.children ? rc.children.full_name : "" }), sel, rm]));
    });
    var pick = el("select", {}, [S.opt("", t("tr.add_child"))].concat(allKids.filter(function (k) { return !taken[k.id]; }).map(function (k) { return S.opt(k.id, k.full_name); })));
    pick.addEventListener("change", async function () { if (!pick.value) return; try { await S.rpc("route_child_set", { p_route: r.id, p_child: pick.value, p_stop: null }); page(); } catch (e) { emsg.appendChild(S.note("err", S.msgFromError(e))); } });
    kbox.appendChild(pick); kbox.appendChild(el("p", { class: "p-sub", text: t("tr.one_route") }));
    holder.appendChild(kbox); holder.appendChild(emsg);
  }

  // ------------------------------------------------------------------ The run
  async function runView(routeId, nodes) {
    var d = await S.rpc("transport_run", { p_route: routeId, p_session: session }), msg = el("div", {});
    var seg = el("div", { class: "actions" });
    [["morning", "tr.morning"], ["afternoon", "tr.afternoon"]].forEach(function (o) {
      var b = el("button", { type: "button", class: "filter-pill" + (session === o[0] ? " active" : ""), text: t(o[1]) }); b.addEventListener("click", function () { session = o[0]; page(["transport", routeId]); }); seg.appendChild(b);
    });
    nodes.push(S.card([S.link("#/transport", t("tr.back")), el("h2", { text: d.route.name }), el("small", { text: [d.route.driver_name, d.route.driver_phone, d.route.rider_name].filter(Boolean).join(" · ") }), seg, msg], "blue"));
    function setStatus(c, status, btn) {
      return async function () { try { await S.rpc("transport_set_status", { p_child: c.child_id, p_session: session, p_status: status }); page(["transport", routeId]); } catch (e) { msg.textContent = ""; msg.appendChild(S.note("err", S.msgFromError(e))); } };
    }
    function childRow(c) {
      var row = el("div", { class: "kv" }, [el("strong", { text: c.name }), c.status ? S.pill(t("tr.st." + c.status), c.status === "dropped_off" ? "st-resolved" : c.status === "absent" ? "urg-urgent" : "") : null].filter(Boolean));
      var acts = el("div", { class: "actions" });
      ["on_board", "absent", "dropped_off"].forEach(function (s) { var b = el("button", { type: "button", class: "btn btn-outline btn-small", text: t("tr.st." + s) }); b.addEventListener("click", setStatus(c, s)); acts.appendChild(b); });
      row.appendChild(acts); return row;
    }
    (d.stops || []).forEach(function (s) {
      var near = el("button", { type: "button", class: "btn btn-pink btn-small", text: "📍 " + t("tr.near") });
      near.addEventListener("click", async function () {
        near.disabled = true; msg.textContent = "";
        try { var n = await S.rpc("transport_near", { p_route: routeId, p_session: session, p_stop: s.id }); msg.appendChild(S.note("ok", t("tr.near_sent").replace("{n}", n))); } catch (e) { msg.appendChild(S.note("err", S.msgFromError(e))); }
        near.disabled = false;
      });
      nodes.push(S.card([el("div", { class: "case-top" }, [el("strong", { text: s.position + ". " + s.name + (s.time ? " · " + hm(s.time) : "") }), near])].concat((s.children || []).length ? s.children.map(childRow) : [el("p", { class: "p-sub", text: t("tr.no_children") })])));
    });
    if ((d.unassigned || []).length) nodes.push(S.card([el("h3", { text: t("tr.unassigned") })].concat(d.unassigned.map(childRow))));
    S.show(nodes);
  }

  S.routes.transport = page;
})();
