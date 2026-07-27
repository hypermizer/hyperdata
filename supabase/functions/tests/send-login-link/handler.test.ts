import { assertEquals } from "@std/assert";
import { handleLoginLink, type LoginLinkDependencies } from "../../send-login-link/handler.ts";
import { serveLoginLink } from "../../send-login-link/index.ts";

const request = (origin = "https://hypermizer.github.io") => new Request("https://example.test/send-login-link", {
  method: "POST",
  headers: { origin },
});

function dependencies(overrides: Partial<LoginLinkDependencies> = {}): LoginLinkDependencies {
  return {
    allowedOrigin: "https://hypermizer.github.io",
    claim: () => Promise.resolve("claimed"),
    generate: () => Promise.resolve("https://example.test/magic"),
    send: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("login link sends only after a server-side claim", async () => {
  const events: string[] = [];
  const response = await handleLoginLink(request(), dependencies({
    claim: async () => { events.push("claim"); return "claimed"; },
    generate: async () => { events.push("generate"); return "https://example.test/magic"; },
    send: async (link) => { events.push(`send:${link}`); },
  }));

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { status: "sent" });
  assertEquals(events, ["claim", "generate", "send:https://example.test/magic"]);
});

Deno.test("login link rejects non-site browser origins before claiming", async () => {
  let claimed = false;
  const response = await handleLoginLink(request("https://attacker.example"), dependencies({
    claim: async () => { claimed = true; return "claimed"; },
  }));
  assertEquals(response.status, 403);
  assertEquals(claimed, false);
});

Deno.test("login link preflight permits only the hosted app origin", async () => {
  const response = await serveLoginLink(new Request("https://example.test/send-login-link", { method: "OPTIONS" }));
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("access-control-allow-origin"), "https://hypermizer.github.io");
});

Deno.test("login link enforces cooldown and hourly limits before generating", async () => {
  for (const limit of ["cooldown", "hourly_limit"] as const) {
    let generated = false;
    const response = await handleLoginLink(request(), dependencies({
      claim: async () => limit,
      generate: async () => { generated = true; return "unused"; },
    }));
    assertEquals(response.status, 429);
    assertEquals(generated, false);
  }
});

Deno.test("login link returns a generic provider failure without leaking details", async () => {
  const response = await handleLoginLink(request(), dependencies({
    send: () => Promise.reject(new Error("secret smtp detail")),
  }));
  assertEquals(response.status, 502);
  assertEquals(await response.json(), { error: "delivery_failed" });
});
