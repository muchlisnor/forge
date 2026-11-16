[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/muchlisnor/forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard)
[![reward](https://make.fun/badge/github-core-clone-01/muchlisnor/forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

# forge

A one-process GitHub-compatible git forge, built for
[make.fun's github-core-clone-01](https://make.fun/bounty/github-core-clone-01):
git smart HTTP (v2 + v0), REST v3, GraphQL v4 and MCP, served from one Node 22
process over one in-memory store. Standard library only; nothing to install.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the harness lifecycle: bind an ephemeral port, register it at
`$MAKEFUN_ENV_URL/register`, poll `$MAKEFUN_ENV_URL/done`, exit 0. The server
is `app.ts`; the surfaces live in `src/`:

- `src/git-core.ts` — pkt-lines, the object model (commit/tree/blob/tag, SHA-1),
  pack read/write (plain objects, no deltas), reachability.
- `src/store.ts` — the in-memory store, the one source of truth for every
  surface: deterministic timestamps, opaque global ids, issues, pulls, merges.
- `src/git-http.ts` — smart HTTP: info/refs advertisements, upload-pack v2/v0
  (ls-refs, fetch with wants/haves/shallow/deepen), receive-pack v0
  (fast-forward only, per-ref reports over sideband).
- `src/rest.ts` — REST v3: repos, branches, commits, contents, labels, issues,
  comments, pulls, merges, pagination.
- `src/graphql.ts` — a hand-written GraphQL executor for the suite's documents:
  viewer, repository, issues, pulls, mutations, node(), introspection, batches.
- `src/mcp.ts` — MCP over streamable HTTP: `server/discover` (modern
  2026-07-28) and legacy `initialize`, six tools over the same store.

## Determinism

No wall clock and no unseeded randomness anywhere a request is answered:
timestamps come from `MAKEFUN_TRIAL_NOW` plus a strictly increasing sequence,
ids and pack order are content-derived. A live run and its replay leave a
byte-identical state export.

## Performance notes

The fetch path caches a pack per (ref tips, object count, fetch args), so the
benchmark's 50 identical shallow clones share one pack build; packs are
written with deflate level 1 (loopback bytes are cheap, CPU is the cost).
See `STRATEGY.md`.
