# AGENTS

## Purpose

- This file is for AI agents, coding assistants, and repository automations working in this codebase.
- Human contribution rules live in [CONTRIBUTING.md](./CONTRIBUTING.md). This file only adds agent-specific execution constraints and decision rules.

## Engineering Constraints

- Repository-wide contribution and refactoring constraints are defined in [CONTRIBUTING.md](./CONTRIBUTING.md).
- When working on structural changes, follow `CONTRIBUTING.md` as the primary source of truth for workflow, module boundary, shared source, and regression test expectations.

## Git Constraints

- Do not rewrite published history unless explicitly requested by the repository maintainer.
- Keep formatting-only changes separate from behavior changes whenever practical.
- Do not mix unrelated refactors, docs updates, and feature or bug-fix changes in a single commit when they can be reviewed independently.
- Before committing changes, run `npm run lint`, `npm run format:check`, `npm run build`, and `npm test`.
- Prefer small, reviewable commits that preserve behavior at each step of a refactor.

## Commit Conventions

- Prefer Conventional Commit style prefixes such as `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, and `ci:`.
- Keep the subject line concise and focused on the primary change in that commit.
- A single commit should represent one reviewable unit of change.
- Do not hide behavior changes inside `chore:` or `docs:` commits.
- Use `refactor:` only when behavior is intended to stay unchanged; if behavior changes, use a more accurate prefix.

## Agent Execution Rules

- Do not perform destructive git operations such as `git reset --hard`, force-pushes, or overwriting unrelated uncommitted user changes unless explicitly requested.
- Do not change secrets, `.env` files, release credentials, or production deployment settings unless explicitly requested.
- Do not update versions, lockfiles, or release artifacts unless the task clearly requires it.
- Prefer the smallest relevant verification command first; if validation was not run, say so explicitly.
- Do not claim a change was verified if the relevant checks were not actually run.
- Keep changes scoped to the task. Avoid opportunistic edits in unrelated files.
- When code changes affect developer workflow, architecture, or shared rules, update the relevant documentation files in the same change.
- When reviewing code, report findings first, with concrete file references and impact, before giving summary commentary.

## Language Rules

- Agents must respond in Chinese throughout the entire interaction unless the user explicitly requests another language.
