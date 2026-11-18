# Contributing to QFlow Deliver

Start with [README.md](README.md). Keep HTTP parsing, authorization, and platform bindings at their existing boundaries. Preserve immutable published versions, durable learner receipts, and tenant-scoped data access.

Test observable behavior through actual module, Worker, database, or browser interfaces. Use generated local fixtures and synthetic identities. Do not commit credentials, learner data, production configuration, or operational logs.

Oxlint enforces Landmines' `no-test-doubles` rule. Use the real local D1, queue, email, and Workflow bindings. Queue observation and fault controls must forward successful operations to the native binding. Use MSW handlers for external HTTP services; unexpected requests fail the test. Keep network handlers and native workflow gates within the test lifecycle.

Contributions are provided under AGPL-3.0-only. Preserve third-party notices. Report security issues privately.
