import { assertEquals } from "@std/assert";
import { paperCommandFailureResponse } from "../../paper-command/index.ts";

Deno.test("database serialization conflict remains a stale-account response", async () => {
  const response = paperCommandFailureResponse({
    code: "40001",
    message: "stale paper account version",
  });
  assertEquals(response.status, 409);
  assertEquals(await response.json(), { error: "stale_account" });
});

Deno.test("unexpected command failures remain server errors", async () => {
  const response = paperCommandFailureResponse(new Error("unexpected"));
  assertEquals(response.status, 500);
  assertEquals(await response.json(), { error: "paper_command_failed", detail: "unexpected" });
});
