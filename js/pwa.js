// Makes the portal an installable app and lets a parent turn on push notifications on this device.
// Pushes carry no text (see sw.js). Needs the public VAPID key in js/portal-config.js; without it push stays off.
(function () {
  "use strict";
  var cfg = window.CKA_PORTAL || {};
  var swSupported = "serviceWorker" in navigator;
  var pushSupported = swSupported && "PushManager" in window && "Notification" in window;

  if (swSupported) { window.addEventListener("load", function () { navigator.serviceWorker.register("/sw.js").catch(function () {}); }); }

  function keyBytes(b64u) {
    var pad = "=".repeat((4 - (b64u.length % 4)) % 4), raw = atob((b64u + pad).replace(/-/g, "+").replace(/_/g, "/")), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function b64u(buf) { var s = ""; new Uint8Array(buf).forEach(function (b) { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }

  window.CKAPush = {
    available: function () { return pushSupported && !!cfg.vapidPublicKey; },
    denied: function () { return pushSupported && Notification.permission === "denied"; },
    isOn: async function () {
      if (!pushSupported) return false;
      var reg = await navigator.serviceWorker.getRegistration();
      return !!(reg && (await reg.pushManager.getSubscription()) && Notification.permission === "granted");
    },
    enable: async function (client) {
      var perm = await Notification.requestPermission();
      if (perm !== "granted") return false;
      var reg = await navigator.serviceWorker.ready;
      var sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(cfg.vapidPublicKey) });
      var r = await client.rpc("push_subscribe", { p_endpoint: sub.endpoint, p_p256dh: b64u(sub.getKey("p256dh")), p_auth: b64u(sub.getKey("auth")) });
      return !r.error;
    },
    disable: async function (client) {
      var reg = await navigator.serviceWorker.getRegistration(), sub = reg && await reg.pushManager.getSubscription();
      if (sub) { await client.rpc("push_unsubscribe", { p_endpoint: sub.endpoint }); await sub.unsubscribe(); }
    },
  };
})();
