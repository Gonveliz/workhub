# Pull requests

The **Pull requests** screen (⌘/Ctrl+2) lists your pull requests and the ones waiting for your
review. Workhub reads them through the GitHub CLI (`gh`) or the GitLab CLI (`glab`) and your own
login: it stores no token for them. GitLab is covered by fixture tests only so far.

## Set up

1. Install `gh` (or `glab`) and sign in: run `gh auth login` in a terminal.
2. In **Settings → Connections**, under **Code**, use **Connect GitHub** (or **Connect GitLab**) and
   pick the connection in your profile. Extra options go in **Edit as text**, one `key=value` per
   line; for example `scope=org:acme` narrows the GitHub search to an organization.
3. Refresh. If `gh` is missing or signed out, the screen says so and shows the command to run.

## Which pull requests a profile shows

Each profile picks its own pull requests in **Settings → Profiles → (profile) → Screens → Pull
requests**, so one login can show only the work organization in one profile and only your own
repositories in another:

| Field | What it does |
|---|---|
| **Organizations or users** | One per line (`acme`, `ana`; a GitLab group such as `acme/team`). Only their repositories are read. |
| **Hidden repositories** | One per line, as `owner/repo`; `*` stands for any name (`acme/legacy-*`, `acme/*`). Never shown, even when an owner above includes them. |

With no owners, the search falls back to the connection's `scope`, then to the repositories of the
profile's folders, then to everything your login sees. Hidden repositories apply in every case.

## The list

| Filter | Shows |
|---|---|
| **To review** | Pull requests that ask for your review. |
| **Mine** | Your open pull requests. |
| **Stale** | Yours that have been idle for 30 days. |
| **All** | Mine and the ones waiting for you. |

Search by title, author, branch or ticket. The narrowing bar filters by **Status**, **Into** (base
branch), **Repo**, **Author** and **Ticket** (**With ticket** / **Without ticket**), and sets the
**Order of the list** (newest update, oldest update, repository). Each row shows its state: **Draft**,
**Awaiting review**, **Approved**, **Changes requested**, **CI running**, **CI failing**,
**Conflicts**, **Merged** or **Closed**. Tickets in titles and branch names link to the
[Tickets](tickets.md) screen when a tracker is connected.

## The pull request window

Select a pull request to read it in the screen, or open it in its own window (**Open in its own
window**, or **Open in new window** from the row menu). **Open in the browser** uses the browser
chosen for the profile; see [Profiles](profiles.md#opening-links).

| Tab | Contents |
|---|---|
| **Conversation** | Description, reviewers and their state, comments, labels, linked tickets. |
| **Files** | The changed files with their diff, review threads inline, and **Reply** on a thread. Long diffs show the first lines with **Show all**. |
| **Commits** | The commits of the pull request. |
| **Checks** | CI checks and their state. |
| **Slack** | **Followed threads** and **Messages that link it**, with **Track a Slack link**. See [Slack](slack.md). |

Actions on the toolbar:

- **Approve**, **Request changes** and **Comment** submit a review. A comment is required for
  **Request changes**.
- **Open session** opens the session linked to the pull request, or starts one in the matching
  folder.
- **Ask Claude to review** starts a Claude session with a review prompt in the composer; nothing is
  sent until you press **Send**.
- **Close PR…** closes it without merging, with an optional closing comment and an optional **Delete
  the branch**. Long-lived branches are never deleted: the list is **Protected branches** in
  **Settings → Connections → Code**, and `release…` branches are always kept. A closed pull
  request can be reopened on the code host.
- **Merge…** merges it now. It is enabled only while the pull request is open, not a draft, and
  the code host reports it as mergeable. The dialog offers the methods the repository allows
  (**Merge commit**, **Squash and merge**, **Rebase and merge** on GitHub; on GitLab the project's
  own method, with squashing as its squash option allows) and **Delete the branch**, locked for
  protected branches as above. The confirmation names the method and whether the branch is
  deleted. When the code host refuses (conflicts, failing or unfinished required checks, no
  permission), the dialog says which. After a merge, sessions working in a worktree on the
  pull request's branch are offered to close with their worktree removed; nothing happens until
  you click, and a worktree with uncommitted or unpushed work is kept.
- **Copy link**.

## Create a pull request from a session

When a session's branch is pushed, has commits beyond the base and has no open pull request, the
session monitor shows **New pull request** with **Create pull request…**. The form starts with the
first commit's subject as the title, the review brief as the description when **Review before PR**
produced one, and the remote's default branch as the base; **Open as a draft** is off. Nothing is
sent until you press **Create pull request**; the new pull request then opens in its own window.

Workhub never pushes a branch. If the remote does not have the branch, or lacks some of its
commits, the monitor says so and shows the push command with **Copy**.

## Notifications

Workhub checks your pull requests every three minutes and shows an OS notification when one changes
or when someone asks for your review. **Refresh every**, in the code host connection (**Settings →
Connections → Code**), changes how often: from 1 to 60 minutes. The lists on screen follow it too. **Settings → Notifications and alerts** (Pull requests) has a
switch per kind: **Review requested**, **Approved**, **Changes requested**, **New comments**, **CI
failed**, **CI passing again**, **Merge conflicts**, **New commits**, **Merged**, **Closed**.
Clicking a notification opens the pull request.

Home shows **My pull requests** and **Waiting for my review**, and the sidebar nav shows how many
wait for your review.

Next: [Tickets](tickets.md).
