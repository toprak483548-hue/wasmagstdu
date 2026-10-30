self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let data = {};
    try {
      data = event.data ? event.data.json() : {};
    } catch {
      try { data = { body: event.data?.text() || "Yeni bir mesajın var." }; } catch {}
    }

    const title = String(data.title || "Mesaj").slice(0, 80);
    const body = String(data.body || "Yeni bir mesajın var.").slice(0, 180);
    let targetUrl = "/";
    try {
      const candidate = new URL(data.url || "/", self.location.origin);
      if (candidate.origin === self.location.origin) targetUrl = `${candidate.pathname}${candidate.search}${candidate.hash}`;
    } catch {}

    await self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: data.chatId ? `mesaj-chat-${data.chatId}` : "mesaj-new-message",
      renotify: true,
      timestamp: Date.now(),
      data: { url: targetUrl }
    });
  })());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const rawUrl = event.notification.data?.url || "/";
  const targetUrl = new URL(rawUrl, self.location.origin);
  if (targetUrl.origin !== self.location.origin) targetUrl.href = self.location.origin;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      try {
        await client.navigate(targetUrl.href);
        return await client.focus();
      } catch {}
    }
    if (self.clients.openWindow) return self.clients.openWindow(targetUrl.href);
  })());
});
