# H2 runtime authoring checkpoint

This checkpoint preserves work in progress. It does not qualify the Temporal
runtime, complete H2/B03, or satisfy the original IFPMIC AX acceptance cases.

## Prior verified baseline

Commit `d8249ec9e7aefd7e94c202311ff9d98d03321adb` records the H2 SQL
foundation gate: 361 passing cases. That result applies to its frozen sources,
not to the newly authored runtime modules or tests in this checkpoint.

## Included work

- Eight `services/ifpmic_api/execution_*.py` modules draft protocol encoding,
  authenticated SQL access, read-only READY workspace validation, execution
  identity, Temporal transport, outbox dispatch, activities, and workflow logic.
- Two TC-authored test modules contain 10 protocol and 6 workspace cases.
  They have not been executed.
- Four `h2-prebinding-*.json` records preserve the discovered incident-reporting
  gap, the proposed append-only migration 004, and independent/TC authoring
  reviews of amendment SHA
  `79360620e0d342e2fc25258bffd65ef216fe5b89dc45fd99213c81884ebeb1ff`.
  Reviews approve the plan only, not implementation or runtime execution.
  The amendment's original pending-status field is preserved as reviewed bytes;
  the separate review records provide its subsequent authoring decisions.

## Incomplete dependencies and validation

Migration 004 is not included. The dispatcher's prebinding incident path depends
on it and must not be treated as implemented against migration 003 alone.
The private manifest/config loader and executable launcher are also pending.

Further work includes migration and runtime source review, manifest/build
validation, SDK failure privacy checks, and a frozen test inventory and bounded
runner. Actual PostgreSQL/Temporal integration must then prove crash recovery,
lease fencing, admission, projection receipt retries, and history handling,
alongside the preserved SQL and H1 regressions. The final AX workflow
visualization remains pending.

Checkpoint validation is limited to Python AST parsing, JSON parsing and source
hash checks. No product imports, pytest runs, migrations, databases or Temporal
services were executed for this checkpoint. Original input ZIP/DOCX files are
excluded from this commit.
