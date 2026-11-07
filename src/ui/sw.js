// Ottr service worker: shows Web Push notifications and focuses the right board tab on click.
// The server is the authority on what this device should show: before it shows or keeps
// anything, the worker asks /api/notifications/live for this device's state per class (how
// many alerts are still live, the sequence number of the last alert sent). Push handlers run
// one at a time, so a slow handler can never overwrite a newer one's result.
// Push payloads come in three kinds:
// - {type:"alert", seq, upTo}: shows only while its class still has a live alert on this
//   device and it is the newest alert sent for that class. A resolved, acknowledged or
//   superseded payload shows nothing, however late or out of order it arrives. (Chrome may
//   show its own "updated in the background" notice for a push that shows nothing; that is
//   the browser's, not an Ottr alert.)
// - {type:"clear", tags, upTo}: retract; shows nothing. Apple's push service revokes
//   subscriptions that get pushes without a visible notification, so the server never
//   sends these to Apple endpoints; there the next alert does the retraction.
// - untyped (the /api/push/test payload): shown as is.
// Each push also closes every class the server reports with no live alert. When the server
// cannot be reached (offline, signed out), the worker falls back to the payload: `upTo`
// closes notifications whose own number is at or below the bound, and an alert shows unless
// a newer one of its class is up.
const LIVE_TIMEOUT_MS = 3000;

const seqOf = (n) => n.data?.seq ?? 0;

let chain = Promise.resolve();
/** Runs push handlers one at a time, in arrival order. */
function serial(fn) {
	const run = chain.then(fn, fn);
	chain = run.catch(() => {});
	return run;
}

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
		// seq orders this notification against later retractions in the offline fallback.
		data: { url: data.url ?? "/", seq: data.seq ?? 0 },
	});
}

/** This device's live state per class from the server; null when it cannot be read. */
async function fetchLive() {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), LIVE_TIMEOUT_MS);
	try {
		const sub = await self.registration.pushManager.getSubscription();
		if (sub === null) return null;
		const res = await fetch(
			`/api/notifications/live?endpoint=${encodeURIComponent(sub.endpoint)}`,
			{ credentials: "same-origin", signal: ctrl.signal },
		);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Closes every class the server reports with no live alert on this device. */
async function closeDead(live) {
	for (const [tag, state] of Object.entries(live)) {
		if (state?.live !== 0) continue;
		const list = await self.registration.getNotifications({ tag });
		for (const n of list) n.close();
	}
}

async function handleAlert(data) {
	const seq = data.seq ?? 0;
	const live = await fetchLive();
	if (live !== null) {
		await closeDead(live);
		const state = live[data.tag];
		if (state !== undefined && state.live > 0 && seq >= state.seq)
			await show(data);
		return;
	}
	await closeUpTo(data.upTo);
	const current = await self.registration.getNotifications({ tag: data.tag });
	if (current.some((n) => seqOf(n) > seq)) return;
	await show(data);
}

async function handleClear(data) {
	const live = await fetchLive();
	if (live !== null) await closeDead(live);
	else await closeUpTo(data.upTo);
}

self.addEventListener("push", (event) => {
	const data = event.data ? event.data.json() : {};
	if (data.type === "clear") event.waitUntil(serial(() => handleClear(data)));
	else if (data.type === "alert")
		event.waitUntil(serial(() => handleAlert(data)));
	else event.waitUntil(serial(() => show(data)));
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
