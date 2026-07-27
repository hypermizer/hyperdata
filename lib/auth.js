export async function requestSignInLink(client) {
  const { data, error } = await client.functions.invoke("send-login-link", { body: {} });
  if (error) throw new Error(await signInError(error));
  if (data?.status !== "sent") throw new Error("Unable to confirm sign-in email delivery.");
}

async function signInError(error) {
  const context = error?.context;
  if (context instanceof Response) {
    try {
      const body = await context.clone().json();
      if (body?.error === "please_wait") {
        return `Wait ${Number(body.retryAfter) || 10} seconds before requesting another link.`;
      }
      if (body?.error === "hourly_limit") return "Sign-in email limit reached. Try again in an hour.";
      if (body?.error === "delivery_failed") return "Sign-in email delivery failed. Try again.";
    } catch {
      // Fall through to the SDK message when the response is not JSON.
    }
  }
  return error?.message || "Unable to send sign-in link.";
}
