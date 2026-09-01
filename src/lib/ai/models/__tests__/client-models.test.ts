/**
 * A client's own model, governed like ours.
 *
 * The endpoint is a URL somebody typed into a config form. Most of these tests
 * are about refusing it: an unvalidated endpoint means our server fetches
 * whatever a client points it at, with our egress and our credentials, which is
 * server-side request forgery with a settings page in front of it.
 *
 * The rest are about not overclaiming. A client's declared price is not a price
 * we verified, and losing that distinction turns the cost report into a number
 * nobody can stand behind.
 */
import {
  buildCatalog,
  CLIENT_MODEL_PREFIX,
  isClientModel,
  validateClientModel,
  validateEndpoint,
  type ClientModelInput,
  type ClientModelSpec,
} from "../client-models";
import { MODEL_REGISTRY } from "../registry";
import { selectModel } from "../router";

const allowAll = () => true;
const allowOnly = (host: string) => (h: string) => h === host;

function input(over: Partial<ClientModelInput> = {}): ClientModelInput {
  return {
    id: "acme-llm",
    endpoint: "https://llm.acme.example.com/v1/chat/completions",
    capabilityTier: "large",
    contextWindow: 128000,
    inputPricePer1kUsd: 0.002,
    outputPricePer1kUsd: 0.006,
    ...over,
  };
}

const ok = (over: Partial<ClientModelInput> = {}): ClientModelSpec => {
  const r = validateClientModel(input(over), { hostAllowed: allowAll });
  if (!r.ok) throw new Error(`expected valid: ${JSON.stringify(r.rejections)}`);
  return r.spec;
};

describe("the endpoint is untrusted input", () => {
  it.each([
    ["http://llm.acme.example.com/v1", "plaintext would put the prompt on the wire"],
    ["ftp://llm.acme.example.com", "not a fetchable scheme"],
    ["not a url", "unparseable"],
    ["", "missing"],
  ])("refuses %s (%s)", (endpoint) => {
    const r = validateClientModel(input({ endpoint }), { hostAllowed: allowAll });
    expect(r.ok).toBe(false);
  });

  it.each([
    "https://localhost/v1",
    "https://127.0.0.1/v1",
    "https://[::1]/v1",
    "https://10.0.0.5/v1",
    "https://192.168.1.10/v1",
    "https://172.16.0.1/v1",
    "https://169.254.169.254/latest/meta-data/",
    "https://db.internal/v1",
    "https://printer.local/v1",
  ])("refuses the internal address %s", (endpoint) => {
    // The specific attack: point the model endpoint at infrastructure only our
    // server can reach, and have us fetch it on request.
    const r = validateClientModel(input({ endpoint }), { hostAllowed: allowAll });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejections[0].reason).toMatch(/internal or loopback/);
  });

  it("refuses credentials embedded in the URL", () => {
    // They end up in logs, error messages and analytics payloads.
    const r = validateClientModel(input({ endpoint: "https://user:pw@llm.acme.example.com/v1" }), {
      hostAllowed: allowAll,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejections[0].reason).toMatch(/credentials/);
  });

  it("refuses a host that is not on the outbound allowlist", () => {
    // Validation alone is not enough. The host still has to be somewhere we
    // have decided we are willing to send inference traffic.
    const r = validateClientModel(input(), { hostAllowed: allowOnly("approved.example.com") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejections[0].reason).toMatch(/not on the outbound allowlist/);
  });

  it("accepts a real https endpoint on an allowed host", () => {
    expect(validateEndpoint("https://llm.acme.example.com/v1", allowOnly("llm.acme.example.com")).problem).toBeUndefined();
  });
});

describe("a client cannot shadow one of our models", () => {
  it("namespaces every client id", () => {
    expect(ok().id).toBe(`${CLIENT_MODEL_PREFIX}acme-llm`);
  });

  it("refuses an id that already carries the prefix", () => {
    // The prefix is ours to add; accepting it pre-applied lets a client reason
    // about the namespace.
    const r = validateClientModel(input({ id: "client:gpt-4o" }), { hostAllowed: allowAll });
    expect(r.ok).toBe(false);
  });

  it("keeps the Wolfpack model when ids somehow collide", () => {
    // Should be impossible given the prefix. Defined anyway, because
    // "impossible" plus "unchecked" is how a shadowing bug survives.
    const clash = { ...ok(), id: MODEL_REGISTRY[0].id } as ClientModelSpec;
    const catalog = buildCatalog(MODEL_REGISTRY, [clash]);
    const winner = catalog.find((m) => m.id === MODEL_REGISTRY[0].id)!;
    expect(isClientModel(winner)).toBe(false);
  });
});

describe("validation reports everything at once", () => {
  it("collects every problem rather than stopping at the first", () => {
    // Someone pasting a config wants all three mistakes now, not across three
    // round trips.
    const r = validateClientModel(
      input({ id: "!!", capabilityTier: "enormous" as never, contextWindow: 5, inputPricePer1kUsd: -1 }),
      { hostAllowed: allowAll },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rejections.map((x) => x.field).sort()).toEqual([
        "capabilityTier",
        "contextWindow",
        "id",
        "inputPricePer1kUsd",
      ]);
    }
  });
});

