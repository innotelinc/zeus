import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

let _transporter: Transporter | null = null;
let _configured = false;
let _initAttempted = false;

function getTransporter(): Transporter | null {
  if (_initAttempted) return _transporter;
  _initAttempted = true;

  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpSecure = process.env.SMTP_SECURE !== "" && process.env.SMTP_SECURE !== undefined
    ? process.env.SMTP_SECURE === "true"
    : smtpPort === "465";

  // Option 1: SMTP relay (preferred — works everywhere)
  if (smtpHost) {
    _transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort ? parseInt(smtpPort) : 587,
      secure: smtpSecure,
      ...(smtpUser ? { auth: { user: smtpUser, pass: smtpPass ?? "" } } : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
    });
    _configured = true;
    return _transporter;
  }

  // Option 2: Local sendmail (bare-metal Debian/Ubuntu with sendmail installed)
  // createTransport with sendmail never throws — failures happen at sendMail time
  _transporter = nodemailer.createTransport({
    sendmail: true,
    newline: "unix",
    path: "/usr/sbin/sendmail",
  });
  _configured = true;
  return _transporter;

  // Option 3: No transport configured — log only
  _configured = false;
  return null;
}

export interface EmailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    content?: Buffer | string;
    path?: string;
    contentType?: string;
  }>;
}

export async function sendEmail(opts: EmailOptions): Promise<{
  sent: boolean;
  messageId?: string;
  error?: string;
}> {
  const transporter = getTransporter();

  if (!transporter || !_configured) {
    console.log("[Mail] No transport configured — would send:", {
      to: opts.to,
      subject: opts.subject,
      textLength: opts.text?.length ?? 0,
    });
    return { sent: false, error: "No mail transport configured" };
  }

  try {
    const from =
      process.env.SMTP_FROM ??
      process.env.ADMIN_EMAIL ??
      "pbx@zeus.innotel.us";

    const info = await transporter.sendMail({
      from,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
      attachments: opts.attachments,
    });

    console.log("[Mail] Sent:", info.messageId);
    return { sent: true, messageId: info.messageId };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "Unknown mail error";
    console.error("[Mail] Failed:", errMsg);
    return { sent: false, error: errMsg };
  }
}

/** Quick check: is email transport available? */
export function isEmailConfigured(): boolean {
  const transporter = getTransporter();
  return _configured && transporter !== null;
}
