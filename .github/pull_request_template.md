## What this changes

<!-- One or two sentences: what a user notices, or what is now true. -->

## How it was checked

<!-- Commands you ran, and what you tried by hand. -->

- [ ] `npm run lint` and `npm run typecheck`
- [ ] `npm run test:unit` (and `npm run mcp:selftest` if `mcp/` or shared `src/lib/` code changed)
- [ ] `cd src-tauri && cargo test` if Rust changed
- [ ] Tried it in the app (`npm run tauri dev`)

## Safety

<!-- Does this touch what runs against a database: the classifier, the policy,
approvals, the MCP server, the audit log? Say how it stays safe. Delete this
section if not. -->

## Changelog

<!-- A line for CHANGELOG.md under Unreleased, in the user's words. -->
