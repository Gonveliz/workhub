---
name: workhub-analytics
description: Answer questions about the user's own agent usage from Workhub's usage database, read-only, from inside a Workhub session: dollars and tokens spent, agent time, per project, ticket, pull request, tag, agent, model or week; which sessions touched a PR or ticket; automation failures; PR and ticket timelines. Trigger: "how much did I spend on", "how much time on", "weekly report", "what did I work on this week", "which sessions touched this PR", "cost per ticket", "usage report", "cuánto gasté en", "cuánto tiempo le dediqué", "reporte semanal", "en qué trabajé esta semana", "qué sesiones tocaron el PR".
---

# Workhub analytics

Workhub records every agent session it knows (opened in Workhub or found in a transcript), each
assistant turn with its tokens, cost and agent time, what each session was linked to (pull
requests, tickets, branches, tags), every automation run and the PR and ticket timelines, in its
SQLite file on the user's computer. Inside a Workhub session you can read them, **read-only**,
through the local control endpoint. Full reference: "Ask your agent about your usage" in
`docs/user-guide/usage.md` of the Workhub repository.

## When to use

- The user asks how much they spent, or how much agent time went, on a project, ticket, PR, tag,
  agent, model or period.
- The user asks for a weekly (or monthly) report of what they worked on.
- The user asks which sessions worked on a pull request or ticket, or what happened to one.
- The user asks why or how often an automation failed.

## Before calling

Use the `workhub` MCP tools when they are available: `usage_report` (spend and weekly summaries),
`analytics_schema` (tables, columns, examples) and `analytics_query` (one SQL query). Without them,
the session environment has `WORKHUB_SESSION`, `WORKHUB_SESSION_TOKEN` (this session's own token,
sent as `X-Workhub-Token` on every call; analytics answer `401` without it) and either
`WORKHUB_SOCKET` (macOS, Linux) or `WORKHUB_URL` and `WORKHUB_TOKEN` (Windows). With none of them
you are not in a Workhub session: say so and stop; do not look for the database file. Never print, log or pass on `WORKHUB_SESSION_TOKEN`; send it only in that header.

```sh
W() {
  local t=(-H "X-Workhub-Token: $WORKHUB_SESSION_TOKEN") # this session's own token, on every call
  if [ -n "$WORKHUB_URL" ]; then # Windows: a loopback port and the launch token on top
    local a=() x; for x in "$@"; do a+=("${x/http:\/\/workhub/$WORKHUB_URL}"); done
    curl -s -H "Authorization: Bearer $WORKHUB_TOKEN" "${t[@]}" "${a[@]}"
  else curl -s --unix-socket "$WORKHUB_SOCKET" "${t[@]}" "$@"; fi
}
S="session=$WORKHUB_SESSION"
```

A query through `curl`, with a heredoc so quotes in the SQL need no escaping:

```sh
W -X POST http://workhub/v1/analytics/query -H 'content-type: application/json' -d @- <<EOF
{"session": "$WORKHUB_SESSION", "sql": "SELECT model, ROUND(TOTAL(usd), 2) AS usd FROM turns WHERE session_id = ? GROUP BY model", "params": ["<session id>"]}
EOF
```

Every answer is JSON with `ok`; `ok: false` carries `error` (for a refused query, the reason).

## Endpoints

| Tool | Call | What it does |
|---|---|---|
| `usage_report` | `W "http://workhub/v1/analytics/report?$S&kind=spend_by_project"` | `kind`: `spend_by_project`, `spend_by_ticket`, `spend_by_tag`, `spend_by_agent` or `weekly`. `since`, `until`: ISO date (`2026-11-01`) or date-time, or epoch ms (13 digits); default the last 30 days. `bucket` (`day`, `week`), filters `tag`, `folder`, `pr`, `ticket`, `model`, `agent`, and `profile` (`current`, the default; `all`; or a profile id). Answer: `totals` (every turn once), `groups` (per group over the span, with `sessions`) and `rows` (per bucket and group), each with `tokens`; times as epoch ms and ISO (`since`/`sinceIso`, `bucketStart`/`bucketStartIso`); `usd` to 4 decimals. With `groupsOverlap: true` (tickets, tags) a session linked to two groups counts in both, so groups can add up to more than `totals`. `weekly` takes only `since` (any day of the week) and `profile`, and answers `sessions`, `activeMs`, `usd`, `tokens`, `projects`, `prs`, `tickets`, `prsOpened`, `prsMerged`, `prsReviewed`, `ticketMoves`. |
| `analytics_schema` | `W "http://workhub/v1/analytics/schema?$S"` | Tables and columns (type, unit, what null means), how to query, example queries, limits. |
| `analytics_query` | the heredoc above | Body `{"session","sql","params","limit"}`. Answer: `columns`, `rows` (arrays), `rowCount`, `truncated`, `timedOut`, `elapsedMs`. |

