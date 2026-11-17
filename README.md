# QFlow Deliver

QFlow Deliver is an open-source assessment delivery platform. It consumes QTI assessment content and manages learner attempts, timing, accommodations, results, and LMS connections.

Pair it with [QFlow Author](https://github.com/QFlowLearn/qflow-author), or integrate another authoring system through QTI packages. The [QTI library](https://github.com/LongsightGroup/qti3) handles item rendering and response processing.

## Run locally

Install Node 24 and pnpm 10.29.2.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The foreground development command starts the local Worker and web application, prepares local fixtures, and prints the learner and staff URLs. Stop it with Ctrl+C. Local configuration contains synthetic test credentials and emulated storage. Do not expose it as a production service or use it with real learners.

Optional modes are `pnpm dev:preview`, `pnpm dev:services`, and `pnpm dev:access-code`. The default demo uses generated fixtures. To use your own QTI ZIP, set `QFLOW_DEMO_PACKAGE` to its path and run `pnpm dev -- --demo-source zip`. An absent or invalid path is an error.

## Architecture

- `apps/harbor-web/`: learner and instructor interface.
- `workers/runtime/`: HTTP APIs, attempt coordination, authentication, and background processing.
- `packages/`: shared protocols, content models, and database schema.

Durable Objects coordinate attempts. D1 stores relational data, R2 stores packages and assets, and Queues and Workflows handle asynchronous operations. Names such as `harbor` remain in module and binding identifiers. The product is QFlow Deliver.

Production deployment files, credentials, account identifiers, and operational records are not included.

## Development

```sh
pnpm typecheck
pnpm test
pnpm build:web
pnpm test:e2e:delivery
```

Run `pnpm verify` for all checks. Browser tests require `pnpm exec playwright install chromium`.

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately through the repository’s **Security → Report a vulnerability** form.

## License

Licensed under the **GNU Affero General Public License v3 (AGPL v3)**. See [LICENSE](LICENSE). Third-party components retain their own license notices.
