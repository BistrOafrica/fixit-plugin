# Layer · Capacity and growth

The question is not "how fast is it today" but "does it still work at the size it will reach". A system can handle its peak request rate with room to spare and still be **not fit as built**, because an endpoint rescans all history on every request. Throughput tests on an empty database can't see that.

## 1. Demand model (write it down, with the assumptions)
- Population: organisations and users, and submissions per period (monthly, quarterly, annual).
- Concentration: the share of a period's work landing on the deadline day, the share of that day in the peak hour, and the burst factor (for example 30%, 15% and 3×).
- Requests per business action (browse, form, upload, pay, submit, status), giving HTTP req/s at the burst.
- Background readers, such as reviewers refreshing inboxes every N seconds.
- Yearly accumulation: rows added per year to each growing table (history, audit, notifications).

## 2. Measurements
- **Framework baseline:** a trivial endpoint (`/healthz`), which gives the runtime ceiling.
- **Authenticated read and heavy read:** requests per second and p95 on one process.
- **Write path, offered versus achieved:** offer N per second for 20 s each on a clean backlog. Record achieved rate, p50/p95 and drops, and find the knee.
- **Growth curves (the important one, [templates/capacity/growth.ts](templates/capacity/growth.ts)):** seed history at 1×, 3× and 10× (a `--history` seed flag), then measure the hot read paths (inboxes, queues, dashboards, reference-number generation) for one user with nothing else running. Fit latency against row count. **A positive slope means an O(n) path**, so report ms per 1,000 rows and extrapolate to one year's volume.
- **Database view:** `pg_stat_statements` top statements by total time. Many one-row lookups mean N+1; a sequential scan on every write means a high-water-mark or counter problem.
- **Per-request fixed costs:** the auth/role/permission queries on every call, and the fan-out of notification rows per event.

## 3. Verdict format
- Peak demand against measured capacity per workload (use a log-scale bar chart), headroom per process, and the point at which a growth curve crosses the usability limit (e.g. "inboxes pass 2 s after ~5 K items").
- **Fit / fit after fixes / not fit**, naming the fixes, which become findings with severity high when they block rollout.
- Projections to another runtime or framework must be labelled as estimates and cite their source. Algorithms dominate runtimes, because no runtime survives an O(n) scan of millions of rows per request.
- Limits: the machine, single process versus replicas, an empty versus a seeded DB. Recommend a re-measure on production-like hardware with a year of seeded history.
