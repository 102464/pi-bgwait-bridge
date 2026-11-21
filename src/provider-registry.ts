/**
 * Provider registration against pi-subagents 0.89.2.
 *
 * The documented seam is `registerBackgroundWorkProvider` from
 * `pi-subagents/background-work`. `snapshotBackgroundWork` reads the provider map behind
 * `Symbol.for("pi-subagents.background-work.v1")`, and `registerBackgroundWorkProvider`
 * validates and stores into that same map ("a new provider with the same name replaces the
 * old callback, and the old disposer cannot remove the replacement").
 *
 * Two paths, both into that one registry:
 *  - `registerProviderSync` writes the validated shape synchronously, so the provider is
 *    visible to `bg_wait` before the first model turn (an extension factory cannot await).
 *  - `upgradeToOfficial` replaces it with the official function's registration when
 *    pi-subagents is importable from this package's module root. Replacement is by name,
 *    so the upgrade is idempotent and reload-safe.
 */
import { SUBAGENTS_PROVIDER_REGISTRY_KEY } from "../src/constants.ts";

export interface ProviderShape {
  name: string;
  wakeChannels: readonly string[];
  listActiveWork(
    context?: { sessionId: string; sessionIds: readonly string[] },
  ): readonly { id: string; sessionId: string }[];
  reconcile?(context: { sessionId: string; sessionIds: readonly string[]; nowMs: number }): void;
}

interface RegistryShape {
  version: 1;
  providers: Map<string, ProviderShape>;
}

export type RegisterResult = {
  mode: "official" | "registry";
  dispose: () => void;
  note?: string;
};

function registry(): RegistryShape {
  const globalObject = globalThis as Record<symbol, unknown>;
  const key = Symbol.for(SUBAGENTS_PROVIDER_REGISTRY_KEY);
  const existing = globalObject[key];
  if (existing && typeof existing === "object") {
    const candidate = existing as RegistryShape;
    if (candidate.version === 1 && candidate.providers instanceof Map) return candidate;
  }
  const created: RegistryShape = { version: 1, providers: new Map() };
  globalObject[key] = created;
  return created;
}

/** Mirror pi-subagents' own validation so a malformed provider cannot poison the registry. */
function validate(provider: ProviderShape): ProviderShape {
  const allowed = ["name", "listActiveWork", "wakeChannels", "reconcile"];
  const unknown = Object.keys(provider).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`Background-work provider has unknown fields: ${unknown.join(", ")}`);
  if (typeof provider.name !== "string" || provider.name.trim() !== provider.name || provider.name.length === 0) {
    throw new Error("Background-work provider name must be a non-empty trimmed string");
  }
  if (typeof provider.listActiveWork !== "function") throw new Error("provider must expose listActiveWork()");
  if (provider.wakeChannels !== undefined) {
    const channels = provider.wakeChannels;
    if (!Array.isArray(channels)) throw new Error("wakeChannels must be an array");
    if (new Set(channels).size !== channels.length) throw new Error("wakeChannels must not contain duplicates");
    for (const channel of channels) {
      if (typeof channel !== "string" || channel.length === 0 || channel.length > 256) {
        throw new Error("wakeChannels entries must be non-empty strings of at most 256 characters");
      }
    }
  }
  return provider;
}

export function registerProviderSync(provider: ProviderShape): RegisterResult {
  const validated = validate(provider);
  const current = registry();
  current.providers.set(validated.name, validated);
  return {
    mode: "registry",
    dispose: () => {
      if (current.providers.get(validated.name) === validated) current.providers.delete(validated.name);
    },
  };
}

/** Replace the synchronous registration with the official API's registration, if available. */
export async function upgradeToOfficial(provider: ProviderShape): Promise<RegisterResult | undefined> {
  try {
    const module = (await import("pi-subagents/background-work")) as {
      registerBackgroundWorkProvider?: (value: ProviderShape) => () => void;
    };
    if (typeof module.registerBackgroundWorkProvider !== "function") return undefined;
    const dispose = module.registerBackgroundWorkProvider(provider);
    return {
      mode: "official",
      dispose: () => {
        try {
          dispose();
        } catch {
          /* best effort */
        }
      },
    };
  } catch (error) {
    return {
      mode: "registry",
      dispose: () => {},
      note: `official import unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Provider names currently registered in this process. */
export function registeredProviderNames(): string[] {
  return [...registry().providers.keys()];
}
