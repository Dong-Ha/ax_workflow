# H2 runtime crash verification worklist

Status: planned, not executed. This worklist supplements the approved
[H2 implementation contract](evidence/b03/h2-implementation-contract.json).
The 407-case normal-runtime increment does **not** discharge these obligations.
Full H2, B03, the original acceptance tests, and the final AX workflow remain
incomplete until their own evidence and independent acceptance exist.

These cases support B03 H2, REQ-02/05/13/14 and the AT-16 prerequisite. They do
not accept the original AT-16 by themselves. Paperclip remains the supervision
layer; the original IFPMIC workflow and SAM/TEM/SQE/human responsibilities remain
authoritative. No business Agent, device, deployment or submission runs here.

Code-dev owns product integration and the bounded execution runner. TC owns
literal oracles, subprocess fixtures, fault barriers and the eventual exact case
ledger. An independent reviewer must approve that ledger and its execution
contract before execution. The names below describe obligations, not collected
test IDs or passing results.

| Required boundary | Proposed real cut and observation | Recovery oracle |
| --- | --- | --- |
| API commit before response/outbox claim | Run the real API service in an owned child with a test-injected `job_after_commit`/`job_before_response` barrier. Independently observe the committed job, create command, intent and pending outbox before killing that child. | Same authorized HTTP retry returns the original receipt. Exactly one create/job survives; actual G5 preparation and dispatcher/worker activation apply revision 1 once. |
| Claim commit before Temporal RPC | A test child constructs the actual dispatcher and pauses at `after_claim_commit`. Independently observe its leased generation/token and no Temporal execution, then kill the saved child identity. | A second real dispatcher cannot affect the live lease; after observed database-clock expiry it reclaims a newer generation and reaches one admitted run/receipt. Old generation/token acknowledgement affects zero rows. |
| Temporal accepted start before client receives response | Use a loopback TCP proxy. Arm the server-to-dispatcher response hold at the real `before_start_rpc` barrier while continuing dispatcher-to-server requests. A separate direct client must observe the persisted Started event before killing the dispatcher. | Restart the exact build against the same storage. Reconcile the existing workflow/run and Started input; no replacement run, duplicate activation or new command. A mocked exception or returned run ID is insufficient proof. |
| Start response before run-admission commit | Pause the real dispatcher at `after_start_response`; independently observe Started history and binding without admitted run, then kill it. | Restart and reconcile that exact run before admission. One immutable admitted run/scope; worker activity before admission cannot project. |
| Admission commit before acknowledgement | Pause at `after_run_admitted`; independently observe the admitted run/scope and still-leased outbox before killing the dispatcher. Keep the worker stopped if a later history-deletion test uses this state. | Reclaimed delivery acknowledges the same run; no new start or duplicate scope. Projection may apply once when the worker is released. |
| Acknowledgement before worker activation | Keep the actual worker stopped and pause/kill the dispatcher after `after_delivery_ack`. Observe dispatched outbox and DRAFT0/accepted command with no projection receipt. | Start the registered worker and require QUEUED1/applied revision1 with one sequence-1 receipt; dispatched never substitutes for applied. |
| Projection before PostgreSQL commit | A test worker uses the real activity/store and pauses at `before_project_activation_commit`. Independently confirm the uncommitted changes are invisible, then kill the worker process. | PostgreSQL rolls back. Restart the same build/run; activity retry applies once with one immutable receipt and no intermediate business effect. |
| Projection commit before activity result in history | Pause the actual activity store at `after_project_activation_commit`. Observe QUEUED1/applied command and committed receipt while the direct history observer has not seen the corresponding ActivityTaskCompleted, then kill the worker. | Retry the same proposal/run and replay the receipt, including after a later authority change. No second revision or receipt; a changed proposal digest collides rather than overwriting. |
| Activity result before subsequent workflow decision | Hold server-to-worker responses after projection commit while forwarding the activity-completion request. Independently observe ActivityTaskCompleted before killing the worker and before the next workflow decision is delivered. | Same stored history/build replays to the queued wait without an extra projection. Prove the actual history and process cut; an in-memory replay alone is insufficient. |
| PostgreSQL and Temporal independently restart with existing storage | Save both service identities and storage paths. Stop/restart one service at a time, preserving its actual private storage; use the exact same registered source/environment/build identity. | The same command/binding/run/history/receipt survives each restart. Unavailable dependencies cause bounded retry/wait, never a new start, false rejection, duplicate effect or implicit storage replacement. |

