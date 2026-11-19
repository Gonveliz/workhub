# Flow maps

A flow map is a diagram of one business flow across your services: which service calls which,
which messages cross a queue, where the flow waits. Workhub draws it like an architecture diagram
(lanes, nodes, orthogonal arrows, a replay of the hops) and measures every part from the
environment's APM data: calls, p50, p95, failures, and the same numbers hour by hour, so you see
when each part of the flow got slow.

Nothing about a flow is built into Workhub. A map is a JSON file you (or an agent) write once; the
numbers come from the Health environment you pick.

## Where maps live

In Workhub's database (`workhub.db` in the data folder), one map per `id`. **Settings → Profiles → (profile) → Screens →
Flow maps** (open the row) imports JSON files and lists every stored map (an invalid one is listed
with its error, and can be deleted from there). Maps are read on every refresh, so a new or replaced
map shows up without a restart. Earlier versions read a `flow-maps/` folder; on the first start of this version its maps are
stored in the database and the folder is renamed to `flow-maps.migrated/` (nothing is deleted; when
two files had the same `id`, `<id>.json` wins and the other is left as `.skipped`). Dropping a file in
a `flow-maps/` folder no longer adds a map: import it in Settings or post it with the skill.

**Export.** In the same section, **Export all…** saves every valid map (limits included) to one
JSON file (`{"format": "workhub.flow-maps", "version": 1, "maps": [...]}`), to move them to another
machine or share them; the download icon on a map in the list saves only that map, as a plain map
file. Both import back with **Import JSON…**.

Three ways to add one:

- **Settings → Profiles → (profile) → Screens → Flow maps → Import JSON…** picks one or more files; each is validated and stored
  under its `id` (a map with that `id` is replaced, and the message says how many were). A file can
  be one map or an export of several; a map of an export that does not validate is reported and the
  others still import. You can also drop several JSON files at once on the import area; files that
  are not `.json` are skipped and the message says how many.
- Post it to the local control endpoint from inside a Workhub session (what the
  `workhub-flow-map` skill does):

  ```sh
  curl --unix-socket "$WORKHUB_SOCKET" -X POST http://workhub/v1/flow-maps \
    -H "X-Workhub-Token: $WORKHUB_SESSION_TOKEN" \
    -H 'content-type: application/json' --data-binary @checkout.json
  ```

  `WORKHUB_SESSION_TOKEN` is the session's own token; a post without it is refused.

On Windows the session has `WORKHUB_URL` and `WORKHUB_TOKEN` instead of `WORKHUB_SOCKET` (a loopback
port with a token made at each launch): replace `--unix-socket "$WORKHUB_SOCKET" http://workhub` with
`-H "Authorization: Bearer $WORKHUB_TOKEN" "$WORKHUB_URL"` in these examples, and keep the
`X-Workhub-Token` header.

  The answer is `{"ok":true,"id":…,"file":…}` or `{"ok":false,"errors":[…]}` naming the fields.
  A posted map replaces the stored one with the same `id`; when the posted file has no `alerts`,
  the stored map's `alerts` are kept, so an agent that redraws a map does not drop its limits.
  New limits a posted map brings wait for you: the map is saved with the limits it had, the answer
  carries a `note` saying so, and the change waits under **Changes by agents** (**See changes** on
  Home, or the sidebar entry, opens the window that lists it) with the limits before and after. **Keep** puts the new limits in effect; **Revert** keeps the old ones and
  puts back the rest of the map as it was (a map the agent added is deleted). When the old limits no
  longer fit the redrawn map (a part they name is gone), the new limits apply at once and the entry
  says they are already in effect. Revert refuses when the map changed again since.

## Turning it on

Flow maps is an optional module, like Health: the **Flow maps** switch in
**Settings → Profiles → (profile) → Screens** turns the screen on for that profile, and it appears in the
sidebar next to Health as **⌘7**. The numbers come from the profile's Health connection and its
environments, so Health has to be set up too; without it the maps are drawn but say so instead
of showing numbers.

## The screen

**Flow maps (⌘7)** has one header row: the title, the Health environments as a segmented control
(a dot for each one's state; hover it for the label) and, at the right, **Favorites only** (lists
only the starred maps; remembered), the window of the opened map (6 h, 1 d, 3 d, 7 d), a button that reads its
numbers again (never more than every 30 s) and a **⋯** menu with everything else: **Ask Claude**
(a session with the map, its numbers and what is missing already written, and not sent), the
animation (a comet runs along every hop in order), **Fit to width**, zoom in and out, **Copy as
image** (the diagram on the clipboard as a PNG), **Open in a window** (the map in a window of its
own), **Reload** (reads the stored maps and the opened map again) and **Settings** (Settings →
Profiles → (profile) → Screens → Flow maps).

