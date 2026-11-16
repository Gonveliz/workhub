# Getting started

## Requirements

- macOS, Windows or Linux. Only macOS has been tested on real machines so far.
- The agents you want to run, installed and on your `PATH` (for example `kiro-cli`, `opencode`,
  `gemini`). Codex runs through `npx`, which comes with Node.js. An agent that is not installed
  shows as **not installed** in **New session**, with how to install it.
- Claude Code needs no separate install: the Claude Agent SDK and its `claude` binary ship inside
  the app. Sign in with a Claude account from the setup check.
- `gh` (GitHub CLI) signed in for pull requests, and `glab` for GitLab.

## Install

Latest version: [Windows (x64)](https://github.com/SoldierIced/workhub/releases/latest/download/Workhub-2-win-x64.exe) ·
[macOS (Apple silicon)](https://github.com/SoldierIced/workhub/releases/latest/download/Workhub-2-mac-arm64.dmg) ·
[Linux AppImage](https://github.com/SoldierIced/workhub/releases/latest/download/Workhub-2-linux-x86_64.AppImage) ·
[Linux .deb](https://github.com/SoldierIced/workhub/releases/latest/download/Workhub-2-linux-amd64.deb)

The quickest way is one line: [Windows](#windows-from-zero) in PowerShell,
[macOS](#macos-in-one-line) in Terminal. It installs the newest published release with no security
prompts; run it again to update.

To install by hand, download the installer for your system from the
[Releases](https://github.com/SoldierIced/workhub/releases) page. Every file has a `.sha256` file
to check the download. The builds are not signed with a paid certificate, so each system asks for
one extra step the first time you open the app.

A release is published as the latest one once its installers are attached. If no
release is published yet, build from source: see the README, [macOS from source](../../README.md#install-by-hand)
and [Build installers](../../README.md#build-installers).

| System | File | First launch |
|---|---|---|
| macOS (Apple Silicon) | `.dmg` or `.zip` | Drag **Workhub 2** to Applications. Gatekeeper blocks the first launch: open the app once, then go to **System Settings → Privacy & Security**, scroll to **Security** and click **Open Anyway**. Or run `xattr -dr com.apple.quarantine "/Applications/Workhub 2.app"`. |
| Windows (x64) | `.exe` installer | SmartScreen shows "Windows protected your PC": click **More info**, then **Run anyway**. The installer lets you pick the folder and installs per user. |
| Linux (x64) | `.AppImage` or `.deb` | `chmod +x Workhub-2-*-linux-x86_64.AppImage && ./Workhub-2-*-linux-x86_64.AppImage`, or `sudo apt install ./Workhub-2-*-linux-amd64.deb`. |

Workhub 2 has its own app id and data folder, so it can run next to Workhub 1.

### Windows from zero

Windows is built by CI and has not been tested on real machines yet. Please report what you find.

1. Optional: install [Git for Windows](https://gitforwindows.org/) (Workhub reads local changes and
   diffs with `git`, and it gives agents Git Bash) and Node.js if you run an agent through `npx`
   (Codex does). Claude Code needs neither: its binary ships inside the app.
2. Open **PowerShell** (Start menu → type `PowerShell`), paste this line and press Enter:

   ```powershell
   irm https://raw.githubusercontent.com/SoldierIced/workhub/main/scripts/install.ps1 | iex
   ```

   It downloads the newest published installer, checks it, installs Workhub 2 for your user (no
   administrator rights, no SmartScreen prompt) and opens it. Run the same line to update.
3. In Workhub 2 open **Help → Setup Check…**, fix what it flags and sign in with a Claude account.
4. After you install a CLI (`gh`, `kiro-cli`, `opencode`, `gemini`), restart Workhub: Windows keeps
   the `PATH` an app started with. See
   [Troubleshooting](../troubleshooting.md#an-agent-is-not-found-on-path).

On Windows, the **Shell** view opens the shell named by the `COMSPEC` environment variable, else
`powershell.exe`.

By hand instead: download `Workhub-2-<version>-win-x64.exe` from the Releases page and run it.
SmartScreen shows "Windows protected your PC": click **More info**, then **Run anyway** (expected
for every unsigned build). To check the download first:
`Get-FileHash .\Workhub-2-<version>-win-x64.exe -Algorithm SHA256`, compared with its `.sha256`.

### macOS in one line

Open **Terminal**, paste this line and press Enter:

```sh
curl -fsSL https://raw.githubusercontent.com/SoldierIced/workhub/main/scripts/install.sh | bash
```

It installs the newest published release to `/Applications` (as **Workhub**, not **Workhub 2**,
the name the `.dmg` uses), with no Gatekeeper prompt, and opens it. A running copy keeps working;
the new version starts the next time you open it.

## Uninstall

- **Windows**: **Settings → Apps → Installed apps → Workhub 2 → Uninstall**.
- **macOS**: delete the app from `/Applications`: **Workhub 2** if you installed the `.dmg` or
  `.zip`, **Workhub** if you used the one-line installer.

Uninstalling leaves your data folder in place. To remove it too, delete it by hand:
`%APPDATA%\Workhub 2` on Windows, `~/Library/Application Support/Workhub 2` on macOS. The folder
holds your settings, encrypted secrets and logs. **Settings → Advanced → Data** shows the exact
path.

## First run

1. Open **Help → Setup Check…** (or **Settings → Advanced → Diagnostics and help**, which has the same entry). It lists
   what Workhub needs on this machine and the optional integrations. Each item shows **Ready**,
   **Needs a look**, **Missing** or **Not set up**, with a button to fix it. Nothing in the check
   changes a setting by itself. For a missing Claude Code, Codex, Kiro CLI or GitHub CLI the button
   is **Install** when the tool has an official installer for your system: Workhub shows the exact
   command, runs it in a shell on this machine only after you confirm, then checks again. Workhub
   only runs commands from its own list of official installers. Without one, the button opens the
   install guide or copies a command.
2. The **Welcome…** window (Help menu) walks you through creating a first profile: a name and the
   folders you work in. You can add more later.
3. In **Settings → Agents**, add the agent accounts you use. A Claude account is a config folder;
   Kiro and Codex use their own CLI sign-in. See [Profiles](profiles.md).
4. In **Settings → Profiles**, open the profile: give it folders and a default folder on the
   **Folders** tab, the accounts it may use on **Agents**, and turn on the screens you want
   (Health, Slack, Automations…) on **Screens**.
5. Optional: connect a code host, a ticket tracker, Slack and Elasticsearch. See
   [Pull requests](pull-requests.md), [Tickets](tickets.md), [Slack](slack.md) and
   [Health](health.md).
6. Start a session with **New session** (⌘/Ctrl+T). See [Sessions](sessions.md).

Secrets you type into Settings (API tokens) are stored encrypted with the operating system keychain
and never written to the settings file. If the system cannot encrypt, Workhub refuses to store
them.

## Updates

**Settings → General → Updates** has a **Check for new versions automatically** switch, off by default: nothing
contacts GitHub unless you turn it on or press **Check now**. On Windows and the Linux AppImage the
app can download and install the new version (**Download and restart**). On macOS the app is unsigned, so it cannot use the system updater;
instead it downloads the release's `.zip`, checks its SHA-256, and swaps its own app in place when it
runs from an app in a folder it can write to (**Download and restart**, as on Windows; the new version
starts on the next launch). From a folder it cannot write to, Workhub only announces the new version
and opens the release page: download it and replace the app.

With **Check for updates** on, Workhub checks when it starts and every 6 hours while it runs. When
it finds a newer version it asks, at most once a day: **Update now** (or **Download the new
version** on a Mac that cannot replace the app), **Later** (asks again the next day) or **Skip this
version** (never asks for that one again; a newer one does). **Check now** in Settings never asks.
**Check for updates…** in the menu bar icon checks at once and opens Settings on this group,
highlighted for a moment, where the result shows.

## Menu bar and tray

Closing the window can keep Workhub running in the menu bar (macOS), the notification area
(Windows) or the status area (Linux), so sessions, Slack and automations keep working. Turn this
off in **Settings → General → On open and close**. The icon opens a small panel with the sessions that need
you, plan usage, pull requests and notifications.

Next: [Profiles](profiles.md).
