self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const title = data.title || "Yeni mesaj";
  const options = {
    body: data.body || "Yeni bir mesajın var.",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: data.chatId ? `chat-${data.chatId}` : "mesaj-notification",
    renotify: true,
    data: { url: data.url || "/" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const rawUrl = event.notification.data?.url || "/";
  const url = new URL(rawUrl, self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const client of list) {
      if ("focus" in client) { return client.navigate(url).then(() => client.focus()); }
    }
    return clients.openWindow ? clients.openWindow(url) : undefined;
  }));
});