The left column lists the stored maps that name the chosen environment (or name none), one card
per map, with a search box that matches name, heading and description (accents and case ignored).
The star on a card adds the map to **Favorites**, listed first; the rest stay under their `group`
heading (maps without one under **Other**, last). Favorites are kept on this computer.

A card shows the map's name, a small picture of the flow (its nodes and hops where the diagram puts
them, a part over its limits in red) and the flow's own numbers over the last day: the p95 and the
failure share of the node that starts it, and its p95 hour by hour as a line. Once it has numbers
the card also says how the flow stands, in a word: **Normal** (every measured part within its
limits and close to its seven-day usual), **Slow** (a part over 1.2 times slower than its usual),
**Errors** (a part over its failure limit, or failing two points more than its usual) or **Over
limit** (a part over another of its limits). The numbers come from the local history only (listing
the maps never reads the cluster), so a map that was never read says **No stored numbers yet**
until it is opened once.

A card without numbers yet keeps the dot that says how the map stands in the last stored hour:
red when a part is over the map's limits, green when none is. A map with no limits, no data yet, or no reading in the last two
hours (the connection down, the profile idle) shows no dot, so nothing looks live when it is not; a
red count next to the name says how many parts are over.

The map picked opens next to the column with:

- **The map header.** The star (adds the map to Favorites or removes it), the name and
  description, how the flow stands in a word, and **Map** or **Sequence** (the same flow as a
  sequence diagram: one lifeline per service, one arrow per hop in order, or in the order of the
  chosen execution).
- **Four tiles with the flow's own numbers.** **Flow p95**: the p95 of the node that starts the
  flow, and how it compares with its seven-day usual (×1.3: a third slower). **Calls**, and calls
  per minute. **Errors**: its failure share, and its limit when the map sets one. **Slowest
  part**: its name (click to pick it) and its share of the flow's time. Without Health the tiles
  say what turning it on brings instead.
- **The diagram.** Fitted to the width of its box, with the stage chips in a row under the last
  lane so the picture stays narrow and is drawn larger. A node shows what it does on the left, its
  p95 on the right and its share of the flow's time as a bar. Its dot, border and bar say how the
  part stands: green and a quiet border when it is within its limits and close to its usual,
  amber when it is slower or failing more than its seven-day usual, red when it is over one of its
  limits. A solid arrow is a call that waits, a dashed one a message, a red dotted one time
  waiting in a queue; the label on a hop is its p50. A part without a measure is faded and dotted;
  a measured part with no data in the window is hatched. Click a part (or its row, or focus it
  with Tab and press Enter) to light it up; the rest steps back; click the background to clear.
  The Sequence view fits its lifelines to the width too, and scrolls sideways only past eight
  services.
- **Parts.** The one place a part is read (with **Executions**, the only two tabs). Every part
  with numbers, slowest first, with calls, p50, p95, failures (count and share), how it compares
  with its seven-day usual, its limits and its share of the flow's time as a bar; its p99, calls
  per minute and how it compares with the previous window are in the opened row. Click a column's
  heading to sort by it (again to reverse). A p95 is amber when the part is slower than its usual
  and red when it is over a limit; failures are red when over the failure limit and amber when
  they grew. The parts without a measure fold into one row at the end; click it to list them.
