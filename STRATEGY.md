# Strategy

## What wins

The reference forge passes all 120 conformance checks, so feature (600) and
agent (200) are table stakes — the prize is decided on perf (200). The four
workloads and the plan for each:

- **push (200 sequential pushes):** at the reference time already. Each push
  is one HTTP round trip plus a pack unpack; there is no per-push work left
  worth cutting, and the client builds the pack, so this workload is close
  to a floor for every entry.
- **clone (50 concurrent shallow clones):** the biggest gap to close. All 50
  clones ask for the same tip at the same depth against an unchanged repo, so
  the fetch response (pack bytes included) is cached per (ref tips, object
  count, fetch args) — one pack build, 49 pointer copies. Packs use deflate
  level 1: bytes over loopback are free, CPU is not.
- **read (2,000 sequential GETs):** one issue, one keep-alive connection.
  The handler is a Map lookup plus one JSON serialization; no per-request
  allocation beyond the response itself.
- **write (200 sequential issue creations):** one insert plus one
  serialization each; the store's sequence and timestamp are arithmetic, not
  clock reads.

## What does not win

- Deltas in packs: the suite's pack-deltas check passes with 0 deltas, and
  plain objects keep both the build and the unpack fast.
- Any shared mutable state beyond the store: the trial is one process, and
  every surface reads the same objects, so MCP/GraphQL/REST parity is free.
- Cleverness in the conformance paths: every check is a contract with an
  exact string (`non-fast-forward`, `report-status`, `delete-refs`) or an
  exact status code; the code answers exactly that and nothing extra.

## Determinism

Timestamps derive from `MAKEFUN_TRIAL_NOW` plus a monotonic sequence;
commit/tag bytes round-trip exactly; pack order is fixed (commits, trees,
tags, blobs, each by oid). Live and replay produce byte-identical exports.
