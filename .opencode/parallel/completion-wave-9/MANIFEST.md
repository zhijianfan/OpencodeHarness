# Completion wave 9 — readiness fencing and coordinated child execution

Prerequisite full proof: 353 pass, 1 platform skip, eight typechecks/build/browser smoke/source attestation passed. Workers use Astra High and only their supplied source/context. Master integrates/tests after both return.

| Lane | Owned adapter files | Acceptance |
| --- | --- | --- |
| readiness | src/transfer-readiness.ts; src/transfer-topology.ts; test/transfer-readiness.test.ts; test/transfer-topology.test.ts | Preserve lease modes, expiry/draining/topology rollback and private target/redirect rules without module-global actor/proof state |
| child-execution | src/child-runner.ts; src/session-execution.ts; src/session-runtime.ts; test/child-runner.test.ts; test/session-execution.test.ts | Child admission/execution shares native coordinator with external resume/interrupt; exact child retries do not force extra model work |

Master owns Session facade/runtime-classification integration if needed beyond these files, native/extension event multiplexing, HTTP control routes and remaining domain extraction. No worker gate changes or native source edits.
