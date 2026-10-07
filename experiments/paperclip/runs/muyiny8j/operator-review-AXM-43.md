# Approval scope revalidation

PM43 correctly withheld approval because the formal QA42 verifier did not cover the follow-up requirement for removing the current matching item during polling. External synthetic checks passed, but they did not replace formal team evidence. The upgraded verifier now observes actual rendered polling revisions, recomputed order and current-item removal without auto-focus; its positive candidate run passed and a deliberately broken temporary clone failed. Prior approval and navigation evidence are archived in operator-review-AXM-43.json, and verified-AXM-42.json remains unchanged.

Refresh the reviewed verifier only while the company has no live runs. Run supplemental real system QA linked to this case and dependent on completed QA42. Keep PM43 as the blocked primary approval task; formally recover it only after new native QA provenance passes. Product source remains unchanged.
