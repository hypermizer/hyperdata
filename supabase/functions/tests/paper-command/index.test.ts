import { assertEquals } from "@std/assert";
import { paperCommandFailureResponse, projectCommandPortfolio } from "../../paper-command/index.ts";

Deno.test("command risk uses live marks for the whole portfolio, including XYZ shorts", () => {
  const projection = projectCommandPortfolio({
    cashBalance: "5000",
    positions: [
      { asset: "xyz:XYZ100", margin_mode: "cross", signed_size: "-10", entry_price: "100", isolated_margin: null },
      { asset: "BTC", margin_mode: "cross", signed_size: "1", entry_price: "100", isolated_margin: null },
    ],
    marks: new Map([["xyz:XYZ100", "80"], ["BTC", "120"]]),
    leverageByAsset: new Map([["xyz:XYZ100", 10], ["BTC", 5]]),
    metadataByAsset: new Map([
      ["xyz:XYZ100", { marginTiers: [{ lowerBound: "0", maxLeverage: 10, maintenanceRate: "0.05", maintenanceDeduction: "0" }] }],
      ["BTC", { marginTiers: [{ lowerBound: "0", maxLeverage: 40, maintenanceRate: "0.0125", maintenanceDeduction: "0" }] }],
    ]),
  });

  assertEquals(projection.unrealizedPnl, "220");
  assertEquals(projection.equity, "5220");
  assertEquals(projection.marginUsed, "104");
});

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

Deno.test("unavailable portfolio marks fail closed as a retryable service error", async () => {
  const response = paperCommandFailureResponse(new Error("portfolio_mark_unavailable:xyz:XYZ100"));
  assertEquals(response.status, 503);
  assertEquals(await response.json(), { error: "portfolio_mark_unavailable" });
});

Deno.test("incomplete portfolio metadata fails closed before order submission", async () => {
  const response = paperCommandFailureResponse(new Error("portfolio_state_unavailable:metadata:xyz:XYZ100"));
  assertEquals(response.status, 503);
  assertEquals(await response.json(), { error: "portfolio_state_unavailable" });
});
