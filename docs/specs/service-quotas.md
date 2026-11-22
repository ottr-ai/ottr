# External service quotas

Status: shared contracts, bounded transport, independent cache, server state integration, and overview display are implemented.
Step 3 implements the PixelLab v2 adapter, the Z.AI coding-plan adapter, and the built-in registry.
Approved live activation remains pending.

This specification implements recommended step 1 from the OTTR-1092 research report carried by OTTR-1101.
It defines the contract for the later implementation cards.
The research-only ban on implementation and commits applied to OTTR-1092, not those later cards.

## Behavior and assumptions

Add trusted, built-in service adapters and a separate `serviceQuotas` field to board state.
Keep the existing `quota` field for omp model providers.
Show external quotas only in the existing overview, without effects on task execution.
Support both time windows and balances.
Use PixelLab v2 as the first adapter.
The Z.AI coding-plan adapter follows it.

The configuration is an internal, server-supplied `ServiceQuotaSourceConfig` list.
This specification adds no operator JSON environment setting, configuration file format, public configuration endpoint, or persisted configuration shape.
It adds no configuration UI or rebind endpoint.
Live activation requires an approved server secret source, never worker or project Env.
No supported secret name follows from the example `OTTR_PIXELLAB_API_KEY` in the research report.

The implementation assumes a trusted adapter registry and server-only credential resolution.
All intervals and transport limits below are Ottr policy, not PixelLab guarantees.
The public provider schema can change.
Use a reviewed decoder, not a runtime OpenAPI fetch.

## Repository integration

| Path | Integration requirement |
| --- | --- |
| [`src/quota.ts`](../../src/quota.ts) | Keep `parseUsage`, `fetchQuota`, provider filters, and model quota helpers model-only. |
| [`src/types.ts`](../../src/types.ts) | Add the separate service types and optional `StateResponse.serviceQuotas` field. Do not add balances to `QuotaLimit`. |
| [`src/app.ts`](../../src/app.ts) | Read the service cache in the shared state builder. Keep service refresh independent of the model refresh guard, hold release, and `deps.schedule()`. |
| [`src/server.ts`](../../src/server.ts) | Use the boot and 30-second statistics tick to check due service sources. Do not await provider reads in the tick. |
| [`src/turn.ts`](../../src/turn.ts) | Keep service data out of the turn-loop `fetchQuota` callback and `usageResetFor`. |
| [`src/ui/socket.ts`](../../src/ui/socket.ts) | Pass the cached field through full state. Keep `lastQuota` model-only. Preserve production HTTP polling and non-production WebSocket behavior. |
| [`src/ui/app.tsx`](../../src/ui/app.tsx) | Pass the field to `SystemBar`. Add a separate service section in the overview. |
| [`src/ui/kit.tsx`](../../src/ui/kit.tsx) | Keep `useQuota` model-only. |
| [`src/ui/settings.tsx`](../../src/ui/settings.tsx) | Keep model sign-in rows unchanged. A PixelLab source is not an omp sign-in. |
| [`docs/specs/hosted-mode.md`](hosted-mode.md) | Omit external account data on the server and prevent hosted service reads. |
| [ADR 0011](../adr/0011-sealed-token-fields-encrypted-volumes.md) | Retain the existing sealing policy if a later task stores a token. This specification adds no token store. |

The data path is:

```text
Internal server source configuration and credential reference
  -> trusted built-in adapter registry
  -> independent background refresh per source
  -> bounded authenticated provider GET
  -> response validation and normalization
  -> in-memory source cache
  -> shared board state
  -> production HTTP polling or non-production WebSocket publication
  -> separate service section in the overview
```

A board-state request reads the cache only and never waits for a provider request.
A due check starts or queues service work without awaiting the provider.
Service work stays independent of the statistics sampler's active work and the model quota guard.
No adapter result enters `releaseUsageHolds`, `usageReset`, `providerBlocked`, `forModel`, or `tightestFor`.

## Internal adapter contract

```ts
type ServiceQuotaUnit =
  | { kind: "currency"; code: string }
  | { kind: "count"; name: string };

type ServiceQuotaMetric = {
  id: string;
  label: string;
  unit: ServiceQuotaUnit;
} & (
  | {
      kind: "window";
      used: number;
      limit: number;
      startsAt: number | null;
      resetsAt: number | null;
    }
  | {
      kind: "balance";
      remaining: number;
      reportedTotal: number | null;
      resetsAt: number | null;
      providerStatus: string | null;
      plan: string | null;
    }
);

interface ServiceQuotaConfigurationError {
  code: "configuration";
}

interface ServiceQuotaReadError {
  code:
    | "authentication"
    | "rate_limit"
    | "timeout"
    | "network"
    | "http"
    | "invalid_response"
    | "internal";
  httpStatus: number | null;
  retryAfterAt: number | null;
}

type ServiceQuotaReadResult =
  | { ok: true; metrics: readonly ServiceQuotaMetric[] }
  | { ok: false; error: ServiceQuotaReadError };

interface ServiceQuotaReader {
  read(context: { signal: AbortSignal }): Promise<ServiceQuotaReadResult>;
}

interface ServiceQuotaAdapterDefinition {
  readonly id: string;
  createReader(context: { credential: string }): ServiceQuotaReader;
}

interface ServiceQuotaSourceConfig {
  id: string;
  adapterId: string;
  label: string;
  credentialEnv: string;
}
```

