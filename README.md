# github-core-remixco

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/remixco7/github-core-remixco/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/remixco7/github-core-remixco/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A small, dependency-free, in-memory GitHub-compatible git forge, written for
the make.fun `github-core-clone-01` bounty. One process, Node 22+, no disk
writes, no network beyond the trial environment.

## What it serves

- **Git smart HTTP** (protocol v2 and v0): `info/refs`, `ls-refs`, `fetch`
  (including shallow/deepen and incremental fetches), `receive-pack` with
  fast-forward checks and per-ref `report-status`.
- **REST v3** under `/api/v3`: repositories, branches, commits, contents,
  git refs, labels, issues, comments, pull requests and squash merges with
  conflict detection.
- **GraphQL v4** at `/api/graphql`: repository/issue/pull-request queries and
  mutations, `__type` introspection, Relay global ids, cursor pagination and
  operation batching.
- **MCP** at `/mcp`: the 2026-07-28 `server/discover` era plus the legacy
  `initialize` handshake, with six tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`).

## Run

```
node --experimental-strip-types main.ts
```

`main.ts` is the entry lifecycle (bind an ephemeral port, register with
`$MAKEFUN_ENV_URL`, poll `/done`); `app.ts` is the server. The server reads
its auth credential from `MAKEFUN_SHOP_TOKEN` and its only clock from
`MAKEFUN_TRIAL_NOW`; all state lives in memory and is deterministic per run.

## License

MIT.
