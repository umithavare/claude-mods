# claude-mods

Claude Code mods (function-hook plugins). Each folder is one mod.

## usage-band

<img width="807" height="132" alt="image" src="https://github.com/user-attachments/assets/ce3d4941-46a0-446b-a085-91e27f61ec22" />

A usage ribbon above the prompt in the Claude Code desktop app (Code tab) and the terminal:

- **5h** and **7d** limit pills: usage bar (green < 70%, yellow ≥ 70%, red ≥ 90%), a vertical line for how much of the window has passed, and the time left until reset.
- **Input** (uncached + cache write), **output** and **cache read** token totals of the session, subagents and workflow agents included.
- **Session cost** at API list prices.
- Hover a pill for the breakdown, context fill and request count.

Commands: `/kullanim` refreshes and prints a one-line summary, `/kullanim gizle` hides the ribbon, `/kullanim goster` shows it again.

Token totals come from `scripts/tokens.mjs`, which reads the session transcript with Node. Without Node the ribbon still works and shows estimates prefixed with `~`.

## Install (once per machine)

```bash
git clone https://github.com/umithavare/claude-mods ~/.claude/mods
```

Add to the `env` block of `~/.claude/settings.json` (`~` works on every OS):

```json
"CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/usage-band",
"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
```

If `CLAUDE_CODE_PLUGIN_DIRS` already has a value, append the path with `;` on Windows or `:` on macOS/Linux.

Restart Claude Code, then check:

```bash
claude -p "/kullanim"
```

Update later with `git -C ~/.claude/mods pull`.

## Develop

```bash
claude plugin validate usage-band
claude plugin test usage-band
```

For `tsc`, run `/plugin-types usage-band/.claude/types` in a Claude Code session first to write the engine's type declarations, then `npx -p typescript@5 tsc -p usage-band`.
