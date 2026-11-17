import { z } from "zod";
import { getProviderConnections } from "@/lib/db/providers";
import { resolveProxyForConnection } from "@/lib/db/settings";
import { isModelExcludedByConnection } from "@/domain/connectionModelRules";
import { getCodexCliRsHeaders } from "@/shared/constants/codexClient";
import {
  compareCodexDiscoveryVersions,
  isCodexDiscoveryModelExcluded,
} from "@/shared/services/codexDiscoveryPolicy";
import { buildErrorBody } from "@omniroute/open-sse/utils/error.ts";
import { buildCodexModelsUrl } from "../../providers/[id]/models/discovery/codex";
import { createCodexDiscoveryFetch } from "../../providers/[id]/models/discovery/codexRoute";
import { getUnifiedModelsResponse } from "./catalog";
import { catalogJsonResponse } from "./catalogPagination";

const clientVersionSchema = z.string().regex(/^\d{1,9}\.\d{1,9}\.\d{1,9}$/);
// Preserve every upstream field, particularly model_messages, tool settings and
// instructions. A generic model template can silently erase Codex's agent prompt.
const modelSchema = z
  .object({
    slug: z.string().trim().min(1),
    display_name: z.string(),
    supported_reasoning_levels: z.array(
      z.object({ effort: z.string(), description: z.string() }).passthrough()
    ),
    shell_type: z.enum(["unified_exec", "shell_command", "default", "local", "disabled"]),
    visibility: z.enum(["list", "hide", "none"]),
    supported_in_api: z.boolean(),
    priority: z.number().int(),
    support_verbosity: z.boolean(),
    truncation_policy: z
      .object({ mode: z.enum(["tokens", "bytes"]), limit: z.number().int() })
      .passthrough(),
    experimental_supported_tools: z.array(z.string()),
    base_instructions: z.string().optional(),
    model_messages: z
      .object({ instructions_template: z.string().optional() })
      .passthrough()
      .nullish(),
    minimal_client_version: z.string().optional(),
  })
  .passthrough()
  .refine((m) =>
    Boolean(m.base_instructions?.trim() || m.model_messages?.instructions_template?.trim())
  );
const catalogSchema = z.object({ models: z.array(modelSchema) });
type Model = z.infer<typeof modelSchema>;
type Connection = {
  id: string;
  accessToken?: unknown;
  providerSpecificData?: unknown;
};
type Dependencies = {
  publicCatalog: typeof getUnifiedModelsResponse;
  connections: () => Promise<Connection[]>;
  fetchCatalog: (connection: Connection, version: string, signal: AbortSignal) => Promise<Response>;
};

const defaults: Dependencies = {
  publicCatalog: getUnifiedModelsResponse,
  connections: () => getProviderConnections({ provider: "codex", isActive: true }),
  fetchCatalog: async (connection, version, signal) => {
    const data = (connection.providerSpecificData || {}) as Record<string, unknown>;
    const account = [data.workspaceId, data.chatgptAccountId, data.accountId].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0
    );
    const proxy = await resolveProxyForConnection(connection.id, undefined, "codex");
    return createCodexDiscoveryFetch(proxy, "public-only")(buildCodexModelsUrl(version), {
      method: "GET",
      headers: {
        ...getCodexCliRsHeaders(version),
        version,
        Accept: "application/json",
        Authorization: `Bearer ${connection.accessToken}`,
        ...(account ? { "ChatGPT-Account-ID": account } : {}),
      },
      signal,
      retry: false,
    });
  },
};

/** Explicit opt-in: /v1/models?format=codex&client_version=<Codex version>. */
export async function getCodexRemoteCatalogResponse(
  request: Request,
  deps: Dependencies = defaults
): Promise<Response> {
  const url = new URL(request.url);
  const version = clientVersionSchema.safeParse(url.searchParams.get("client_version"));
  const headers = { "Cache-Control": "private, no-store" };
  if (!version.success) {
    return Response.json(buildErrorBody(400, "A valid client_version is required"), {
      status: 400,
      headers,
    });
  }

  // Reuse the normal auth, key scope, hidden-model and connection filters. The
  // remote ModelsResponse must be complete, so never paginate this internal list.
  url.searchParams.delete("format");
  url.searchParams.delete("limit");
  url.searchParams.delete("after");
  url.searchParams.set("configuredOnly", "true");
  const publicResponse = await deps.publicCatalog(new Request(url, request));
  if (!publicResponse.ok) return publicResponse;
  const publicBody = (await publicResponse.json()) as { data: Array<{ id: string }> };
  const allowed = new Set(publicBody.data.map((m) => m.id));
  if (![...allowed].some((id) => id.startsWith("codex/") || id.startsWith("cx/"))) {
    return catalogJsonResponse({ models: [] }, headers);
  }

  const models = new Map<string, Model>();
  let succeeded = false;
  try {
    const connections = await deps.connections();
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(8_000)]);
    // Sequential, with one total deadline: bounded upstream traffic even on large
    // account pools. Profiles from the highest-priority eligible account win.
    for (const connection of connections) {
      if (signal.aborted) break;
      if (typeof connection.accessToken !== "string" || !connection.accessToken) continue;
      try {
        const response = await deps.fetchCatalog(connection, version.data, signal);
        if (!response.ok) {
          console.warn(`[codex-catalog] upstream HTTP ${response.status}`);
          continue;
        }
        const parsed = catalogSchema.safeParse(await response.json());
        if (!parsed.success) {
          console.warn("[codex-catalog] invalid upstream model metadata");
          continue;
        }
        succeeded = true;
        for (const model of parsed.data.models) {
          if (isCodexDiscoveryModelExcluded({ id: model.slug })) continue;
          if (isModelExcludedByConnection(model.slug, connection.providerSpecificData)) continue;
          if (model.minimal_client_version) {
            const comparison = compareCodexDiscoveryVersions(
              model.minimal_client_version,
              version.data
            );
            if (comparison === null || comparison > 0) continue;
          }
          // One picker entry per model, using a permitted, explicit Codex route.
          // Do not turn a denied canonical ID into a permitted bare alias.
          const slug = [`codex/${model.slug}`, `cx/${model.slug}`].find((id) => allowed.has(id));
          if (!slug || models.has(slug)) continue;
          models.set(slug, { ...model, slug, upgrade: null });
        }
      } catch {
        // Never expose upstream bodies, tokens or exception messages.
        console.warn("[codex-catalog] upstream catalog unavailable");
      }
    }
  } catch {
    console.warn("[codex-catalog] connection lookup failed");
  }

  // A failed refresh must not replace the client's last good catalog with an
  // empty successful response. No cross-account/version cache or stale fallback.
  if (!succeeded) {
    return Response.json(buildErrorBody(502, "Codex model catalog is temporarily unavailable"), {
      status: 502,
      headers,
    });
  }
  return catalogJsonResponse({ models: [...models.values()] }, headers);
}
