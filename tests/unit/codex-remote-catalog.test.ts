import test from "node:test";
import assert from "node:assert/strict";
import { getCodexRemoteCatalogResponse } from "../../src/app/api/v1/models/codexRemoteCatalog.ts";

type Deps = NonNullable<Parameters<typeof getCodexRemoteCatalogResponse>[1]>;
const model = (slug = "new-model", overrides: Record<string, unknown> = {}) => ({
  slug,
  display_name: "New model",
  base_instructions: "Model-specific agent instructions",
  model_messages: { instructions_template: "Complete model template", tools: { future: "keep" } },
  supported_reasoning_levels: [{ effort: "high", description: "High" }],
  shell_type: "unified_exec",
  visibility: "list",
  supported_in_api: true,
  priority: 0,
  support_verbosity: true,
  truncation_policy: { mode: "tokens", limit: 10000 },
  experimental_supported_tools: ["custom_tool"],
  service_tiers: [{ service_tier: "priority", label: "Fast" }],
  tool_mode: "code_mode_only",
  use_responses_lite: true,
  context_window: 400000,
  future_setting: { preserve: true },
  ...overrides,
});
const request = (query = "client_version=0.169.0") =>
  new Request(`https://gateway/v1/models?format=codex&${query}`, {
    headers: { Authorization: "Bearer gateway-key" },
  });
const dependencies = (overrides: Partial<Deps> = {}): Deps => ({
  publicCatalog: async () => Response.json({ data: [{ id: "codex/new-model" }] }),
  connections: async () => [{ id: "account-one", accessToken: "upstream-token" }],
  fetchCatalog: async () => Response.json({ models: [model()] }),
  bareAliasAllowed: async () => false,
  ...overrides,
});

test("preserves complete upstream prompts and tool settings for new models", async () => {
  const response = await getCodexRemoteCatalogResponse(request(), dependencies());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), {
    models: [{ ...model(), slug: "codex/new-model", upgrade: null }],
  });
});

test("auth rejection never fetches upstream credentials or metadata", async () => {
  let touched = false;
  const response = await getCodexRemoteCatalogResponse(
    request(),
    dependencies({
      publicCatalog: async () => Response.json({ error: "unauthorized" }, { status: 401 }),
      connections: async () => {
        touched = true;
        return [];
      },
    })
  );
  assert.equal(response.status, 401);
  assert.equal(touched, false);
});

test("uses only permitted public IDs and never invents a bare alias", async () => {
  const response = await getCodexRemoteCatalogResponse(
    request(),
    dependencies({
      publicCatalog: async () =>
        Response.json({ data: [{ id: "cx/new-model" }, { id: "openai/denied" }] }),
      fetchCatalog: async () =>
        Response.json({ models: [model(), model("denied"), model("hidden-by-operator")] }),
    })
  );
  const body = await response.json();
  assert.deepEqual(
    body.models.map((m: { slug: string }) => m.slug),
    ["cx/new-model"]
  );
});

test("quota-exclusive and combos-only catalogs do not disclose provider models", async () => {
  let fetched = false;
  const response = await getCodexRemoteCatalogResponse(
    request(),
    dependencies({
      publicCatalog: async () => Response.json({ data: [{ id: "qtSd/pool" }] }),
      connections: async () => {
        fetched = true;
        return [];
      },
    })
  );
  assert.deepEqual(await response.json(), { models: [] });
  assert.equal(fetched, false);
});

test("preserves gateway authentication and removes pagination for the complete list", async () => {
  await getCodexRemoteCatalogResponse(
    request("client_version=0.169.0&limit=1&after=x"),
    dependencies({
      publicCatalog: async (r) => {
        const url = new URL(r.url);
        assert.equal(r.headers.get("Authorization"), "Bearer gateway-key");
        assert.equal(url.searchParams.has("format"), false);
        assert.equal(url.searchParams.has("limit"), false);
        assert.equal(url.searchParams.has("after"), false);
        assert.equal(url.searchParams.get("configuredOnly"), "true");
        return Response.json({ data: [{ id: "codex/new-model" }] });
      },
    })
  );
});