The registry keys each `ServiceQuotaAdapterDefinition` by its adapter ID.
The server resolves `credentialEnv` privately and calls `createReader` separately for each valid source.
The factory binds one credential value, the fixed provider endpoint, and bounded HTTP transport to a new reader.
That reader uses its bound credential until the server replaces it.
Neither source configuration nor a caller can supply an endpoint.

The coordinator owns source identity, the clock, the cache, and the refresh schedule.
The adapter owns the provider request and schema mapping.
`ServiceQuotaSourceConfig` remains server-only.
Its `credentialEnv` names an environment variable, not a raw secret.
The server reads its environment at startup or explicit source rebind.
An external environment change requires a server restart.

A source ID identifies one connection.
An adapter ID identifies its implementation, such as `pixellab-v2`.
Two accounts use separate source IDs and readers, even with the same adapter definition.
Duplicate source IDs are configuration errors.
Reject conflicting entries before any reader starts.
Do not merge accounts or metrics by label.

PixelLab's balance response has no account ID.
The source binding, not a response label, determines the account identity.

### Metric rules

- Preserve units and source IDs.
- Require unique metric IDs within each source snapshot.
- Reject duplicate metric IDs as `invalid_response` for the whole snapshot.
- Keep money, generations, and other counters separate.
- Accept finite numeric values only.
- Preserve fractional balances and signed balance values.
- Require non-negative `used` and `limit` values for time windows.
- Preserve window usage above its limit.
- Calculate a window percentage only when `limit > 0`.
- Show raw values when a window limit equals zero.
- Treat `reportedTotal` as a provider-reported number, not a universal allowance or percentage denominator.
- Never calculate used percentages from balances.
- Use integer epoch milliseconds for known timestamps.
- Use `null` when the provider does not establish a timestamp or total.
- Require `startsAt < resetsAt` when both window timestamps exist.
- Keep provider status and plan labels as display data, not execution rules.

A billing-period description does not turn a balance into a time window when its dates remain unknown.
Do not invent a monthly window from a subscription name.
Each adapter returns one validated source snapshot.
A malformed required component rejects the whole source response.
Other sources remain independent.
Never publish a hidden partial result or mixed timestamps within one source.

## Board-state contract

```ts
interface ServiceQuotaSample {
  observedAt: number;
  metrics: readonly ServiceQuotaMetric[];
}

interface ServiceQuotaSourceIdentity {
  id: string;
  adapterId: string;
  label: string;
}

type ServiceQuotaSourceState = ServiceQuotaSourceIdentity & (
  | {
      status: "unconfigured";
      lastAttemptAt: null;
      nextAttemptAt: null;
      sample: null;
      error: ServiceQuotaConfigurationError;
    }
  | {
      status: "pending";
      lastAttemptAt: null;
      nextAttemptAt: number;
      sample: null;
      error: null;
    }
  | {
      status: "ok";
      lastAttemptAt: number;
      nextAttemptAt: number;
      sample: ServiceQuotaSample;
      error: null;
    }
  | {
      status: "stale";
      staleReason: "refresh_error";
      lastAttemptAt: number;
      nextAttemptAt: number | null;
      sample: ServiceQuotaSample;
      error: ServiceQuotaReadError;
    }
  | {
      status: "stale";
      staleReason: "expired";
      lastAttemptAt: number;
      nextAttemptAt: number;
      sample: ServiceQuotaSample;
      error: null;
    }
  | {
      status: "error";
      lastAttemptAt: number;
      nextAttemptAt: number | null;
      sample: null;
      error: ServiceQuotaReadError;
    }
);

// Addition to StateResponse:
// serviceQuotas?: readonly ServiceQuotaSourceState[];
```

A self-hosted board publishes every configured source in configuration order.
An empty array means that no source exists.
A source without usable credentials remains visible as `unconfigured`.
Old clients can ignore the field.
New clients treat its absence as no external source data.

`GET /api/state` retains its existing access rules.
On non-hosted boards, trusted direct-loopback requests need no session or API key.
Public-host and non-loopback requests need a valid session or matching API key.
Hosted requests use the existing signed-identity wall.
This change adds no public route, provider proxy, or push endpoint.

Production clients poll `/api/state` every five seconds, and `/api/ws` returns `404`.
Outside production, enabled WebSocket clients receive the same cached state through the shared builder.
Pass `serviceQuotas` through application state to `SystemBar`.
Keep the existing model quota context model-only.

Hosted responses omit `serviceQuotas` before serialization.
Hosted boards start no service quota reads.
A UI-only visibility check does not satisfy this boundary.
Do not copy the legacy model sampler's lack of a hosted guard.

### Source-state invariants

