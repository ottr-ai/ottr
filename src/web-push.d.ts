// Minimal ambient types for web-push@3.6.7 (the package ships none); only what Ottr uses.
declare module "web-push" {
	export function generateVAPIDKeys(): {
		publicKey: string;
		privateKey: string;
	};
	export function sendNotification(
		subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
		payload?: string,
	): Promise<unknown>;
	export function setVapidDetails(
		subject: string,
		publicKey: string,
		privateKey: string,
	): void;
}
