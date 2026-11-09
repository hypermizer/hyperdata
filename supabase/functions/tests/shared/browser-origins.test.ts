import { assertEquals } from "@std/assert";
import { allowedBrowserOrigin } from "../../_shared/browser-origins.ts";
Deno.test("owner backend features allow only the configured private origin", () => {
  const check = (origin: string) => allowedBrowserOrigin(new Request("https://example.test", { headers: { origin } }), "https://3.131.225.164");
  assertEquals(check("https://3.131.225.164"), "https://3.131.225.164");
  assertEquals(check("https://hypermizer.github.io"), null);
  assertEquals(check("http://3.131.225.164"), null);
  assertEquals(check("https://3.131.225.164.evil.example"), null);
});
