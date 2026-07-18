import nodemailer from "nodemailer";
export interface EmailConfig { host: string; port: number; user: string; password: string; from: string; to: string }
export async function sendEmail(config: EmailConfig, message: { subject: string; text: string }) {
  const transport = nodemailer.createTransport({ host: config.host, port: config.port, secure: true, auth: { user: config.user, pass: config.password },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000 });
  const result = await transport.sendMail({ from: config.from, to: config.to, subject: message.subject, text: message.text });
  return { providerId: result.messageId ?? null };
}
