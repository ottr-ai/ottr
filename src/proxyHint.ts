/**
 * Suffix for an internal 3xx whose Location lands on another host. Podman injects
 * the host's proxy env into every container and its NO_PROXY names no compose
 * services, so an internal call can bounce off the corporate proxy. Only internal
 * call sites (alate, workers) add the hint: external calls may legitimately redirect.
 */
export function redirectProxyHint(url: string, res: Response): string {
	const location = res.headers.get("location");
	if (!location) return "";
	try {
		const to = new URL(location, url);
		if (to.host === new URL(url).host) return "";
	} catch {
		return "";
	}
	return "; a proxy may intercept this call: check NO_PROXY";
}