| Status | Meaning |
| --- | --- |
| `unconfigured` | Configuration is missing or invalid. No sample, completed attempt, or request times exist. A configuration error exists. No request starts. |
| `pending` | Configuration is valid, but no completed attempt, sample, or error exists. The first read is due, queued, or active. |
| `ok` | A valid sample and successful completed attempt exist. No error exists. The sample is younger than five minutes. |
| `stale`, `refresh_error` | A prior valid sample and explicit read error exist. The last completed refresh failed. |
| `stale`, `expired` | A prior valid sample exists without an error. Its five-minute freshness period expired. |
| `error` | A completed read failed. An explicit read error exists, but no sample exists. |

Each status describes the cache at state-build time.
Consumers also apply the age rule to older frames.
All non-null `observedAt`, `lastAttemptAt`, `nextAttemptAt`, `retryAfterAt`, and metric timestamps use integer epoch milliseconds.

`lastAttemptAt` is the completion time of the last provider attempt.
`sample.observedAt` is the completion time of the last successful validated read.
Neither claims to be a provider measurement time.
An `ok` sample has equal `observedAt` and `lastAttemptAt` values.
A failed refresh preserves the original `observedAt` and sets `lastAttemptAt` to its own completion time.

`nextAttemptAt` is the earliest eligibility time for another read, not a freshness deadline or exact start time.
A first read retains that time while queued or active.
An active refresh retains its prior state until completion, except that freshness can expire.
The per-source concurrency guard prevents another request during that refresh.
Publish the expired transition at the next due check, even when a request remains active.

The UI shows the sample age from `observedAt` and treats samples at the five-minute freshness boundary as stale.
An authentication failure sets `nextAttemptAt` to `null` in `stale` or `error`.
Other read failures retain a numeric retry deadline.
Configuration errors belong only to `unconfigured`, never to adapter read results.

A failure never replaces a balance with zero.
Show the source error and the age of any stale sample.
An expired sample without a read error shows its age without an invented error.
A prior refresh error remains explicit after freshness expires.

### Account isolation and rebind

The cache exists only in server memory.
A restart begins without a sample.
Every configuration change or explicit rebind clears the old sample before credential resolution or replacement reader creation.
It also clears old errors and request times and creates a new private source revision.
Each revision comes from a server-monotonic counter, never a credential hash or token-derived marker.
The counter does not reset when a source ID disappears and later returns.

A valid replacement enters `pending` with a new reader.
An invalid replacement enters `unconfigured` without a reader.
A `401` or `403` pause ends only after rebind or server restart.
Configuration changes use the same rebind path.

Each attempt captures its reader binding and private revision before the request starts.
Abort an old request when its source changes or disappears.
Do not rely on abort alone.
Publish a result only when the source still exists and both captured values match the active source.
Apply this check to successes, failures, adapter exceptions, and removed then re-added source IDs.

Never serialize credentials, `credentialEnv`, or private revisions into board state, WebSocket state, logs, or adapter errors.
These rules prevent data from one account from appearing under another account.

## Transport, refresh, and failure policy

| Policy | Requirement |
| --- | --- |
| First read | Start after valid configuration becomes available. Never block a board-state response. |
| Normal interval | Five minutes after the previous attempt completes. |
| Freshness | Five minutes after `sample.observedAt`, regardless of a later retry delay. |
| Concurrency | One active request per source and at most four service requests across the board. |
| Request deadline | Ten seconds for headers and body combined. |
| Response budget | At most 64 KiB of decoded bytes, including streamed bodies. |
| Normalized output | Reject more than 32 metrics or any display string above 256 code units. Never silently shorten stored values. |
| Redirects | Reject redirects. Never forward a bearer token to another URL. |
| Ordinary retry | Wait at least five minutes after a failed attempt. Never retry immediately. |
| `429` | Honor a valid `Retry-After` value when it requires a longer wait. |
| `401` or `403` | Show `authentication`, set `nextAttemptAt` to `null`, and pause automatic reads until rebind or restart. |
| Missing secret | Publish `unconfigured` and make no request. |
| Disabled or removed source | Stop new reads and omit the source from published state. |

HTTP-date forms of `Retry-After` use GMT, including the `asctime` form without an explicit zone.
The server's local time zone does not change the retry deadline.

The response budget is an Ottr safety limit, not a documented PixelLab maximum.
A slow or failed service must not block another source, the model refresh, or the state response.
Each completed source update uses the existing state publication path.
Return safe error codes instead of raw provider bodies.
An unexpected adapter exception produces a visible `internal` error.
Logs contain neither credentials nor unsanitized provider text.

## PixelLab v2 reader

### Request

```http
GET https://api.pixellab.ai/v2/balance
Authorization: Bearer <resolved server secret>
Accept: application/json
```

The header describes a resolved secret, not a literal credential.
The request has no body or query parameters.
The OpenAPI server base is `/v2`, and the operation requires HTTP bearer authentication. [P2][pixellab-v2]
Use v2 explicitly, without a fallback to v1.
The v1 endpoint has a root `usd` value, not the v2 subscription envelope. [P3][pixellab-v1]
Both published schemas label their version `dev`, not a stability guarantee.

### Fixture and exact mapping

This fixture uses documented example values without the optional `subscription.type` field.
It is a schema fixture, not a live account response. [P2][pixellab-v2]

```json
{
  "credits": {
    "type": "usd",
    "usd": 10.5
  },
  "subscription": {
    "status": "active",
    "plan": "Tier 2: Pixel Artisan",
    "generations": 450,
    "total": 2000
  }
}
```

