import { assertEquals } from "@std/assert";
import { allowedOwnerPath } from "../owner-backend.ts";
Deno.test("owner backend exposes only app data and commands, excluding auth/admin and former alert paths", () => {
  for (
    const path of [
      "/rest/v1/watchlist_items",
      "/rest/v1/comparison_preferences",
      "/rest/v1/paper_positions",
      "/rest/v1/rpc/create_paper_account",
      "/functions/v1/paper-command",
    ]
  ) assertEquals(allowedOwnerPath(path), true);
  for (
    const path of [
      "/auth/v1/admin/users",
      "/rest/v1/alert_rules",
      "/rest/v1/rpc/configure_listener_cron",
      "/functions/v1/send-login-link",
      "/rest/v1/users/../watchlist_items",
    ]
  ) assertEquals(allowedOwnerPath(path), false);
});
