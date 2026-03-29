# opensessions

tmux is all you need. make tmux great again :) 

<img width="4180" height="2416" alt="amp-img-e686694168e21738-aesthetic" src="https://github.com/user-attachments/assets/2caaee1a-b3f5-4041-aa3c-5b3668aa1912" />

`opensessions` is a sidebar for `tmux` when your sessions, agents, and localhost tabs start multiplying.

It lives inside your existing tmux workflow instead of replacing it: one small pane for session switching, agent state, repo breadcrumbs, and quick jumps back into the right terminal.

tmux is the only supported mux today. There is older zellij integration code in the repo, but it is not stable enough to document as supported; we are looking for maintainers who want to help bring it back to that bar.

## Install With TPM

Requirements:

- `tmux`
- `bun`
- [TPM](https://github.com/tmux-plugins/tpm)

Add this to `~/.tmux.conf`:

```tmux
set -g @plugin 'Ataraxy-Labs/opensessions'
```

Then reload tmux and install plugins:

```bash
tmux source-file ~/.tmux.conf
~/.tmux/plugins/tpm/bin/install_plugins
```

Open the sidebar with `prefix o → s`.

TPM clones the repo into `~/.tmux/plugins/opensessions`. It does not install a standalone `opensessions` binary. `opensessions` runs from that checkout with your local `bun` installation.

If you want the same setup as a single shell command:

```bash
grep -q "Ataraxy-Labs/opensessions" ~/.tmux.conf 2>/dev/null || printf '\nset -g @plugin '\''Ataraxy-Labs/opensessions'\''\n' >> ~/.tmux.conf && tmux source-file ~/.tmux.conf && ~/.tmux/plugins/tpm/bin/install_plugins
```

## Uninstall

Run the uninstall script **before** removing the plugin files — it cleans up tmux hooks, keybindings, sidebar panes, and environment variables that would otherwise persist and cause glitching:

```bash
sh ~/.tmux/plugins/opensessions/integrations/tmux-plugin/scripts/uninstall.sh
```

Then remove the `set -g @plugin 'Ataraxy-Labs/opensessions'` line from `~/.tmux.conf` and run `prefix + alt + u` (TPM uninstall).

## Support Status

- `@opensessions/mux-tmux` and the tmux plugin flow are supported.
- `@opensessions/mux-zellij` is still experimental.
- The repo is organized for contributors around runnable apps, reusable packages, and host integrations.

## Today

- Live agent state across sessions for Amp, Claude Code, Codex, and OpenCode.
- Per-thread unseen markers for `done`, `error`, and `interrupted` states.
- Session context in the UI: branch in the list, working directory in the detail panel, thread names, and detected localhost ports.
- Fast switching with `j`/`k`, arrows, `Tab`, `1`-`9`, session reordering, hide/restore, creation, and kill actions.
- `prefix o → s` and `prefix o → t` for sidebar focus and toggle, `prefix o → 1` through `9` for quick switching, optional no-prefix shortcuts, in-app theme switching, and plugin hooks for more mux providers or watchers.
- Bun workspace, source-first execution, and a local server on `127.0.0.1:7391`.

## Local Development

Smoke test from a local clone:

```bash
git clone https://github.com/Ataraxy-Labs/opensessions.git
cd opensessions
bun install
bun test
bun run start:tui
```

That starts the sidebar client and auto-launches the server if needed.

For the full tmux workflow with keybindings, troubleshooting, and configuration options, follow the guide below.

## Docs

- [Get started in tmux](./docs/tutorials/get-started-in-tmux.md)
- [Set up Ghostty shortcuts](./docs/how-to/set-up-ghostty-shortcuts.md)
- [Configuration reference](./docs/reference/configuration.md)
- [Features and keybindings reference](./docs/reference/features-and-keybindings.md)
- [Architecture explanation](./docs/explanation/architecture.md)
- [Contracts and extension interfaces](./CONTRACTS.md)
- [Plugin authoring guide](./PLUGINS.md)

## A Few Concrete Bits

- Session ordering is persisted in `~/.config/opensessions/session-order.json`.
- Amp watcher reads `~/.local/share/amp/threads/*.json` and clears unseen state from Amp's `session.json` when a thread becomes seen there.
- Claude Code watcher reads JSONL transcripts in `~/.claude/projects/`.
- Codex watcher reads transcript JSONL files in `~/.codex/sessions/` or `$CODEX_HOME/sessions/` and resolves sessions from `turn_context.cwd`.
- OpenCode watcher polls the SQLite database in `~/.local/share/opencode/opencode.db`.
- Hidden sidebars are stashed in a tmux session named `_os_stash`, so they can come back without restarting the sidebar process.
- Clicking a detected port opens `http://localhost:<port>`.

## Repo Layout

### Apps

- `apps/server` — Bun server bootstrap that wires together built-in mux providers and agent watchers
- `apps/tui` — OpenTUI sidebar client built with Solid, plus the canonical sidebar launcher script

### Packages

- `packages/runtime` — shared runtime logic: tracker, config, plugin loader, server internals, themes, ordering
- `packages/mux/contract` — mux contracts and capability guards exposed as `@opensessions/mux`
- `packages/mux/providers/tmux` — tmux provider exposed as `@opensessions/mux-tmux`
- `packages/mux/providers/zellij` — experimental zellij provider exposed as `@opensessions/mux-zellij`
- `packages/mux/tmux-sdk` — lower-level typed tmux bindings used by tmux-aware code

### Integrations

- `opensessions.tmux` — root TPM entrypoint for users
- `integrations/tmux-plugin` — tmux-facing scripts and host integration glue

## Current Caveats

- The app is effectively pinned to `127.0.0.1:7391` today.
- `theme`, `sidebarWidth`, `sidebarPosition`, `plugins`, and `mux` are wired through the runtime; other typed config fields are not all live yet.
- Inline theme objects exist in core, but the running server persists and broadcasts theme names.

## License

MIT
