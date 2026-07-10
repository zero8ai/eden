import nodemailer from "nodemailer";
import { Models, ServerClient } from "postmark";

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
}

type EmailSender = (options: SendEmailOptions) => Promise<void>;

function fromAddress(): string {
  const value = process.env.FROM_EMAIL?.trim();
  if (!value)
    throw new Error(
      "FROM_EMAIL is required when an email provider is configured.",
    );
  return value;
}

function createEmailClient(): EmailSender {
  const smtpUrl = process.env.SMTP_URL?.trim();
  if (process.env.NODE_ENV !== "production" && smtpUrl) {
    const transport = nodemailer.createTransport(smtpUrl);
    console.info("Email client initialized with development SMTP.");
    return async ({ to, subject, html }) => {
      await transport.sendMail({ from: fromAddress(), to, subject, html });
    };
  }

  const postmarkToken = process.env.POSTMARK_SERVER_TOKEN?.trim();
  if (postmarkToken) {
    const client = new ServerClient(postmarkToken);
    console.info("Email client initialized with Postmark.");
    return async ({ to, subject, html }) => {
      await client.sendEmail({
        From: fromAddress(),
        To: to,
        Subject: subject,
        HtmlBody: html,
        TrackLinks: Models.LinkTrackingOptions.None,
        TrackOpens: false,
      });
    };
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("POSTMARK_SERVER_TOKEN is required in production.");
  }

  console.warn(
    "No email provider configured. Transactional emails will not be sent.",
  );
  return async ({ to, subject }) => {
    console.warn(
      `Email not sent (no provider configured): ${subject} -> ${to}`,
    );
  };
}

export const sendEmail = createEmailClient();
