# Plan: from a one-person reviewer to a review system

Status: draft, 2026-10-03, decisions settled with the owner the same day (see 09).
Nothing here is built yet; `docs/` outside this folder describes what runs today.

The current tool (v1) reviews a PR's diff on demand and posts one comment when asked.
The goal is a self-hosted review system: several accounts and providers managed from
the web, review targets beyond "my PRs" and beyond PRs, several review modes (fast
diff-only, repo-aware, security-focused, …), several outputs, and a real frontend.

| Document | Answers |
|---|---|
| [01-assessment.md](01-assessment.md) | What v1 does well, what has to change and why |
| [02-vision.md](02-vision.md) | Product direction, principles, feature ideas, non-goals |
| [03-architecture.md](03-architecture.md) | Target architecture and the technology decisions (Vue, Tailwind, SSE vs WebSockets, Hono, REST vs `gh`, encryption, auth) |
| [04-review-engine.md](04-review-engine.md) | Modes, profiles, providers and models, chunking, incremental reviews, outputs |
| [05-data-and-api.md](05-data-and-api.md) | Database schema and HTTP/SSE API for v2 |
| [06-web-ui.md](06-web-ui.md) | Pages, flows, components, frontend stack and build |
| [07-security.md](07-security.md) | Threat model and controls, especially for web-managed tokens and repo-aware reviews |
| [08-roadmap.md](08-roadmap.md) | Phases, deliverables, acceptance criteria, sizes, order |
| [09-open-questions.md](09-open-questions.md) | Decisions taken on 2026-10-03, open-source prep, policy note, facts to verify |

How to read: 01 → 02 → 08 gives the picture in ten minutes. 03–07 are the
specifications a phase is built against; each phase in 08 names the sections it
implements.
