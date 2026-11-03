# API task recovery

When submitting to ComfyUI's `/prompt` endpoint, API clients can optionally
provide a stable `extra_data.extra_pnginfo.workflow.id` to enable task recovery.
The workflow ID and node ID identify the node; request parameters and credential
fingerprints keep different inputs and API keys separate.

Without a stable workflow/node identity, each invocation runs independently.
It does not save recovery records or reuse tasks across requests. Query retries
still apply within that invocation. Creation requests are never automatically
retried.

Doubao and MiniMax creation requests include an `Idempotency-Key`, saved before
the POST when recovery is enabled. The same logical task keeps the same key;
changing inputs, credentials, node identity or generation produces another key.
Invocations without a stable identity receive independent keys. Older recovery
records written without a key are preserved without retroactively assigning one.
The upstream documents replaying the same POST and body with the same key;
it does not document a GET lookup by key. When Run finds a `creating` record with
a saved key, it replays the POST once with that key and the same request body,
then resumes polling using the returned task ID. Request fingerprints ensure
changed parameters cannot reuse that record or key. There is no retry loop
within a Run. Legacy records without a key remain blocked from replay.

If the remote task has definitively failed (`failed` or `failure`), the next Run
starts one new attempt with a new key. That attempt and key are persisted before
POST, so a lost creation response is recovered using the same retry key. There
is no automatic loop creating tasks within a Run. Each new attempt may incur
charges. Query, download, missing-task and configuration errors do not trigger
a new attempt.

Browser workflows receive a node recovery ID automatically. Save the workflow
to preserve it across reloads. Keep inputs, seed and generation unchanged to
resume a task. To start another video, click **Generate new video** and confirm,
then click **Run** when the button shows **Ready for new generation — click Run**.

Recovery uses the saved query address, without requiring fresh route discovery.
Records live under `benpay-video-tasks` in the ComfyUI user directory and contain
task IDs, query addresses and fingerprints. Saved error diagnostics include prompt
text and media inputs; API key values, tokens and URL query values are redacted. Corrupt
records stop automatic creation.

If a creation result is unconfirmed, check the remote task list before
regenerating. The provider may already be processing the original request, and
another task may incur another charge.