describe("a declared price is never presented as a verified one", () => {
  it("marks the spec so downstream cannot lose the distinction", () => {
    // We publish our own prices from vendor price lists. A client's numbers are
    // whatever they typed, and a total that mixes the two silently claims we
    // stand behind both.
    const spec = ok();
    expect(spec.priceDeclaredByClient).toBe(true);
    expect(spec.origin).toBe("client");
    expect(isClientModel(spec)).toBe(true);
  });

  it("marks our own models as ours", () => {
    for (const m of MODEL_REGISTRY) expect(isClientModel(m)).toBe(false);
  });
});

describe("the router treats a client model like any other", () => {
  const env = {} as unknown as NodeJS.ProcessEnv; // nothing of ours configured

  it("selects a client model when none of ours is available", () => {
    // The real bring-your-own-model case: the client has their own inference
    // and we have no keys deployed for them at all.
    const catalog = buildCatalog(MODEL_REGISTRY, [ok()]);
    const decision = selectModel({ requiredTier: "large" }, env, catalog);
    expect(decision.model.id).toBe(`${CLIENT_MODEL_PREFIX}acme-llm`);
    expect(isClientModel(decision.model)).toBe(true);
  });

  it("honours a pin to a client model", () => {
    // Without catalog-aware pins, "bring your own model" would mean "bring
    // your own model and never have it chosen".
    const catalog = buildCatalog(MODEL_REGISTRY, [ok()]);
    const decision = selectModel({ clientPin: `${CLIENT_MODEL_PREFIX}acme-llm` }, env, catalog);
    expect(decision.model.id).toBe(`${CLIENT_MODEL_PREFIX}acme-llm`);
    expect(decision.reason).toBe("client_pin");
  });

  it("still applies cost ordering across the mixed catalog", () => {
    // Cheapest wins regardless of origin. A client model priced below ours is
    // chosen, which is the point of letting them supply one.
    const cheap = ok({ id: "cheap", capabilityTier: "small", inputPricePer1kUsd: 0, outputPricePer1kUsd: 0 });
    const dear = ok({ id: "dear", capabilityTier: "small", inputPricePer1kUsd: 9, outputPricePer1kUsd: 9 });
    const decision = selectModel({ requiredTier: "small" }, env, buildCatalog([], [dear, cheap]));
    expect(decision.model.id).toBe(`${CLIENT_MODEL_PREFIX}cheap`);
  });

  it("does not change behavior for callers that pass no catalog", () => {
    // Every existing call site must be untouched by this feature.
    const withDefault = selectModel({ requiredTier: "small" }, env);
    const withRegistry = selectModel({ requiredTier: "small" }, env, MODEL_REGISTRY);
    expect(withDefault.model.id).toBe(withRegistry.model.id);
    expect(withDefault.reason).toBe(withRegistry.reason);
  });

  it("returns a decision rather than throwing when the catalog is empty", () => {
    // The router's standing contract. A client with a broken config must not
    // take the platform down.
    expect(() => selectModel({}, env, [])).not.toThrow();
  });
});
