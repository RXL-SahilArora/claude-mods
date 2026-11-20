# session-activity-badge

Shows a few lines above the prompt while any other Claude Code session on this machine is mid-turn,
has background work running, or any subagent is running:

    ● 2 sessions working · 2 background tasks · 1 agent running
      API DEPLOYMENT    Run backend check
      BUG FIX 5         ██████░░░░ 3/5  Re-running test suite
      RELEASE PREP      idle, waiting on background work
        ↻ shell: Run full test suite on main
        ↻ shell: Run frontend tests with coverage

Up to three sessions are listed by their title (as the sidebar shows it), then `+N more`.

- **Progress bar.** A session with a task list (the Desktop app's pinned plan) shows steps done out
  of total, and the step in progress.
- **Current work.** A session with no task list shows what it is doing instead: its last tool call
  (the command's description, or the tool and file), else the first line of its prompt.
- **Background work.** Background shells show under their session, up to three per session, for
  idle sessions and this one too. A shell is listed from the moment it starts until its completion
  notice reaches the session. Where no other plugin skips it, each turn's Stop hook also replaces
  the list with the engine's own. A task that ends without a notice (one stopped from the app's
  panel) can stay listed; `/badge-clear` empties this session's background rows.

When everything is idle it draws nothing.

## How it works

Every session that loads the mod writes its own record (busy flag, running-subagent count, task-list
progress rebuilt from its `update_plan` calls, current work, background tasks, heartbeat) to the mod
store that all sessions on the machine share, and reads the others' every 3 seconds. A session only
counts if it has this mod loaded, so install it at user scope. A record not refreshed for 15 seconds
(a closed or crashed session) is ignored and later deleted.

**Privacy.** The store is a file under `~/.claude/plugins/store/` on your own machine; nothing is
sent anywhere. It does hold session titles, task-list step names, tool-call descriptions and the
first line of each session's latest prompt, so treat it like your other Claude Code files.

The session title is read from the session's own transcript with a small `sh` command (Linux and
macOS); where that fails the folder name is used.

## Install

    claude plugin marketplace add RXL-SahilArora/claude-mods
    claude plugin install session-activity-badge@local-mods

The repository is private: you need read access to it, and git must be able to reach GitHub (SSH key
or credential helper). Then run `/reload-plugins` in sessions that are already open. Needs Claude
Code 2.1.287+ in the terminal, 2.1.286+ in the Desktop app. Turn off with `/plugin` → Installed →
disable.

## Tests

    claude plugin test session-activity-badge
