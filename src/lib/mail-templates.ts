import { sendEmail } from "@/lib/mail";

const BRAND = "#635bff";
const BRAND_LIGHT = "#a5a1ff";
const BG = "#0a0a12";
const TEXT = "#f4f4f8";
const TEXT_MUTED = "#ffffff55";
const SURFACE = "#ffffff08";

function wrapHtml(body: string): string {
  return [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:' + BG + ';color:' + TEXT + ';border-radius:12px">',
    '<h2 style="margin:0 0 16px;color:' + BRAND_LIGHT + '">📞 Innotel PBX</h2>',
    body,
    '<hr style="margin:24px 0 16px;border:none;border-top:1px solid #ffffff10">',
    '<p style="margin:0;font-size:12px;color:#ffffff40">Innotel PBX Portal &bull; <a href="https://pbx.innotel.us" style="color:#ffffff40">pbx.innotel.us</a></p>',
    '</div>',
  ].join("\n");
}

// ── Welcome Email ─────────────────────────────────────────────

export function buildWelcomeEmail(opts: { name: string; email: string; plan: string }) {
  const planLabel = opts.plan === "business" ? "Business" : "Consumer";
  const dashboardUrl = "https://pbx.innotel.us/dashboard";

  const text = [
    "Welcome to Innotel PBX, " + opts.name + "!",
    "",
    "Your " + planLabel + " plan is now active.",
    "",
    "Get started:",
    "• Order a phone number — " + dashboardUrl,
    "• Connect a softphone — " + dashboardUrl,
    "• Send your first fax — " + dashboardUrl + "/fax",
    "",
    "Questions? Contact support@innotel.us",
  ].join("\n");

  const html = wrapHtml(
    [
      '<p style="font-size:16px;margin:0 0 4px">Welcome, <strong>' + opts.name + '</strong>!</p>',
      '<p style="margin:0 0 16px;color:' + TEXT_MUTED + '">Your ' + planLabel + ' plan is ready.</p>',
      '<div style="margin:0 0 24px;padding:16px;background:' + SURFACE + ';border-radius:8px">',
      '<p style="margin:0 0 8px;font-weight:600">Quick start:</p>',
      '<ul style="margin:0;padding-left:20px;color:' + TEXT_MUTED + '">',
      '<li style="margin-bottom:6px">Order a phone number from the dashboard</li>',
      '<li style="margin-bottom:6px">Connect your WebRTC softphone or SIP device</li>',
      '<li style="margin-bottom:6px">Send SMS and faxes from your numbers</li>',
      '</ul>',
      '</div>',
      '<a href="' + dashboardUrl + '" style="display:inline-block;padding:12px 28px;background:' + BRAND + ';color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Open Dashboard</a>',
    ].join("\n"),
  );

  return sendEmail({
    to: opts.email,
    subject: "Welcome to Innotel PBX, " + opts.name + "!",
    text,
    html,
  });
}

// ── Invoice Email ─────────────────────────────────────────────

export function buildInvoiceEmail(opts: {
  email: string;
  name: string;
  invoiceNumber: string;
  amountPaid: number;
  periodStart: string;
  periodEnd: string;
}) {
  const billingUrl = "https://pbx.innotel.us/dashboard/billing";
  const amount = "$" + opts.amountPaid.toFixed(2);
  const period =
    new Date(opts.periodStart).toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    " — " +
    new Date(opts.periodEnd).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  const text = [
    "Invoice Paid — Innotel PBX",
    "─────────────────────",
    "Invoice: " + opts.invoiceNumber,
    "Amount: " + amount,
    "Period: " + period,
    "",
    "View all invoices: " + billingUrl,
    "",
    "Thank you for your business!",
  ].join("\n");

  const html = wrapHtml(
    [
      '<p style="font-size:16px;margin:0 0 4px">Invoice Paid ✅</p>',
      '<p style="margin:0 0 16px;color:' + TEXT_MUTED + '">Your payment has been processed.</p>',
      '<table style="width:100%;border-collapse:collapse;margin-bottom:20px">',
      '<tr><td style="padding:8px 0;color:' + TEXT_MUTED + '">Invoice</td><td style="font-weight:600">' + opts.invoiceNumber + '</td></tr>',
      '<tr><td style="padding:8px 0;color:' + TEXT_MUTED + '">Amount</td><td style="font-weight:600;color:#34d399">' + amount + '</td></tr>',
      '<tr><td style="padding:8px 0;color:' + TEXT_MUTED + '">Period</td><td>' + period + '</td></tr>',
      '</table>',
      '<a href="' + billingUrl + '" style="display:inline-block;padding:12px 28px;background:' + BRAND + ';color:#fff;text-decoration:none;border-radius:8px;font-weight:600">View Billing</a>',
    ].join("\n"),
  );

  return sendEmail({
    to: opts.email,
    subject: "Invoice " + opts.invoiceNumber + " paid — " + amount,
    text,
    html,
  });
}

// ── Fax Received Email ────────────────────────────────────────

export function buildFaxReceivedEmail(opts: {
  email: string;
  fromNumber: string;
  toNumber: string;
  pages: number;
  subject?: string | null;
  receivedAt: string;
}) {
  const faxUrl = "https://pbx.innotel.us/dashboard/fax";
  const pagesLabel = opts.pages + " page" + (opts.pages !== 1 ? "s" : "");
  const date = new Date(opts.receivedAt).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  const text = [
    "Fax Received — Innotel PBX",
    "─────────────────────────",
    "From: " + opts.fromNumber,
    "To: " + opts.toNumber,
    "Pages: " + pagesLabel,
    "Date: " + date,
    opts.subject ? "Subject: " + opts.subject : "",
    "",
    "View your faxes: " + faxUrl,
  ].join("\n");

  const html = wrapHtml(
    [
      '<p style="font-size:16px;margin:0 0 4px">📠 Fax Received</p>',
      '<p style="margin:0 0 16px;color:' + TEXT_MUTED + '">' + pagesLabel + ' on ' + date + '</p>',
      '<table style="width:100%;border-collapse:collapse;margin-bottom:20px">',
      '<tr><td style="padding:8px 0;color:' + TEXT_MUTED + '">From</td><td style="font-weight:600">' + opts.fromNumber + '</td></tr>',
      '<tr><td style="padding:8px 0;color:' + TEXT_MUTED + '">To</td><td>' + opts.toNumber + '</td></tr>',
      '<tr><td style="padding:8px 0;color:' + TEXT_MUTED + '">Pages</td><td>' + pagesLabel + '</td></tr>',
      opts.subject ? '<tr><td style="padding:8px 0;color:' + TEXT_MUTED + '">Subject</td><td>' + opts.subject + '</td></tr>' : "",
      '</table>',
      '<a href="' + faxUrl + '" style="display:inline-block;padding:12px 28px;background:' + BRAND + ';color:#fff;text-decoration:none;border-radius:8px;font-weight:600">View Fax</a>',
    ].join("\n"),
  );

  return sendEmail({
    to: opts.email,
    subject: "Fax received from " + opts.fromNumber + " (" + pagesLabel + ")",
    text,
    html,
  });
}
