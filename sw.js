// Service worker for the parent portal (installable app + web push).
// It never stores pages or data. A push carries no text at all: we show a generic message in both languages,
// so nothing about a child can ever appear on a locked phone, and tapping it opens the portal.
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (event) { event.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function () { /* everything goes straight to the network */ });

self.addEventListener("push", function (event) {
  event.waitUntil(self.registration.showNotification("Cute Kids Academy", {
    body: "You have a new update · لديك تحديث جديد",
    icon: "/images/icon-192.png",
    badge: "/images/favicon.png",
    tag: "cka-update",
    data: { url: "/portal/" },
  }));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) { if (list[i].url.indexOf("/portal/") >= 0 && "focus" in list[i]) return list[i].focus(); }
    return self.clients.openWindow("/portal/");
  }));
});
