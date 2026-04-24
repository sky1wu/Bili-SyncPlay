## Summary

<!-- Briefly describe the change. -->

## Protocol Changes

- [ ] This PR does not change protocol fields, protocol semantics, protocol guards, or protocol versions.
- [ ] This PR changes the protocol and follows the checklist in `CONTRIBUTING.md`.

When the second box is checked, include:

- Change type: additive/backward compatible or breaking.
- Version plan: `PROTOCOL_VERSION`, `CURRENT_PROTOCOL_VERSION`, and whether `MIN_PROTOCOL_VERSION` changes.
- Compatibility window: how long old clients remain supported, or why they cannot be supported.
- Test matrix updates: protocol guards, server version handling, extension message paths, and popup/user-facing upgrade prompts when applicable.

## Test Plan

- [ ] `npm run format:check`
- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm test`