| Input | Normalized output | Constraint |
| --- | --- | --- |
| `credits.usd` | Balance `usd-credits`, currency `USD`, `remaining: 10.5` | Required finite number. No numeric minimum. |
| `credits.type` | Unit validation | Optional. If present, require `usd`. |
| `subscription.generations` | Balance `subscription-generations`, count `generations`, `remaining: 450` | Required finite number, not necessarily an integer. |
| `subscription.total` | `reportedTotal: 2000` for that balance | Required finite number. Do not derive a used percentage. |
| `subscription.status` | `providerStatus: "active"` | Required string, without an enum constraint. |
| `subscription.plan` | `plan: "Tier 2: Pixel Artisan"` | Optional string or `null`. Normalize absence to `null`. |
| `subscription.type` | Unit validation | Accept absence. If present, require `generations`. |
| No USD total | `reportedTotal: null` for USD credits | Never infer a total from the balance. |
| No USD status or plan | `providerStatus: null`, `plan: null` for USD credits | Keep subscription labels on the subscription balance. |
| No reset fields | `resetsAt: null` for both balances | Never infer a date from a plan or status. |
| Adapter completion | `sample.observedAt` | Local completion time, not a PixelLab timestamp. |

`BalanceResponse` requires both `credits` and `subscription` objects.
`Credits` requires `usd`.
`Subscription` requires `status`, `generations`, and `total`.
The schemas allow additional properties.
Extract known fields and ignore extra fields. [P2][pixellab-v2]

The status description names `active`, `trial`, `expired`, `none`, and `enterprise`.
An unknown status remains display text, not a validation failure or execution rule.
Zero, signed, and fractional balances remain valid.
An expired subscription does not establish that USD credits are unusable.

The overview shows these separate values:

- USD credits: `10.5 USD remaining`.
- Subscription generations: `450 remaining; provider total 2000`.
- Subscription labels: `active` and `Tier 2: Pixel Artisan`.
- Reset: unknown for both rows.

Never combine the balances.
Do not claim an exchange rate, task budget, credit lifetime, or billing priority.
The sources establish none of these facts.

### Response and error handling

`GET /balance` documents only `200` and `401`.
The `401` description is `Invalid API token`, without an error-body schema. [P2][pixellab-v2]
The policy for `403`, `429`, network failures, and `5xx` is an Ottr requirement, not a documented PixelLab response guarantee.
Generation endpoint errors and job-poll intervals do not establish this balance contract.

| Input or failure | Result |
| --- | --- |
| Valid documented envelope | Publish two fresh balance metrics. |
| Optional discriminator or plan absent | Accept the response and preserve required numbers. |
| Unknown fields or subscription status | Ignore extra fields and preserve status as text. |
| Required field absent, wrong type, or non-finite number | Return `invalid_response` for the whole source. |
| Either component invalid | Reject the whole response. Retain a previous whole sample as stale, or publish an error without a sample. |
| Network failure, timeout, or server error | Preserve previous data only as stale. |
| `401` | Show an authentication error and pause automatic reads until rebind or restart. |
| Undocumented HTTP error | Record the HTTP status and a safe error code. Do not assume an error envelope. |

The sources establish no balance-specific rate limit, cache headers, refresh interval, period dates, rollover rules, reserved credits, or used-percentage semantics.
These gaps permit raw balance display, but not reset countdowns, credit-to-task estimates, or automatic execution decisions.

## Z.AI coding plan reader

The endpoints are not in Z.ai's public API reference.
They are the JSON endpoints that the GLM coding-plan usage page calls.
Public client implementations document them. [P3][zai-endpoints]

### Request

The source makes two sequential bounded GETs.
Each request carries the headers below and has no body.

```http
GET https://api.z.ai/api/monitor/usage/quota/limit
Authorization: Bearer <resolved server secret>
Accept: application/json
```

```http
GET https://api.z.ai/api/biz/customer-package-reset/list?targetType=PERSONAL
Authorization: Bearer <resolved server secret>
Accept: application/json
```

A failure on the first endpoint stops before the second request.
Either failure rejects the whole source snapshot.

### Fixture and exact mapping

These fixtures use invented example values with the documented envelope shapes.
Public client demo data supplies the shapes, not the values.
They are schema fixtures, not live account responses. [P3][zai-endpoints]

```json
{
  "code": 200,
  "msg": "Operation successful",
  "success": true,
  "data": {
    "level": "PRO",
    "limits": [
      {
        "type": "TOKENS_LIMIT",
        "unit": 3,
        "percentage": 100,
        "nextResetTime": 1764578800000
      },
      {
        "type": "TOKENS_LIMIT",
        "unit": 6,
        "percentage": 8,
        "nextResetTime": 1765000000000
      },
      {
        "type": "TIME_LIMIT",
        "unit": 5,
        "percentage": 45,
        "currentValue": 1828,
        "usage": 4000,
        "usageDetails": []
      }
    ]
  }
}
```

