import type { NewsItem } from "./feed.ts";

export interface AssetNewsDependencies {
  allowedOrigin: string;
  fetchNews(asset: string): Promise<NewsItem[]>;
}

export async function handleAssetNews(request: Request, dependencies: AssetNewsDependencies): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  if (request.headers.get("origin") !== dependencies.allowedOrigin) return Response.json({ error: "forbidden_origin" }, { status: 403 });
  let asset = "";
  try {
    const body = await request.text();
    if (body.length > 256) return Response.json({ error: "request_too_large" }, { status: 413 });
    asset = String(JSON.parse(body)?.asset ?? "").trim();
  }
  catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
  if (!/^(?:xyz:)?[A-Za-z0-9._-]{1,24}$/.test(asset)) return Response.json({ error: "invalid_asset" }, { status: 400 });
  try {
    return Response.json({ items: await dependencies.fetchNews(asset) }, { headers: { "cache-control": "private, max-age=300" } });
  } catch {
    return Response.json({ error: "news_unavailable" }, { status: 502 });
  }
}
