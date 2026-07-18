export interface SmsConfig { accountSid: string; authToken: string; from: string; to: string }
export async function sendSms(config: SmsConfig, message: { text: string }, fetchImpl: typeof fetch = fetch) {
  const body = new URLSearchParams({ From: config.from, To: config.to, Body: message.text });
  const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`, {
    method: "POST", headers: { authorization: `Basic ${btoa(`${config.accountSid}:${config.authToken}`)}`, "content-type": "application/x-www-form-urlencoded" }, body,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Twilio returned ${response.status}: ${String(payload.message ?? "send failed")}`);
  return { providerId: typeof payload.sid === "string" ? payload.sid : null };
}