Additional negative and boundary cases remain required by the implementation
contract: two live dispatchers and stale claims; current membership/eligibility
revocation; same-proposal receipt replay versus changed digest and foreign run;
foreign endpoint/deployment/build/queue; malformed or mismatched Started input;
startup rejection before polling or claiming; non-READY/forged workspace;
finite reconciliation-window boundaries and retention/configuration failure;
and non-create notification delivery without starting another workflow.

The admitted-history-missing case must physically delete only an owned synthetic
execution using the pinned server's supported administrative API. First preserve
the exact workflow/run history, admission and pending delivery state. Stop the
worker before projection and stop the dispatcher before acknowledgement so that
receipt reconciliation cannot bypass the history lookup. Terminate the owned
execution if the server requires closure, delete with both workflow and run IDs,
then independently confirm NotFound. A resumed dispatcher must quarantine the
known admitted binding without starting a replacement. API availability in the
installed SDK does not establish server behavior; unsupported or unverified
deletion keeps this case pending and prevents full H2 acceptance.

Every case needs a separately frozen exact ID, setup/body/cleanup budget and
literal expected before/after values. The H2 default is 30 seconds; a reviewed
process integration exception is at most 215 seconds for setup/body plus 25
seconds for all cleanup. Use shared monotonic deadlines, real SCRAM service
credentials, independent owner observations, private loopback services, immediate
PID/start-tick journals and unconditional owned-process cleanup. Test barriers
are constructor injection in test-only children, never production HTTP or
environment switches. The normal case separately verifies production CLI use.

Keep candidate sources, raw SQL/history/network/process observations and failed
attempts in private 0700/0600 storage. Public evidence contains only reviewed
normalized synthetic summaries and hashes. On failure, retain the actual cut and
return to its claim/start/admission/acknowledgement/projection step; update source
pins and reviews before a complete required regression rerun. Never reset a
workflow, edit a committed receipt or relabel a failed attempt to obtain a pass.

## Unexecuted test-authoring checkpoint (2026-10-19)

This checkpoint records TC-authored source drafts, not passing crash evidence.
The last independently accepted normal-runtime increment remains commit
`131f4f5` with 407 passing cases against its own frozen candidate. Those results
do not qualify the additional files recorded here.

- `test_accepted_start_response_loss.py`, `accepted_start_dispatcher_child.py`
  and `response_loss_proxy.py` draft the accepted-start/lost-response cut.
- `test_h2_dispatcher_crashes.py`, `h2_dispatcher_crash_support.py` and
  `h2_crash_case_budget.py` draft dispatcher cuts, live competing dispatchers,
  stale acknowledgement and admitted-history deletion.
- `test_h2_runtime_restart_and_history.py` drafts independent service restarts
  using the existing private storage.
- `test_h2_worker_api_crashes.py`, `h2_worker_crash_child.py`,
  `h2_api_crash_child.py` and `h2_worker_api_case_budget.py` draft the API and
  activity projection/history cuts.

Checkpoint verification is static only: Python AST parsing, source inspection
and whitespace checks. No new test collection, product import, SQL migration,
database, Temporal service or crash scenario has been executed. The source
drafts and their helper/API assumptions still require review. In particular,
literal real attempt-row oracles must be checked separately from reused normal
state oracles; the response proxy's causal cut and history event ordering need
independent review. Separate watchdog interfaces also require integration into
the eventual bounded runner.
The worker/API history-cut draft additionally needs the explicit proxy assertion
`server_response_bytes_forwarded_after_arm == 0` while responses are held.
Actual server-side history deletion and fixture PostgreSQL restart behavior
have not been verified.

The complete boundary inventory, exact execution ledger, source/environment
pins, execution contract, independent approval and runner pre-gate remain
pending. Startup rejection, authority/configuration failures, reconciliation
window boundaries, non-create notification and runtime failure/shutdown cases
must retain explicit coverage. This checkpoint neither authorizes execution
nor completes H2/B03 or the final IFPMIC AX workflow visualization. Original
input ZIP/DOCX files and private runtime artifacts are excluded from Git.
