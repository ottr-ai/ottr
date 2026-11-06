// Ottr service worker: shows Web Push notifications and focuses the right board tab on click.
// Push payloads come in three kinds:
// - {type:"alert"}: retract the `clear` class tags, then show unless every key was
//   already acknowledged elsewhere: an acknowledged alert never reaches the screen.
//   (Chrome may then show its own "updated in the background" notice once its
//   silent-push allowance runs out; that is the browser's, not an Ottr alert.)
// - {type:"clear", tags}: retract notifications whose cause cleared; shows nothing.
//   Apple's push service revokes subscriptions that get pushes without a visible
//   notification, so the server never sends these to Apple endpoints; there the next
//   alert's `clear` list does the retraction.
// - untyped (the /api/push/test payload): shown as is.
const SEEN_TIMEOUT_MS = 3000;

async function closeTags(tags) {
	for (const tag of tags ?? []) {
		const list = await self.registration.getNotifications({ tag });
		for (const n of list) n.close();
	}
}

function show(data) {
	return self.registration.showNotification(data.title ?? "Ottr", {
		body: data.body,
		tag: data.tag,
		// Same tag replaces the tray entry; renotify makes the replacement alert again.
		renotify: data.tag !== undefined,
		icon: "/icon-192.png",
		data: { url: data.url ?? "/" },
	});
}

/** True when the server reports every key acknowledged; false on any fetch failure. */
async function allSeen(keys) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), SEEN_TIMEOUT_MS);
	try {
		const res = await fetch("/api/inbox/seen", {
			credentials: "same-origin",
			signal: ctrl.signal,
		});
		if (!res.ok) return false;
		const body = await res.json();
		const seen = new Set(Array.isArray(body?.keys) ? body.keys : []);
		return (keys ?? []).every((k) => seen.has(k));
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

async function handleAlert(data) {
	await closeTags(data.clear);
	if (await allSeen(data.keys)) return;
	await show(data);
}

self.addEventListener("push", (event) => {
	const data = event.data ? event.data.json() : {};
	if (data.type === "clear") event.waitUntil(closeTags(data.tags));
	else if (data.type === "alert") event.waitUntil(handleAlert(data));
	else event.waitUntil(show(data));
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