- **A row opens.** Click a row (or pick the part in the diagram, which opens its row and brings it
  into view) and its detail shows under it; click it again to close it. One row is open at a time,
  and the row you clicked stays where it was on screen. The detail has the part's kind, how it
  stands in a word (**Normal**, **Slow**, **Errors**, **Over limit**) and why in a sentence with
  the numbers compared ("Failing more than usual: 4.0 % of its calls fail now, against 2.0 % over
  the last seven days"); **Investigate**, which opens the Ask Claude draft focused on the part,
  and **Executions**, which opens that tab; its p95 hour by hour as a line (its seven-day usual
  and its p95 limit as dashed marks, the slowest hour as a dot) over its calls hour by hour as
  bars, with the hours on one axis (hover an hour for its numbers); how its calls ended, as a bar
  split by result (`transaction.result`: "HTTP 2xx", "HTTP 4xx"…); and its limits, the one broken
  in red (**adjust** opens Settings → Profiles → (profile) → Screens → Flow maps). In a map's own
  window the header carries every control, the tiles are the verdicts (coverage, slowest part,
  alerts, against the usual), border colour is the kind of part, rows do not open, and the detail
  is a drawer beside the diagram that starts folded when the window is narrower than 1200 px.
- **Executions.** The real executions of the flow: the APM traces of its entry transaction, as
  one table (latest, slowest or failed only). Each row shows when it ran, how long it took as a
  bar against the slowest of the list (red when it failed, amber past the flow's p95, which is
  marked on every bar) and how it ended. Click a row to open it (again to close it): the diagram
  then shows what each part took in it, and parts it never touched fade. The opened row says
  first what happened in a sentence (where it failed, when and with what error, taken from its
  first error log; or which part took longest), with the trace id to copy, **Investigate** (the
  Ask Claude draft with this execution and its logs) and **See on the map**. Under it, the parts
  as a waterfall over one time axis, the log lines marked on that axis and the failed part in
  red; then **Logs** (the APM errors of the trace and the container log lines that carry its
  trace id, in order, with the service and the level, errors set apart); and a last line with
  what it did **outside the map** (transactions and outgoing calls no part measures: the
  candidates to add) and the measured parts it never touched.
- **Coverage and limits, in the Parts table.** Over the table, five filters with how many parts
  each keeps: **All**, **With problems** (off their usual, over a limit, or a failed read),
  **Over a limit**, **Not measured** (drawn, with no measure in the file) and **No data**
  (measured, but APM returned nothing: a name that differs from what APM records, or a part
  nothing called). Open one of those rows and its sentence says why it has no numbers. Each row
  shows its limits (`alerts` in the file) in the **Limits** column (p95, slow calls, failures),
  in red with "exceeded" when the part is over one. At the right of the filters, the map's own
  limits and **adjust** (or **set them**), which opens the limits editor in Settings. In a map's
  own window these are still the **Coverage** and **Alerts** tabs.

  Three kinds of limit, for the whole map or per part:

  | Limit | Breaks when | Example |
  |---|---|---|
  | p95 | the part's p95 is above it | p95 over 3 s |
  | Failures | the share of failed calls is above it | more than 5% fail |
  | Slow calls | more than a share of the calls take longer than a duration; with no share, a single slow call is enough | more than 40% take over 5 s |
 While the module is on, Workhub reads every
  map that has limits every five minutes over the last hour and notifies the parts above them,
  once an hour per part (Settings → Notifications and alerts, flow maps, turns these off; a map's own
  **Notify** switch in Settings → Profiles → (profile) → Screens → Flow maps turns off only that map). A part with fewer calls in the
  window than the map's minimum (default 20) is never over a limit. **Settings → Profiles → (profile) → Screens → Flow
  maps → Flow maps · limits** edits the limits of every map without opening its file: see below.
- **How to read it.** A button on the corner of the diagram opens the key: what the colours of
  a part mean, what a node shows and what each arrow is. In a map's own window it is the
  **Legend** tab.

Without Health (the module off, or not set up yet) the maps are still listed and drawn, without
numbers: a badge in the header says so, and the tiles and the part detail say "no numbers" with a link
to turn Health on. Without the Flow maps module the screen only says how to turn it on.

### Editing the limits in Settings

**Settings → Profiles → (profile) → Screens → Flow maps → Flow maps · limits** lists every valid stored map under its `group`,
with the environment that measures it. Per map: a row for every part (p95 in ms, failure share in
%, **Slow above (ms)** and **Slow calls (%)**, and the map's **Notify** switch), one row per part
with limits of its own (pick a measured part and **Add part limit**; a blank field inherits the
map's value), and **Minimum calls**. **Now** shows the last stored hour (no cluster read) against
the limits as typed: *ok*, *over p95*, *over failures* or *too many slow*, with the share of slow
calls. The share of slow calls is read from the latency histogram, so it is within one bucket
(about 10%) of the exact figure. **Save limits** writes the `alerts` field into the map's file: the map is
validated first, and every other byte of the file stays as it was.

### Local history

The numbers come from a local history, so a map draws at once and the cluster is read as little
as possible. Workhub keeps, per environment and measure, one aggregate per hour for the last seven
days: calls, failures, the result codes and a latency histogram (buckets 20% wide, 1 ms to
10 minutes, so a percentile is within about 10% of what APM would say). Every window (1 h to 7 d),
its previous window and the seven-day baseline are added up from those hours. A window is that
many whole hours plus the part of the hour in course already gone, so it is never shorter than
its name: the 1 h window read at 10:20 covers 9:00 to 10:20, and calls per minute are counted
over those 80 minutes. The previous window is the same number of whole hours just before it.

- Opening a map draws the stored numbers right away, then reads only the hours not stored as
  final: the first time a measure is seen that is the whole week, after that the hour in course
  and the one before (an hour counts as final 15 minutes after it ends, as APM documents arrive
  late).
- A measure is read again at most every two minutes (**Refresh**: every 30 s), and two maps that
  measure the same thing share it. At most four reads run against the cluster at once, the alert
  checks included.
- If a read fails, the stored numbers stay on screen and a message says why they are not newer.
- The history lives in the database (`workhub.db`), per profile, connection and environment
  (stored under a hash, never the names). Only the hours that change are written. The screens read
  the last seven days; hours are kept 90 days and older ones are deleted at start, as is a measure
  not read in 90 days.

An execution is kept 10 minutes.

## The file

See `docs/examples/flow-maps/checkout.json` for a complete, synthetic example.

| Field | Meaning |
|---|---|
| `version` | `1`. |
| `id`, `name`, `description` | The id names the file (`letters, digits, - _ .`). |
| `group` | Optional: the heading the map is listed under, such as `Payments` (up to 40 characters). |
| `environmentId` | Optional: the Health environment the map belongs to; listed under every environment when unset. |
| `phases` | Optional headers over the columns: `{ label, fromColumn, toColumn }`. |
| `lanes` | Rows, top to bottom: `{ id, label, kind }`, `kind: "exception"` draws the lane dashed (external systems, queues). |
| `nodes` | `{ id, lane, label, subtitle?, kind?, column?, note?, measure? }`. Kinds: `app`, `service`, `orchestrator`, `worker`, `queue`, `external`, `datastore` (the colour). The column is computed from the edges when unset: a node sits one column after the farthest node that reaches it. |
| `edges` | `{ from, to, label?, kind?, emphasis?, entry?, measure? }`. Kinds: `sync` (a call that waits), `async` (a message, dashed), `wait` (time in a queue, red). `entry: "top"` enters the target from above instead of from the side, for a hop that would otherwise cross a node. |
| `stages` | Optional checkpoints drawn as chips in `stagesLane` (a saga's steps): `{ id, label, measure? }`. |
| `entry` | Optional: the `apm.transaction` measure that starts the flow, used to list its executions. When unset, the leftmost node with a transaction measure is the entry. |
| `alerts` | Optional limits: `{ "p95Ms": 3000, "errorRate": 0.05, "slowMs": 5000, "slowShare": 0.4, "minCalls": 20, "parts": { "orders": { "p95Ms": 1500 } } }`. `p95Ms` is the p95 in milliseconds, `errorRate` the failure share (0–1); `slowMs` and `slowShare` break when more than `slowShare` (0–1, default 0: any call) of the calls take longer than `slowMs` milliseconds; `parts` overrides them per part, keyed by node id, stage id or edge id (`from->to` when the edge has none). A part's own value wins, field by field. `minCalls` (default 20): a part with fewer calls in the window breaks no limit. `notify: false` keeps the limits on screen without notifying. |

A `measure` says how a number is read from APM:

- `{ "type": "apm.transaction", "service": "orders", "transaction": "POST /orders" }`: the
  duration of an entry point (an HTTP route, a gRPC method, a consumer), with its failure share.
  Put it on the node that serves it, or on a stage.
- `{ "type": "apm.span", "service": "shop-bff", "destination": "orders:8080" }`: the duration of
  the outgoing calls of a service to a destination (`span.destination.service.resource` in APM).
  Put it on the edge.

Parts without a measure are drawn but not measured. A measure that fails (a wrong name, a
missing index) is reported on its row, the rest still reads.

### Finding the names

The names are the ones APM reports: `service.name`, `transaction.name` and
`span.destination.service.resource` of the traces index configured for the environment. Kibana's
APM app shows them per service (Transactions, Dependencies), and the **Slow endpoints** card of
Health lists transaction names. An agent with read access to Elasticsearch can derive a whole map
from one trace: follow `trace.id` and `parent.id` across the transactions and spans of one request
(the `workhub-flow-map` skill explains how).
