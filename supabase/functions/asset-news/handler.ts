import type { NewsItem } from "./feed.ts";
import { isValidAssetId } from "../_shared/asset-identity.ts";

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
  if (!isValidAssetId(asset)) return Response.json({ error: "invalid_asset", detail: "Use a canonical Hyperliquid asset ID." }, { status: 400 });
  try {
    return Response.json({ items: await dependencies.fetchNews(asset) }, { headers: { "cache-control": "private, max-age=300" } });
  } catch (error) {
    console.error("asset-news failed", { asset, error });
    return Response.json({ error: "news_unavailable", detail: "The upstream news sources are temporarily unavailable." }, { status: 502 });
  }
}
