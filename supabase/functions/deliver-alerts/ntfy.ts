export interface NtfyConfig { baseUrl: string; topic: string; token?: string }

export async function sendNtfy(config: NtfyConfig, message: { subject: string; text: string }, fetchImpl: typeof fetch = fetch) {
  const url = new URL(config.baseUrl);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("ntfy requires an HTTPS endpoint");
  const response = await fetchImpl(url, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) },
    body: JSON.stringify({ topic: config.topic, title: message.subject, message: message.text,
      priority: 4, tags: ["chart_with_upwards_trend"], click: "https://hypermizer.github.io/hyperdata/#/alerts" }),
  });
  // Do not include the response body or URL: both can reveal the private topic.
  if (!response.ok) throw new Error(`ntfy rejected notification (${response.status})`);
  const result = await response.json();
  if (result.event !== "message" || typeof result.id !== "string") throw new Error("ntfy acceptance was not confirmed");
  return { providerId: result.id };
}
