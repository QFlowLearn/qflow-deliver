# Synthetic staged assessment fixtures

MIT-licensed synthetic questions. `test.xml` describes a 15-answer test with 30 alternatives.

`qflow-100.zip.b64` (base64-encoded ZIP) was built through QFlow's real adaptive construction and canonical package exporter on September 18, 2026, using the published qti3 0.12.0 packages and its synthetic enrichment test fixture. It contains 285 distinct single-choice questions, three difficulty levels, and 100 answers on every completed route. Correct choice: `a` (Nucleus). Category labels are Easy, Moderate, Hard; the audience is Grade 6 science. UUIDs identify disposable test data. No customer or ARC content is included.

Regenerate from QFlow with its migrated disposable test database:

```sh
QFLOW_ADAPTIVE_HANDOFF=/tmp/qflow-adaptive-handoff.zip deno test -A tests/assessment_adaptive_plans_test.ts
```

Review the package contents before replacing this fixture. The complete package is used by the browser handoff test to exercise the real authoring-to-delivery contract.
