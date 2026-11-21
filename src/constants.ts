/**
 * Wire constants for the two public surfaces this bridge consumes.
 *
 * Every name here was read from the installed packages, not from upstream `main`:
 *  - pi-background-tasks 2.6.10: `src/core/extension-api.ts`, `src/core/host-protocol.ts`
 *  - pi-subagents 0.89.2: `src/api/background-work.js` (registry key)
 * See SOURCE-AUDIT.md for the line-level trace.
 */

/** Shared provider registry symbol used by pi-subagents 0.89.2. */
export const SUBAGENTS_PROVIDER_REGISTRY_KEY = "pi-subagents.background-work.v1";

/** Provider name shown in `bg_wait` output as `<provider>/<id>`. */
export const PROVIDER_NAME = "pi-background-tasks";

/** pi-background-tasks EventBus v1 channels (extension API). */
export const BG_REQUEST_CHANNEL = "pi-background-tasks:request:v1";
export const BG_RESPONSE_CHANNEL = "pi-background-tasks:response:v1";
export const BG_TERMINAL_CHANNEL = "pi-background-tasks:terminal:v1";
export const BG_REQUEST_SCHEMA = "pi-background-tasks.extension-request.v1";
export const BG_RESPONSE_SCHEMA = "pi-background-tasks.extension-response.v1";
export const BG_TERMINAL_SCHEMA = "pi-background-tasks.extension-terminal.v1";

/** pi-background-tasks host EventBus v1 channels (trusted session launch record). */
export const HOST_REQUEST_CHANNEL = "pi-background-tasks:host:request:v1";
export const HOST_RESPONSE_CHANNEL = "pi-background-tasks:host:response:v1";
export const HOST_CHANGED_CHANNEL = "pi-background-tasks:host:changed:v1";
export const HOST_REQUEST_SCHEMA = "pi-background-tasks.host-request.v1";
export const HOST_RESPONSE_SCHEMA = "pi-background-tasks.host-response.v1";
export const HOST_CHANGED_SCHEMA = "pi-background-tasks.host-changed.v1";

/** Wake channels: these only shorten polling; validated snapshots stay authoritative. */
export const WAKE_CHANNELS = [
  BG_TERMINAL_CHANNEL,
  HOST_CHANGED_CHANNEL,
  BG_RESPONSE_CHANNEL,
] as const;

/** Subagent control events that can end a wait early (supervisor / intercom asks). */
export const SUBAGENT_CONTROL_CHANNEL = "subagent:control-event";
export const SUBAGENT_CONTROL_INTERCOM_CHANNEL = "subagent:control-intercom";

/** Poll interval bounds mirror pi-subagents' own wait loop (250ms floor, 1000ms default). */
export const MIN_POLL_MS = 250;
export const DEFAULT_POLL_MS = 1000;

/** Default unified wait window; matches the 2h example in the task brief. */
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** A bg_run is considered "controlled by a wait" for notification coordination. */
export const TERMINAL_STATUSES = new Set(["completed", "failed", "killed"]);

/** Request/response correlation timeout for one EventBus round trip. */
export const REQUEST_TIMEOUT_MS = 8000;