```json
{
  "code": 200,
  "success": true,
  "data": {
    "customerId": 41002358991004410,
    "targetType": "PERSONAL",
    "organizationId": null,
    "projectId": null,
    "lastFiveHourResetTime": "2026-11-22 10:00:00",
    "lastWeekResetTime": "2026-11-19 17:54:00",
    "fiveHourResets": [],
    "weekResets": [
      {
        "recordId": 920001,
        "expireTime": "2026-12-07 23:59:59",
        "available": true
      }
    ]
  }
}
```

| Input | Normalized output | Constraint |
| --- | --- | --- |
| `data.limits` first `TOKENS_LIMIT` with `unit 3` | Five-hour reset source | Other entries, including `TIME_LIMIT`, are ignored. |
| `data.limits` `TOKENS_LIMIT` with `unit 6` | Weekly reset source | One entry per unit. |
| `nextResetTime` | `resetsAt` in epoch milliseconds | Required finite safe integer when present. Absent falls back to the reset list. |
| Absent `nextResetTime` | `lastFiveHourResetTime + 5 hours`, `lastWeekResetTime + 7 days`, published only while still in the future; a stale result becomes `resetsAt: null` | The stamps are UTC+8 wall clock, parsed with a fixed +08:00 offset. |
| Both reset sources absent | `resetsAt: null` | Never publish an invented or past date. |
| `weekResets` entries with `available: true` | Unused weekly reset grant count | Entries with `available: false` do not count. |
| Empty `fiveHourResets` | Grant count `0` | This remains a valid snapshot. |
| `expireTime` on each grant entry | Validation only | Required UTC+8 stamp. A malformed stamp rejects the whole response. |
| `data.targetType` | Validation only | Must be `PERSONAL`. Any other value rejects the whole response. |
| `success: false` under HTTP 200 | Business error | Reject the response as `invalid_response`. |
| `percentage`, `usage`, `usageDetails`, `recordId`, `customerId`, `msg`, `level` | Ignored | Extract known fields only. |
| Both sources valid | Balance rows `five-hour-window` and `weekly-window` | Labels `5-hour window` and `Weekly window`, unit `{ kind: "count", name: "unused reset grants" }`, `remaining` = grant count, `resetsAt` per the rules above, other balance fields `null`. |

### Response and error handling

The endpoints have no published error schema.
The failure classes below are Ottr policy, not documented Z.AI guarantees. [P3][zai-faq]

| Input or failure | Result |
| --- | --- |
| Valid envelopes | Publish the two balance rows. |
| Missing or wrong-typed required field, or malformed stamp | Return `invalid_response` for the whole source. |
| `401` or `403` | Show `authentication` and pause automatic reads until rebind or restart. |
| `429` | Show `rate_limit` and honor a valid `Retry-After`. |
| Other HTTP errors | Record the HTTP status as `http`. |
| Network failure or timeout | Apply the transport policy. |
| Derived fallback stamp older than now | `resetsAt: null` | Never publish a past reset date. |
| First-endpoint failure | Never issue the second request. |
| Any failure | Never replace grant counts with invented values. |

## Security boundary

- Keep credentials outside source code and documentation.
- Resolve credentials only inside the board server.
- Never use project Env values that the board lends to workers.
- Never expose credential values or references in board state, browser bundles, worker environments, or logs.
- Bind each adapter to a fixed HTTPS origin and path.
- Keep normal TLS certificate checks.
- Reject arbitrary base URLs and redirects.
- Use read-only provider methods.
- Validate provider JSON before cache replacement.
- Extract known fields instead of merging arbitrary provider objects.
- Render provider labels as text, never HTML.
- Return safe source errors, not provider response bodies.
- Omit external account data from hosted responses.

The environment reference avoids a new plaintext credential field.
The no-hardcoded-credentials rule prevents secret disclosure through source code, fixtures, and reports.
This specification needs no credential read or authenticated provider call.
An approved server secret source remains a prerequisite for live activation, not for offline implementation.

## Acceptance checks

1. A real reader issues exactly `GET https://api.pixellab.ai/v2/balance` through an instrumented HTTP transport.
   Verify bearer authentication, no request body, and no generation request.
2. The fixture produces two separate balances with `10.5 USD`, `450` generations, and a reported total of `2000`.
   Neither row invents a reset or used percentage.
3. Schema-valid omission of optional fields succeeds.
   A `null` plan and unknown status remain valid.
   Fractional `generations` and `total` values retain their values.
   A zero total remains zero, not `null`.
   `generations > total` remains valid without a percentage calculation.
   Signed numeric balances retain their values.
4. Missing required fields, string numbers, malformed JSON, oversized bodies, and mismatched present discriminators produce explicit errors.
   A display string above 256 code units rejects the source.
   These failures never replace a successful sample with zero balances.
5. Start a sequence with a successful read, then apply each failure class.
   Both mixed-validity cases reject the whole source: valid credits with invalid subscription, and invalid credits with valid subscription.
   Neither case publishes fresh data beside old data within one source.
   The previous whole sample retains its timestamp and appears as stale.
   A first-read failure appears as an error without a sample.
6. Concurrent overview requests cause no duplicate reads.
   A slow service delays neither the state response nor another source.
   No source refreshes before its interval or valid retry deadline.
   A cached sample becomes stale after five minutes, even while a refresh remains active.
