---
name: web-perf-audit
description: "Audit a web app or server for performance: verify generic tips against the code with file:line evidence, measure real sizes and headers, and write a verdict report."
---

# Web performance audit

Use this skill to audit a web app or a server for performance before anyone implements optimizations. It turns generic performance tips into project-specific verdicts with evidence.

## When to use

- Someone hands you a list of performance tips, a video, or an article about a project.
- Someone asks "is this app fast" or "what performance work is worth doing".

## Procedure

1. List every tip. Do not drop any.
2. For each tip, read the code that would implement it. Give a verdict with file:line evidence:
   - DONE — the project already does it. Name where.
   - GAP — a real, worthwhile gap. Name the file:line and the cost.
   - N/A — the tip conflicts with the project's design. Name the constraint: self-hosted, single instance, in-process database, authenticated internal tool, short lists.
3. Measure before you prescribe. Build the bundle, compress the big assets with gzip and brotli, and record byte sizes. Probe the server with a real request that sends `Accept-Encoding`, and check `Content-Encoding`, `Cache-Control`, and ETag.
4. Write the report: a verdict table, a measurements table, a caveats section, and a `## Recommended steps` section ordered by benefit for the cost. Each step is one self-contained card with a size estimate and file:line anchors. List the rejected tips with reasons, so the next audit does not relitigate them.
5. Keep scratch output (builds, downloads, probe servers) in the OS temp dir, outside the repo.

## Rules checklist

Server:

- No `SELECT *` on list endpoints whose callers discard heavy columns. Use an explicit column list, and keep the full read on the detail path.
- No per-item queries in a list or state build (N+1). Batch one query per collection, and read derivable fields from the row in hand.
- Hand-served static files bypass framework caching. Give each an explicit `Cache-Control` and an ETag. Serve immutable assets at versioned paths marked `immutable`.
- Do not assume response compression. Verify with a real request. When it is missing, precompress once (brotli and gzip), select by `Accept-Encoding`, and send `Vary: Accept-Encoding`.
- Every outbound fetch gets a timeout (`AbortSignal.timeout`). Clear dependent UI flags on failure.
- No slow work (clone, large transfer) inside a request path with a short idle timeout. Exempt the route or queue the work.
- Polling clients: in-flight guard plus dirty flag, parallel independent requests, no duplicate boot or offline probes, and poll live context only while a task runs.
- Time slow API requests in the client's `api()` wrapper.

Client:

- One `useState` for the whole app state re-renders everything. Reuse unchanged item objects, wrap items in `memo` with stable callbacks, precompute derived per-item Maps, and run FLIP effects only when item ids or stages change.
- Static skeleton markup in the mount node, so something paints before the bundle loads.
- `loading="lazy"` on below-fold images, including markdown-generated ones.
- Stream large text by byte offset from the item's own offset. Never refetch from byte 0 and slice on the client.

Caveats:

- Re-test the original bug of a workaround on the current runtime version before you remove it. Record the version and the OS.
- A tip that conflicts with the project's design stays rejected. Record the reason.

## Report format

Write the report as `research-report.md` at the repo root of the worktree. Do not commit it. When the task is research-only, report the task as answered, never ready.
