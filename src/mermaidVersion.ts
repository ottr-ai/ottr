/**
 * The mermaid npm version this build serves and loads. package.json pins the dependency;
 * the test "MERMAID_VERSION matches the installed mermaid package" in src/app.test.ts pins
 * this constant to the installed package, so a bump without this edit fails the gates.
 */
export const MERMAID_VERSION = "12.3.0";

/** The versioned URL mermaid's prebuilt bundle is served at and the UI loads (OTTR-719). */
export const mermaidSrc = `/mermaid-${MERMAID_VERSION}.min.js`;