7. A source rebind or configuration change clears the old sample before replacement reader creation.
   Startup and explicit rebind read server environment values.
   An external environment change requires a server restart.
   A `401` or `403` pause retains `nextAttemptAt: null` until rebind or restart.

   A transport that ignores abort cannot publish a late success, failure, or exception from the previous binding and revision.
   Removal and later addition of the same source ID cannot admit a result from the removed source.
   Private revisions increase independently of credential contents and never appear in published state.
   Neither credential references nor values appear in published state, logs, or errors.
8. Two accounts for one adapter receive separate factory calls and distinct readers with their own bound credentials.
   Their source IDs, samples, request times, schedules, and errors remain independent.
   Each reader uses only its own account credential and the fixed provider endpoint.
   One source failure hides neither another source nor omp quotas.

   Duplicate source IDs produce configuration errors without a reader.
   Duplicate metric IDs reject the whole snapshot as `invalid_response`.
   Equal account or metric labels never merge distinct IDs.
9. Synthetic time windows cover known and unknown reset dates, zero limits, usage above the limit, and invalid timestamp order.
   Property tests verify finite numbers, explicit unknowns, and stable units at the provider boundary.
10. External balances cannot change `tightestFor`, `forModel`, `usageReset`, or hold release behavior.
    This holds when an external label matches a model provider or the default model has no quota data.
11. Hosted `GET /api/state` omits `serviceQuotas`.
    A configured hosted board makes no external service quota request.
    Production `/api/ws` returns `404`.
    A non-production hosted setup checks WebSocket omission when that route is enabled.
12. The overview shows model quotas and external sources together, with distinct units, source errors, and stale ages.
    Keyboard access, text alternatives, and existing model sign-in controls remain intact.
13. Redirect and logging checks prove that no credential reaches another origin, board state, a worker, or captured logs.
    A missing secret produces zero outbound requests.
14. A real Z.AI reader issues exactly the two GETs in the request section through an instrumented transport.
    Verify bearer authentication and no request body.
    The documented fixture yields the 5-hour reset time, the weekly reset time, and one unused weekly reset grant.
    The empty `fiveHourResets` case stays a valid snapshot.
15. A failing first endpoint stops before the second request.
    Either endpoint's failure rejects the whole source.
    A `TEAM` target type or a malformed stamp rejects as `invalid_response`.
    No invented reset date appears when both reset sources are absent, or when a derived fallback stamp is already in the past.

Transport checks require an isolated local listener and the exact production-URL assertion.
Exercise the real HTTP reader, not only a mocked adapter result.
Fixtures follow the published envelope, not an assumed root balance field.

## Implementation ownership and dependencies

| Recommended step | Owner and scope | Dependency |
| --- | --- | --- |
| 1 | OTTR-1101 owns this implementation specification only. Runtime code remains pending. | OTTR-1092 research report. |
| 2 | OTTR-1103 owns both shared TypeScript contracts, bounded transport, validation, registry integration, and the independent coordinator and cache. | Step 1. |
| 3 | OTTR-1106 owns the real PixelLab v2 adapter, exact schema decoder, and provider-specific tests. | Step 2 contracts and bounded transport. |
| 4 | OTTR-1105 owns server tick integration, shared state publication, hosted omission, and balance-aware overview rows. | Step 2 contracts and cache. |
| 5 | OTTR-1107 owns all acceptance evidence and approved live-read validation. | Steps 3 and 4. |

Step 2 exposes the contracts above for both downstream cards.
Its coordinator accepts the internal source list and trusted registry and supplies cached source state without provider I/O during state reads.
Its lifecycle owns due checks, rebind, removal, and the account-isolation rules above.
Step 3 supplies an adapter definition through that registry.
Step 4 consumes the cache and shared types without PixelLab-specific state logic.
Steps 3 and 4 can therefore run in parallel after step 2.

### Step 2 exports

`src/types.ts` exports all named types in the two contract blocks above.
It adds the optional `StateResponse.serviceQuotas` field, without runtime state integration.
Source configuration and reader types are server-only contracts, not serialized state.

`src/serviceQuotas.ts` exports these functions and types:

- `validateServiceQuotaMetrics(input: unknown, previous?: readonly ServiceQuotaMetric[]): readonly ServiceQuotaMetric[] | null`.
  It returns a detached snapshot of known fields, or `null` for an invalid snapshot.
  The coordinator retains each metric ID's unit across successful samples in one source binding, including samples that omit that ID.
  It retains unit history only, not earlier metric values.
  Rebind clears that history.
- `ServiceQuotaCoordinatorOptions` contains `sources`, `registry`, and `resolveCredential`.
  `sources` is a readonly source configuration list.
  `registry` is a `ReadonlyMap<string, ServiceQuotaAdapterDefinition>`.
  `resolveCredential(reference: string): string | undefined` reads server-only secret input.
  Optional `now(): number` supplies the clock, and optional `onChange(): void` publishes cache changes.
- `createServiceQuotaCoordinator(options: ServiceQuotaCoordinatorOptions): ServiceQuotaCoordinator`.
  Construction resolves source bindings but starts no requests.
