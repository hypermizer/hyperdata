import nodemailer from "nodemailer";
export interface EmailConfig { host: string; port: number; user: string; password: string; from: string; to: string }
export async function sendEmail(config: EmailConfig, message: { subject: string; text: string }, deliveryId?: string) {
  const transport = nodemailer.createTransport({ host: config.host, port: config.port, secure: true, auth: { user: config.user, pass: config.password },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000 });
  try {
    const result = await transport.sendMail({ from: config.from, to: config.to, subject: message.subject, text: message.text,
      ...(deliveryId ? { messageId: `<hyperdata-${deliveryId}@${config.user.split("@")[1]}>` } : {}) });
    if (!result.accepted?.length) throw new Error("SMTP did not accept the alert recipient");
    return { providerId: result.messageId ?? null };
  } finally {
    transport.close();
  }
}
