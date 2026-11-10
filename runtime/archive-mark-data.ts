export function archiveMarkUrl(
  asset: string,
  start: number,
  end: number,
  cursor?: string | null,
) {
  if (
    !/^[A-Za-z0-9_.:-]+$/.test(asset) || !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) || start >= end
  ) throw Error("Invalid historical mark range");
  const url = new URL(
    "https://api.0xarchive.io/v1/hyperliquid/" +
      (asset.includes(":") ? "hip3/" : "") + "prices/" +
      encodeURIComponent(asset),
  );
  url.searchParams.set("start", String(start));
  url.searchParams.set("end", String(end));
  url.searchParams.set("limit", "1000");
  if (cursor) url.searchParams.set("cursor", cursor);
  return url;
}
export function parseArchiveMarks(
  input: unknown,
  asset: string,
  start: number,
  end: number,
) {
  const body = input as {
    success?: boolean;
    data?: unknown;
    meta?: { symbol?: string; has_more?: boolean; next_cursor?: unknown };
  };
  if (
    body?.success !== true || !Array.isArray(body.data) ||
    body.meta?.symbol !== asset || typeof body.meta.has_more !== "boolean"
  ) throw Error("Unverified archive mark response");
  if (body.meta.has_more && typeof body.meta.next_cursor !== "string") {
    throw Error("Archive cursor missing");
  }
  const points = body.data.map(
    (row: { timestamp?: unknown; mark_price?: unknown }) => {
      const time = typeof row.timestamp === "string"
          ? Date.parse(row.timestamp)
          : NaN,
        price = row.mark_price;
      if (
        !Number.isSafeInteger(time) || time < start || time > end ||
        typeof price !== "string" || !Number.isFinite(Number(price)) ||
        Number(price) <= 0
      ) throw Error("Invalid archive mark observation");
      return { time, price };
    },
  );
  return {
    points,
    cursor: body.meta.has_more ? body.meta.next_cursor as string : null,
  };
}