- `ServiceQuotaCoordinator.getState(): readonly ServiceQuotaSourceState[]` returns detached cached state without provider I/O.
  It applies the sample age rule at read time.
- `ServiceQuotaCoordinator.checkDue(): void` starts eligible reads without awaiting them.
  Completion starts queued eligible sources within the four-request limit.
  Each due check also publishes any freshness transition.
- `ServiceQuotaCoordinator.setSources(sources: readonly ServiceQuotaSourceConfig[]): void` replaces the ordered configuration list.
  Unchanged bindings retain state.
  Changed, added, and duplicate bindings use the rebind rules.
  Each duplicate ID appears once as `unconfigured`, at its first position.
  All duplicate IDs are detected before credential resolution or reader creation.
- `ServiceQuotaCoordinator.rebind(source: ServiceQuotaSourceConfig): void` replaces or adds one binding, even when its configuration is unchanged.
- `ServiceQuotaCoordinator.remove(id: string): void` removes one binding and aborts its active attempt.
- `ServiceQuotaCoordinator.dispose(): void` permanently stops reads, aborts attempts, and clears cached state.
  Later lifecycle calls do nothing.
  A new coordinator represents a server restart.

An obsolete attempt retains its concurrency slot until it settles.
An ignored abort cannot permit more than four outstanding reads or two outstanding reads for the same source ID.
Rebind clears public state before it calls the resolver or reader factory.
The coordinator never reads ambient environment values itself.
Resolver and reader-factory exceptions produce `unconfigured`, because no provider attempt completed.
Missing adapters, blank credentials, and credentials with control characters also produce `unconfigured`.
An invalid source label produces a configuration error and the fixed label `Invalid source label`.
Source IDs and adapter IDs retain their identity.
Publication callback failures produce a fixed diagnostic without exception details.

`src/serviceQuotaHttp.ts` exports `createServiceQuotaHttpReader(options: ServiceQuotaHttpReaderOptions): ServiceQuotaReader`.
`ServiceQuotaHttpReaderOptions` contains `endpoint: string`, `credential: string`, and `decode(body: unknown): unknown`.
The trusted adapter supplies the fixed endpoint and bound credential.
The decoder returns normalized metrics or `null` for an invalid provider response.
The reader validates decoded metrics and returns only the specified read-result union.
The reader sends GET with bearer authorization and `Accept: application/json`.
It accepts HTTPS endpoints without URL credentials or fragments.
Source configuration cannot supply an endpoint.
Optional `fetch?: typeof globalThis.fetch` and `now?: () => number` dependencies support isolated transport tests.
The injected fetch can route the fixed HTTPS request to a local fixture listener.
Production callers omit those dependencies.
No transport option changes the ten-second deadline or 64-KiB response limit.
The transport catches decoder exceptions as `internal` and never publishes exception text.

Step 2 tests use generated, harmless credential values.
They require no real credential, provider account, or approved secret name.
The README needs no setup change because this step does not activate the feature.

Step 4 connects the cache to the shared state builder and independent boot and 30-second due checks.
The overview separates service balances and windows from model quotas.
The production source list and adapter registry remain empty.
No server secret source is approved, so this step enables no live provider reads.
Tests supply isolated readers and generated credentials through the internal dependency.
Hosted boards neither create readers nor serialize service state.

### Step 3 exports and assumptions

`src/serviceQuotaPixellab.ts` exports `createPixellabQuotaAdapter(options?: Pick<ServiceQuotaHttpReaderOptions, "fetch" | "now">): ServiceQuotaAdapterDefinition`.
The adapter ID is `pixellab-v2`.
Each `createReader({ credential })` call creates a fresh `createServiceQuotaHttpReader` with that credential and exactly `https://api.pixellab.ai/v2/balance`.
The adapter accepts no endpoint option.
The optional dependencies support tests only. Production callers omit them.
The decoder remains private and extracts only the fields in the exact mapping above.
It rejects the whole envelope when either required component is invalid.
The shared HTTP reader validates normalized metrics and retains its existing response limits, deadline, and safe errors.

The metric IDs are `usd-credits` and `subscription-generations`.
Their labels are `USD credits` and `Subscription generations`.
Their units are `{ kind: "currency", code: "USD" }` and `{ kind: "count", name: "generations" }`.

`src/serviceQuotaRegistry.ts` exports `builtInServiceQuotaAdapters: ReadonlyMap<string, ServiceQuotaAdapterDefinition>`.
It contains the real PixelLab adapter under `pixellab-v2` and the Z.AI coding-plan adapter under `zai-coding-plan`.
This separate server-only module avoids a circular dependency between the transport and coordinator.
Registry creation starts no requests and activates no sources.
Server credential resolution remains external to the adapter and registry.
Step 3 adds no runtime state or UI integration, credential source, live activation, or authenticated provider call.
The README remains unchanged because no feature becomes active.
The step 5 acceptance checks and both live-read approvals below remain prerequisites.

### Z.AI coding-plan exports

`src/serviceQuotaZai.ts` exports `createZaiQuotaAdapter(options?: Pick<ServiceQuotaHttpReaderOptions, "fetch" | "now">): ServiceQuotaAdapterDefinition`.
The adapter ID is `zai-coding-plan`.
Each `createReader({ credential })` call creates two `createServiceQuotaHttpReader` instances with that credential and exactly the two fixed URLs in the request section above.
The adapter accepts no endpoint option.
The optional dependencies support tests only. Production callers omit them.
The decoders remain private and extract only the fields in the exact mapping above.

