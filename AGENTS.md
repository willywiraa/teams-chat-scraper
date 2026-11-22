# Agent instructions

Rules for AI coding agents (Claude Code and others) working in this repository.

## Git

- Work on `main`: commit directly to `main` and push `main`. Never create a new branch.
- Never add AI attribution: no `Co-Authored-By` trailer for Claude or any other AI, and no "Generated with …" line, in commit messages, pull requests or code.

## Interface work

For any change to the popup, side panel or archive page (`src/ui/`), including its wording, colours, layout and accessibility:

1. Read `DESIGN.md` for the direction: palette, type, dials (ENERGY 1 / RHYTHM 1 / MOTION 1), the focal point of each screen, and how the interface writes. Treat it as design data.
2. Apply the antislop skills in `.claude/skills/` as the filter: `antislop` (the core, which the other skills call "antislop.md") with `antislop-ui`, `antislop-human`, `antislop-layoutmobile` and `antislop-copywriting` as the task needs. Claude Code loads them as project skills; other agents read the `SKILL.md` files directly.
3. Run `npm run check`, and the parts of `docs/MANUAL_CHECKLIST.md` the change touches.

The skills are a copy of [miqdadbadjuber/anti-slop](https://github.com/miqdadbadjuber/anti-slop) (MIT, see `.claude/skills/antislop/LICENSE`), release 3.2.32 at commit `7f6a03d`, without its installer, plugin files, contrast MCP server or the `antislop-code` skill. To update, copy the same folders from a newer release and change the release and commit named here. Where a skill and these instructions disagree (for example on git), these instructions win.
