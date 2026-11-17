# Synthetic QFlow part settings package

Generated on 2026-10-07 by QFlow's real question/part persistence, revision-bound loader, validated QTI 3 writer and canonical package conversion using qti3 0.13.0. The disposable assessment has two single-answer questions, linear navigation, simultaneous submission, a part minimum of 60 seconds, a part maximum of 300 seconds and candidate instructions. No customer or private QA content is included.

Regenerate in QFlow with a migrated, explicitly configured disposable QA database:

```sh
QFLOW_SETTINGS_HANDOFF=/tmp/qflow-part-settings.zip deno test -A tests/assessment_settings_handoff_test.ts
```

Base64-encode that ZIP into `qflow-part-settings.zip.b64` after checking its contents. The Harbor runtime integration publishes the complete canonical artifact, launches an assignment with learner overrides, checks actual timing enforcement and compares every immutable version object before and after instructor policy changes.

`scoped-instructions.xml` is an independent synthetic test for browser coverage. It replaces only the test document in that package, retaining both original questions and the part timing limits. It adds candidate instructions at test, part and two section scopes, an instruction-only reference image, and private scorer content that must never reach the learner. The desktop and narrow-screen workflows check keyboard navigation and reload without weakening the minimum-time policy.