Start with `usage_report` when it answers the question; write SQL only for what it does not cover.
Reads are not limited to this session's profile (`usage_report` filters to it by default).

## The tables

- `sessions`: `id`, `agent`, `account_id`, `profile_id`, `cwd`, `work_path`, `project`, `title`,
  `started_at`, `ended_at`, `active_ms`, `last_model`, `source` (`workhub` or `transcript`).
- `turns`: one assistant message: `session_id`, `agent`, `at`, `model`, `input_tokens`,
  `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `usd` (list prices; null when the
  model has no price), `cwd`, `project`, `turn_ms` (agent time), `sidechain` (1 for sub-agents:
  tokens count, `turn_ms` is 0). Only the last 12 months.
- `turns_daily`: turns older than 12 months, summed per local day, session, model, folder and
  project: `day`, `session_id`, `agent`, `model`, `cwd`, `project`, `priced`, `at` (first turn),
  `last_at`, the four token sums, `usd`, `turn_ms` (sub-agents left out) and `turns` (how many).
  For a span reaching past 12 months add it to `turns` with `UNION ALL`, counting `turns` instead
  of rows (`usage_report` already does). `pr_events`, `ticket_events` and `automation_runs` also
  keep 12 months.
- `session_links`: `session_id`, `kind` (`pr`, `ticket`, `branch`, `worktree`), `ref`, `source`,
  `at`. A PR `ref` is the canonical URL in lower case without a trailing slash; a ticket `ref` is
  the key in upper case.
- `session_tags`: `session_id`, `tag` (lower case), `at`.
- `automation_runs`: `automation_id`, `trigger`, `started_at`, `ended_at`, `status` (`ok`, `error`,
  `rateLimited`, `timeout`, `skipped`, `coalesced`, `stopped`), `session_id`, `summary_json` with
  the keys `automationName`, `queuedAt`, `startedAt`, `merged`, `detail`, `triggerLink`, `cost`,
  `tokens`.
- `pr_events`: `repo` (owner/repo, lower case), `number`, `url`, `kind` (`opened`, `reviewed`,
  `approved`, `ciFailed`, `merged`…), `at`, `actor`, `title`. When an event named no repository,
  `repo` holds the URL and `number` is null. `ticket_events`: `key`, `kind` (`status`, `assigned`,
  `left`), `at`, `from_value`, `to_value`, `title`.
- `flow_maps` (`id`, `json`, `updated_at`), `flow_history_measures` and `flow_history_hours`: the
  flow maps and the hourly aggregates of their measures.

Nothing else can be read: not app state (`kv_state`), the transcript scan's bookkeeping
(`turn_files`) nor the History search index (`history_index`).

**Tokens** in `usage_report` answers (`tokens`) are input + output + cache writes, the count Home
and the Usage screen show; cache reads (`cacheRead`, `cache_read_tokens`) are apart. In SQL, sum
`input_tokens + output_tokens + cache_write_tokens` to match it.

A **project** is the deepest project folder of a Workhub profile holding the folder a turn worked
in (a worktree counts for its repository), else the git repository root, else the folder itself.
`cwd`, `work_path` and `project` are folders on the user's computer: show their last part unless
the user wants the path.

Times are **epoch milliseconds**; days, weeks and months are in the computer's local time zone.
**Agent time** (`turn_ms`, `active_ms`) is summed across sessions that ran in parallel, so it can
be more than the hours on the clock. Columns that can be null, and what null means, are listed in
`analytics_schema`. `SELECT name, sql FROM sqlite_master` shows the exact table definitions.

## Example queries

Spend and hours per project, last 30 days (`project`, `usd`, `hours`, `sessions`):

```sql
SELECT COALESCE(project, cwd) AS project, ROUND(TOTAL(usd), 2) AS usd, ROUND(SUM(turn_ms) / 3600000.0, 1) AS hours, COUNT(DISTINCT session_id) AS sessions
FROM turns WHERE at >= strftime('%s', 'now', '-30 days') * 1000
GROUP BY 1 ORDER BY usd DESC LIMIT 20
```

Spend on one ticket, `params: ["ABC-123"]` (`usd`, `hours`, `sessions`):

```sql
SELECT ROUND(TOTAL(t.usd), 2) AS usd, ROUND(SUM(t.turn_ms) / 3600000.0, 1) AS hours, COUNT(DISTINCT t.session_id) AS sessions
FROM turns t JOIN session_links l ON l.session_id = t.session_id
WHERE l.kind = 'ticket' AND l.ref = ?
```

Sessions that worked on a pull request, `params: {"pr": "https://github.com/acme/api/pull/42"}`
(`id`, `agent`, `title`, `started`, `minutes`):

```sql
SELECT s.id, s.agent, s.title, datetime(s.started_at / 1000, 'unixepoch', 'localtime') AS started, ROUND(s.active_ms / 60000.0) AS minutes
FROM sessions s JOIN session_links l ON l.session_id = s.id
WHERE l.kind = 'pr' AND l.ref = :pr ORDER BY s.started_at
```

Sessions for a PR number in any repository, `params: {"n": 42}` (`pr`, `id`, `title`, `minutes`).
Numbers bind as floating point, so cast one before joining it into text:

```sql
SELECT l.ref AS pr, s.id, s.title, ROUND(s.active_ms / 60000.0) AS minutes
FROM sessions s JOIN session_links l ON l.session_id = s.id
WHERE l.kind = 'pr' AND l.ref LIKE '%/pull/' || CAST(:n AS INTEGER) ORDER BY s.started_at
```

Timeline of a pull request with its sessions, `params: ["acme/api", 42]` (`at`, `kind`, `actor`,
`sessions`):

```sql
SELECT datetime(p.at / 1000, 'unixepoch', 'localtime') AS at, p.kind, p.actor, COUNT(DISTINCT l.session_id) AS sessions
FROM pr_events p LEFT JOIN session_links l ON l.kind = 'pr' AND l.ref = lower(p.url)
WHERE p.repo = ? AND p.number = ? GROUP BY p.id ORDER BY p.at
```

Spend per tag (`tag`, `usd`, `sessions`):

```sql
SELECT g.tag, ROUND(TOTAL(t.usd), 2) AS usd, COUNT(DISTINCT t.session_id) AS sessions
FROM turns t JOIN session_tags g ON g.session_id = t.session_id GROUP BY g.tag ORDER BY usd DESC
```

Agent hours and dollars per week, labelled by the week's Monday (`week`, `hours`, `usd`):

```sql
SELECT date(at / 1000, 'unixepoch', 'localtime', '-6 days', 'weekday 1') AS week, ROUND(SUM(turn_ms) / 3600000.0, 1) AS hours, ROUND(TOTAL(usd), 2) AS usd
FROM turns GROUP BY week ORDER BY week DESC LIMIT 12
```

Spend per model this month, from local midnight of the 1st (`model`, `usd`, `tokens_out`):

```sql
SELECT model, ROUND(TOTAL(usd), 2) AS usd, SUM(output_tokens) AS tokens_out
FROM turns WHERE at >= strftime('%s', 'now', 'localtime', 'start of month', 'utc') * 1000
GROUP BY model ORDER BY usd DESC
```

Failed automation runs, last 7 days (`automation`, `status`, `detail`, `started`):

```sql
SELECT json_extract(summary_json, '$.automationName') AS automation, status, json_extract(summary_json, '$.detail') AS detail, datetime(started_at / 1000, 'unixepoch', 'localtime') AS started
FROM automation_runs WHERE status IN ('error', 'timeout') AND started_at >= strftime('%s', 'now', '-7 days') * 1000
ORDER BY started_at DESC
```

## Writing the report

- Answer in the user's language, short: the number they asked for first, then a small table
  (at most 10 rows) and one line on what is counted (span, list prices, agent time).
- Dollars with two decimals; agent time in hours and minutes; dates in the user's local time.
- Say what you could not count: turns without a price (`usd` null, `unpricedTokens` in reports),
  sessions with no link, overlapping groups.
- Do not paste raw rows or full paths unless asked.

## Limits

- **Read-only.** One `SELECT` or `WITH` statement; no `PRAGMA`, `ATTACH` or writes. Values go in
  `params` (`?` or `:name`), never spliced into the SQL text. A keyword used as a column alias must
  be quoted (`AS "commit"`).
- **`truncated`** means you did not get every row: there were more than `limit` (default 500, at
  most 2000). **`timedOut`** means the query ran longer than 5 seconds and was stopped: no rows;
  aggregate or narrow the time range and try again. 20 KB of SQL at most.
- `kv_state` (app state) and `schema_migrations` cannot be read.
- Workhub sends nothing anywhere, but what you read becomes part of this conversation, which goes
  to the agent's provider like any other tool output: read only what the question needs.
