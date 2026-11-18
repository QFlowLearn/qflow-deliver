# Contributing to QFlow Deliver

Start with [README.md](README.md). Keep HTTP parsing, authorization, and platform bindings at their existing boundaries. Preserve immutable published versions, durable learner receipts, and tenant-scoped data access.

Test observable behavior through actual module, Worker, database, or browser interfaces. Use generated local fixtures and synthetic identities. Do not commit credentials, learner data, production configuration, or operational logs.

Oxlint enforces Landmines' `no-test-doubles` rule. Use the real local D1, queue, email, and Workflow bindings. Queue observation and fault controls must forward successful operations to the native binding. Use MSW handlers for external HTTP services; unexpected requests fail the test. Keep network handlers and native workflow gates within the test lifecycle.

Lint uses the pinned `tsrs` backend for type-aware promise checks. Await or return work when its caller can own it. Handle expected failures in the owning feature's error state; report unexpected UI task failures through `reportUiError`. A bare `void` does not handle a rejected promise. Keep the full TypeScript checks in `pnpm typecheck` alongside lint.

Contributions are provided under AGPL-3.0-only. Preserve third-party notices. Report security issues privately.
