// Ottr service worker: shows Web Push notifications and focuses the right board tab on click.
self.addEventListener("push", (event) => {
	const data = event.data ? event.data.json() : {};
	event.waitUntil(
		self.registration.showNotification(data.title ?? "Ottr", {
			body: data.body,
			tag: data.tag,
			icon: "/icon-192.png",
			data: { url: data.url ?? "/" },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	const url = event.notification.data?.url || "/";
	event.notification.close();
	event.waitUntil(
		self.clients
			.matchAll({ type: "window", includeUncontrolled: true })
			.then((list) => {
				for (const client of list) {
					if (client.url.includes(url) && "focus" in client)
						return client.focus();
				}
				return self.clients.openWindow(url);
			}),
	);
});
