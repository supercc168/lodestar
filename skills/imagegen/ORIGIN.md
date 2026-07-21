# Origin

Vendored from OpenAI Codex `imagegen` skill (Apache-2.0).

- Upstream layout: `SKILL.md` + `scripts/image_gen.py` + `scripts/remove_chroma_key.py` + `references/*`
- Lodestar adaptations live in `src/imagegen-skill.ts` (generated SKILL.md is CLI-first for independent image channels; not the upstream built-in `image_gen` tool path).
- Do not hand-edit installed copies under `~/.claude/skills/imagegen` or `~/.codex/skills/imagegen` — daemon overwrites them on boot unless `LODESTAR_DISABLE_SKILL_SYNC=1`.
