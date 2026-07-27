import assert from "node:assert/strict";
import test from "node:test";
import { restartSupabaseProject } from "../scripts/restart-supabase-project.mjs";

const env = { SUPABASE_ACCESS_TOKEN: "token", SUPABASE_PROJECT_ID: "project-ref" };

test("project restart waits for a successful database query", async () => {
  const calls = [];
  const waits = [];
  const responses = [
    new Response(null, { status: 200 }),
    Response.json({ message: "starting" }, { status: 503 }),
    Response.json([{ ready: 1 }]),
  ];
  await restartSupabaseProject({
    env,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return responses.shift(); },
    sleep: async (milliseconds) => waits.push(milliseconds),
    logger: { log() {} },
    maxAttempts: 3,
  });

  assert.equal(calls[0].url, "https://api.supabase.com/v1/projects/project-ref/restart");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[1].url, "https://api.supabase.com/v1/projects/project-ref/database/query");
  assert.deepEqual(JSON.parse(calls[1].options.body), { query: "select 1 as ready", read_only: true });
  assert.deepEqual(waits, [5_000]);
});

test("project restart fails when Postgres never becomes available", async () => {
  await assert.rejects(restartSupabaseProject({
    env,
    fetchImpl: async (url) => url.endsWith("/restart")
      ? new Response(null, { status: 200 })
      : Response.json({ message: "unavailable" }, { status: 503 }),
    sleep: async () => {},
    logger: { log() {} },
    maxAttempts: 2,
  }), /database did not recover after restart/);
});

test("project restart can quiesce the paper scheduler before returning", async () => {
  const calls = [];
  await restartSupabaseProject({
    env: { ...env, QUIESCE_PAPER_PROCESSOR: "true" },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return url.endsWith("/restart") ? new Response(null, { status: 200 }) : Response.json([]);
    },
    sleep: async () => {},
    logger: { log() {} },
    maxAttempts: 1,
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    query: "select cron.unschedule(jobid) from cron.job where jobname = 'hyperdata-process-paper'",
    read_only: false,
  });
});
