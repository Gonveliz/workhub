# Tickets

The **Tickets** screen (⌘/Ctrl+3) shows the tickets assigned to you (and, with Jira, the team's backlog), grouped by sprint (**Active
sprint**, then **Backlog · no sprint**). Jira Cloud, Linear and GitHub Issues are supported.

## Set up

1. **Settings → Profiles → (profile) → Screens → Tickets → New tracker** (open the row).
2. Pick the provider:
   - **Jira**: the **Jira site** (for example `your-team.atlassian.net`), your **Account email** and
     an **API token** (create one at id.atlassian.com → Security → API tokens).
   - **Linear**: an **API key** (Linear → Settings → Security & access).
   - **GitHub Issues**: no token. Workhub reads through the GitHub CLI (`gh`) and your `gh auth
     login`. Fill **Repositories** (comma separated, like `acme/app, acme/api`); left empty, the
     GitHub repositories behind the profile's folders are used.
3. Optional: **Project keys** (comma separated, like `ABC, WEB`) so ticket links in titles and
   branches are matched exactly, and **Statuses to hide**. Jira also takes a **Backlog query
   (JQL)** for **Team backlog** (below).
4. **Test connection** shows who you are connected as. **Save tracker**.
5. Turn on **Use in the active profile**. Each profile uses one tracker.

The token is stored encrypted by the operating system, never in the settings file.

### GitHub Issues

The screen lists the open issues assigned to you in the repositories in scope (up to 500, most
recently updated first). Keys look like `acme/app#123`; a bare `#123` means the repository when
only one is in scope. Issues have no sprints. **Move to…** offers **Close as completed**, **Close as
not planned** and, on a closed issue, **Reopen**; open issues count as to do and closed ones as
done. Plan milestones can count issues with a GitHub search such as `milestone:"v1.0"` (limited to
the repositories in scope unless it has its own `repo:`, `org:` or `user:`), and approved inbox
items are created as issues in an `owner/repo`. Descriptions and comments show as Markdown.

## Team backlog (Jira)

With Jira, the screen switches between **Assigned to me** and **Team backlog**: the open tickets
of the team, whoever has them or nobody, grouped by sprint like your own. Each row then shows who
has the ticket, or **Unassigned**.

What the backlog lists comes from the tracker connection: the **Backlog query (JQL)** when there is
one (for example `project in (ABC, WEB) AND labels = mobile`; its own `ORDER BY` is kept, else Jira
rank), otherwise the open tickets of the **Project keys**. With neither, the view asks you to set
one. **Statuses to hide** apply here too, and up to 500 tickets are read. The backlog is read while
the view is open, at the connection's **Refresh every**.

## Filters

Next to **Assigned to me** and **Team backlog** (each with its count) is a search by words in the
key or title. Under them, **Project**, **Status** and, in **Team backlog**, **Assignee** (including
**Unassigned**) open a menu with how many tickets have each value; a set filter shows its value. A
filter shows only when the list has more than one value for it. **Clear filters** shows everything
again.

Each view keeps its own filters, and the view you were on, its filters and the search are kept per
profile, also after you quit and reopen Workhub.

## Using it

- Each row shows the ticket, its status and how many pull requests and sessions mention it.
- Open a ticket to read it in Workhub or in its own window. From there you can change the status
  (**Move to…**), **Assign to me**, read the description, subtasks and comments, and **Add
  comment**. The ticket lists its **Pull requests** and **Sessions**, with **Show session**.
- **Talk with Claude** opens a Claude session about the ticket with a prompt for you to finish.
  **New session about this ticket** starts one with your preferred agent. **Open session** goes to
  the latest open session on it. **Open in the browser** and **Copy link** are there too.
- Ticket keys in sessions, pull requests and Slack messages show as chips; click **Open ticket** to
  see them without leaving the app.
- Home shows **Tickets in progress**.

## Notifications

With **Tickets** on under **Settings → Notifications and alerts**, Workhub notifies about status
changes and about tickets assigned to you or taken away. Only the active profile is read: when you
switch to a profile not read for over a day, its tickets are recorded without notifying. More than
five changes in one read arrive as one summary, and a very long list (100 tickets or more) never
reports a ticket as taken away, since the tracker may have left it out.

Tickets are read every five minutes. **Refresh every**, in the tracker connection (**Settings →
Connections → Tickets**), changes how often, from 1 to 60 minutes, for the notifications and the
lists on screen.

Next: [Slack](slack.md).
