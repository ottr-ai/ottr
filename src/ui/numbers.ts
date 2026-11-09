/** Count readouts render grouped: "1,891 / 6,523" (DESIGN.md "Typography", ui-ux-check 45).
 *  en-US is fixed, so tests and screenshots never depend on the viewer's locale. */
const grouped = new Intl.NumberFormat("en-US");

/** Formats an integer with the thousands separator; CSS keeps the digits tabular. */
export function fmtNum(n: number): string {
	return grouped.format(n);
}