test("passes the requesting version and refreshes even when version is unchanged", async () => {
  const seen: string[] = [];
  const deps = dependencies({
    fetchCatalog: async (_c, version, signal) => {
      seen.push(version);
      assert.equal(signal.aborted, false);
      return Response.json({
        models: [model(undefined, { base_instructions: `revision ${seen.length}` })],
      });
    },
  });
  for (const version of ["0.169.0", "0.169.0", "0.170.0"]) {
    const response = await getCodexRemoteCatalogResponse(
      request(`client_version=${version}`),
      deps
    );
    assert.equal((await response.json()).models[0].base_instructions, `revision ${seen.length}`);
  }
  assert.deepEqual(seen, ["0.169.0", "0.169.0", "0.170.0"]);
});

test("connection exclusions and client compatibility filter full profiles", async () => {
  const response = await getCodexRemoteCatalogResponse(
    request(),
    dependencies({
      publicCatalog: async () =>
        Response.json({
          data: ["excluded", "too-new", "gpt-5.4", "internal"].map((id) => ({ id: `codex/${id}` })),
        }),
      connections: async () => [
        { id: "one", accessToken: "token", providerSpecificData: { excludedModels: ["excluded"] } },
      ],
      fetchCatalog: async () =>
        Response.json({
          models: [
            model("excluded"),
            model("too-new", { minimal_client_version: "0.170.0" }),
            model("gpt-5.4"),
            model("internal", { visibility: "hide" }),
          ],
        }),
    })
  );
  assert.deepEqual(
    (await response.json()).models.map((m: { slug: string; visibility: string }) => [
      m.slug,
      m.visibility,
    ]),
    [["codex/internal", "hide"]]
  );
});

test("account catalogs remain distinct and first eligible metadata wins", async () => {
  const ids: string[] = [];
  const response = await getCodexRemoteCatalogResponse(
    request(),
    dependencies({
      publicCatalog: async () =>
        Response.json({ data: [{ id: "codex/new-model" }, { id: "codex/second-model" }] }),
      connections: async () => [
        { id: "one", accessToken: "one-token" },
        { id: "two", accessToken: "two-token" },
      ],
      fetchCatalog: async (c) => {
        ids.push(c.id);
        return Response.json({
          models:
            c.id === "one"
              ? [model()]
              : [model(undefined, { base_instructions: "other" }), model("second-model")],
        });
      },
    })
  );
  const body = await response.json();
  assert.deepEqual(ids, ["one", "two"]);
  assert.equal(body.models.length, 2);
  assert.equal(body.models[0].base_instructions, model().base_instructions);
  assert.ok(!JSON.stringify(body).includes("one-token"));
  assert.ok(!JSON.stringify(body).includes("two-token"));
});

test("upstream failures cannot overwrite a good client cache with an empty success", async () => {
  for (const fetchCatalog of [
    async () => new Response("secret body", { status: 401 }),
    async () => {
      throw new Error("secret exception");
    },
    async () => Response.json({ models: [{ slug: "incomplete" }] }),
    async () =>
      Response.json({
        models: [model(undefined, { base_instructions: "", model_messages: null })],
      }),
  ]) {
    const response = await getCodexRemoteCatalogResponse(request(), dependencies({ fetchCatalog }));
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes("secret"));
  }
});

test("one broken account does not suppress another account's valid catalog", async () => {
  const response = await getCodexRemoteCatalogResponse(
    request(),
    dependencies({
      connections: async () => [
        { id: "one", accessToken: "token" },
        { id: "two", accessToken: "token" },
      ],
      fetchCatalog: async (c) =>
        c.id === "one" ? new Response(null, { status: 403 }) : Response.json({ models: [model()] }),
    })
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).models.length, 1);
});

test("rejects missing and invalid client versions before making network requests", async () => {
  for (const query of [
    "",
    "client_version=../../main",
    "client_version=1",
    "client_version=0.169.0%0D%0AInjected",
  ]) {
    const response = await getCodexRemoteCatalogResponse(
      request(query),
      dependencies({
        publicCatalog: async () => {
          throw new Error("must not run");
        },
      })
    );
    assert.equal(response.status, 400);
  }
});

test("authorized bare routes retain full metadata for resumed sessions without picker duplicates", async () => {
  const response = await getCodexRemoteCatalogResponse(
    request(),
    dependencies({
      bareAliasAllowed: async (r, slug) => {
        assert.equal(r.headers.get("authorization"), "Bearer gateway-key");
        return slug === "new-model";
      },
    })
  );
  const body = await response.json();
  assert.deepEqual(body.models, [
    { ...model(), slug: "codex/new-model", upgrade: null },
    { ...model(), visibility: "hide", upgrade: null },
  ]);
});
