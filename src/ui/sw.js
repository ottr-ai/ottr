// Ottr service worker: shows Web Push notifications and focuses the right board tab on click.
// Push payloads come in three kinds:
// - {type:"alert"}: carries `seq`, the device's per-class sequence number, and `upTo`,
//   retraction bounds per class. First the bounded retraction runs; then the alert shows
//   unless a newer one of its class is already up (pushes can arrive out of order) or
//   every key it names is already acknowledged. A not-shown, acknowledged alert also
//   closes older same-tag notifications whose own keys are all acknowledged; a `partial`
//   one (more alerts than its keys name) never counts as read. (Chrome may show its own
//   "updated in the background" notice for a push that shows nothing; that is the
//   browser's, not an Ottr alert.)
// - {type:"clear", tags, upTo}: retract; shows nothing. Apple's push service revokes
//   subscriptions that get pushes without a visible notification, so the server never
//   sends these to Apple endpoints; there the next alert's `upTo` does the retraction.
// - untyped (the /api/push/test payload): shown as is.
// Every retraction is bounded: a notification closes only when the payload that showed it
// had a sequence number at or below the bound, so a late retraction never closes an alert
// that was sent after it was decided. Notifications without a number (from before) count 0.
const SEEN_TIMEOUT_MS = 3000;

const seqOf = (n) => n.data?.seq ?? 0;

async function closeUpTo(upTo) {
	for (const [tag, bound] of Object.entries(upTo ?? {})) {
		const list = await self.registration.getNotifications({ tag });
		for (const n of list) if (seqOf(n) <= bound) n.close();
	}
}

function show(data) {
	return self.registration.showNotification(data.title ?? "Ottr", {
		body: data.body,
		tag: data.tag,
		// Same tag replaces the tray entry; renotify makes the replacement alert again.
		renotify: data.tag !== undefined,
		icon: "/icon-192.png",
		// keys/partial: which alerts this notification stands for, so a later acknowledged
		// push can tell whether it is stale; seq orders it against later retractions.
		data: {
			url: data.url ?? "/",
			keys: data.keys ?? [],
			partial: data.partial === true,
			seq: data.seq ?? 0,
		},
	});
}

/** The server's acknowledged keys; null on any fetch failure (then the alert shows). */
async function fetchSeen() {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), SEEN_TIMEOUT_MS);
	try {
		const res = await fetch("/api/inbox/seen", {
			credentials: "same-origin",
			signal: ctrl.signal,
		});
		if (!res.ok) return null;
		const body = await res.json();
		return new Set(Array.isArray(body?.keys) ? body.keys : []);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

async function handleAlert(data) {
	await closeUpTo(data.upTo);
	const seq = data.seq ?? 0;
	const current = await self.registration.getNotifications({ tag: data.tag });
	// A newer alert of this class is already up: this payload is stale, never shows.
	if (current.some((n) => seqOf(n) > seq)) return;
	const seen = await fetchSeen();
	const keys = data.keys ?? [];
	const read =
		seen !== null &&
		data.partial !== true &&
		keys.length > 0 &&
		keys.every((k) => seen.has(k));
	if (!read) {
		await show(data);
		return;
	}
	for (const n of current) {
		const shown = n.data?.keys ?? [];
		if (
			seqOf(n) < seq &&
			n.data?.partial !== true &&
			shown.length > 0 &&
			shown.every((k) => seen.has(k))
		)
			n.close();
	}
}

self.addEventListener("push", (event) => {
	const data = event.data ? event.data.json() : {};
	if (data.type === "clear") event.waitUntil(closeUpTo(data.upTo));
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
