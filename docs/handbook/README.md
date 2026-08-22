# 21.gifts api handbook

This handbook is **mandatory**. Every exported function/class and every HTTP
endpoint must have a section. CI (`bun run handbook:check` / `node scripts/check-handbook.mjs`)
fails the PR otherwise.

- Functions: `## Function: name`
- Endpoints: `## Endpoint: METHOD /path`

This repo has no UI screens. UI screens live in `21gifts/app` and `21gifts/website`.
A PR that adds an export or route without a handbook section is rejected.
