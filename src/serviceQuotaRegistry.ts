import { createPixellabQuotaAdapter } from "./serviceQuotaPixellab.ts";
import { createZaiQuotaAdapter } from "./serviceQuotaZai.ts";
import type { ServiceQuotaAdapterDefinition } from "./types.ts";

const pixellab = createPixellabQuotaAdapter();
const zai = createZaiQuotaAdapter();

export const builtInServiceQuotaAdapters: ReadonlyMap<
	string,
	ServiceQuotaAdapterDefinition
> = new Map([
	[pixellab.id, pixellab],
	[zai.id, zai],
]);