The adapter adds no live activation.
The production source list stays empty and the README remains unchanged.

Step 5 executes all acceptance checks before any live balance read.
A live read also requires approval for the server secret source and the authenticated read itself.
Do not fetch credentials or call the authenticated endpoint as part of this specification task.

## Verification commands

Run these commands from the worktree root for the implementation checks:

```sh
bun install --frozen-lockfile
bun run check
bun test
```

The public-schema smoke below checks the two TypeScript blocks, fixture fields, v2 base, bearer requirement, and documented response codes.
It reads only this file and public documentation.
It neither implements the adapter nor calls the authenticated balance endpoint.
A provider schema change can fail this check and needs review before any contract update.

```sh
bun --eval '
const assert = (await import("node:assert/strict")).default;
const spec = await Bun.file("docs/specs/service-quotas.md").text();
const contracts = [...spec.matchAll(/```ts\n([\s\S]*?)```/g)];
assert.equal(contracts.length, 2);
for (const block of contracts) new Bun.Transpiler({ loader: "ts" }).transformSync(block[1]);
const fixture = JSON.parse(spec.match(/```json\n([\s\S]*?)```/)[1]);
const response = await fetch("https://api.pixellab.ai/v2/openapi.json", {
  redirect: "error", signal: AbortSignal.timeout(20000)
});
assert.equal(response.status, 200);
const api = await response.json();
const op = api.paths["/balance"].get;
assert.equal(api.servers[0].url, "/v2");
assert.ok(op.security.some(s => "HTTPBearer" in s));
assert.deepEqual(Object.keys(op.responses).sort(), ["200", "401"]);
for (const [name, value] of [
  ["BalanceResponse", fixture], ["Credits", fixture.credits],
  ["Subscription", fixture.subscription]
]) {
  const schema = api.components.schemas[name];
  for (const key of schema.required) assert.ok(Object.hasOwn(value, key));
}
for (const number of [
  fixture.credits.usd, fixture.subscription.generations, fixture.subscription.total
]) assert.ok(typeof number === "number" && Number.isFinite(number));
assert.equal(fixture.credits.usd, 10.5);
assert.equal(fixture.subscription.generations, 450);
assert.equal(fixture.subscription.total, 2000);
console.log("PASS: " + contracts.length + " TypeScript contract blocks parse");
console.log("PASS: v2 GET balance path, bearer auth, and documented 200/401 responses");
console.log("PASS: example required fields and balances: USD 10.5; generations 450; reported total 2000");
'
```

These commands are instructions, not evidence of a run from this specification task.
The public schema smoke does not prove real account behavior or full decoder validation.
Work turns skip mutation tests under the repository policy.
The later acceptance card supplies runtime, transport, and rendered UI evidence.

## Non-goals

- Runtime code, adapter stubs, dependency changes, or configuration changes in the specification task.
- Changes to model provider collection or existing scheduler holds.
- Service-based task holds, automatic task retries, or model selection changes.
- Generation calls, credit purchases, spend estimates, or balance reservations.
- A public ingestion endpoint, provider proxy, manual entry flow, or arbitrary executable plugins.
- A new credential store, configuration UI, database migration, or account-login flow.
- A visual redesign of the overview.

Later cards implement the runtime behavior in this specification.
The earlier research-only implementation and commit restriction does not prohibit that work.

## Sources

- [PixelLab API product page][pixellab-page], P1. Official v2 documentation link and separate credits and generations presentation.
- [PixelLab v2 OpenAPI][pixellab-v2], P2. Server base, balance operation, bearer security, `BalanceResponse`, `Credits`, and `Subscription`.
- [PixelLab v1 OpenAPI][pixellab-v1], P3. Balance operation and `CreditsResponse`, for the explicit no-fallback boundary.
- [PixelLab v2 documentation][pixellab-docs], P4. Official interactive API reference.
- The OTTR-1092 research report in the OTTR-1101 handoff supplies the approved scope and policy requirements.
- [Community-documented Z.AI coding-plan endpoints][zai-endpoints], P3. The subscription UI endpoints as documented by public usage clients.
- [Z.AI devpack FAQ on quota reset cards][zai-faq], P3. Quota reset card behavior.
- The LogicIncZo/zai-usage demo fixtures supply the reset-list envelope shapes; the fixture values are invented. [P3][zai-usage]
- Repository integration links above name the source files without historical line-number claims.

[pixellab-page]: https://www.pixellab.ai/pixellab-api
[pixellab-v2]: https://api.pixellab.ai/v2/openapi.json
[pixellab-v1]: https://api.pixellab.ai/v1/openapi.json
[pixellab-docs]: https://api.pixellab.ai/v2/docs
[zai-endpoints]: https://github.com/slvnlrt/usage-tray-windows/blob/main/docs/providers/zai.md
[zai-usage]: https://github.com/LogicIncZo/zai-usage
[zai-faq]: https://docs.z.ai/devpack/faq
