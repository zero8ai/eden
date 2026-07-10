import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTransport: vi.fn(),
  postmarkSend: vi.fn(),
  smtpSend: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: mocks.createTransport,
  },
}));

vi.mock("postmark", () => ({
  ServerClient: class {
    sendEmail = mocks.postmarkSend;
  },
}));

const saved = {
  NODE_ENV: process.env.NODE_ENV,
  SMTP_URL: process.env.SMTP_URL,
  POSTMARK_SERVER_TOKEN: process.env.POSTMARK_SERVER_TOKEN,
  FROM_EMAIL: process.env.FROM_EMAIL,
};

function restore(name: keyof typeof saved) {
  const value = saved[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function freshClient() {
  vi.resetModules();
  return import("~/lib/email-client.server");
}

describe("transactional email client", () => {
  beforeEach(() => {
    mocks.createTransport.mockReset();
    mocks.postmarkSend.mockReset();
    mocks.smtpSend.mockReset();
    mocks.createTransport.mockReturnValue({ sendMail: mocks.smtpSend });
    delete process.env.SMTP_URL;
    delete process.env.POSTMARK_SERVER_TOKEN;
    delete process.env.FROM_EMAIL;
  });

  afterEach(() => {
    restore("NODE_ENV");
    restore("SMTP_URL");
    restore("POSTMARK_SERVER_TOKEN");
    restore("FROM_EMAIL");
    vi.restoreAllMocks();
  });

  it("uses development SMTP ahead of Postmark for local email capture", async () => {
    process.env.NODE_ENV = "development";
    process.env.SMTP_URL = "smtp://127.0.0.1:1025";
    process.env.POSTMARK_SERVER_TOKEN = "postmark-token";
    process.env.FROM_EMAIL = "Eden <noreply@example.com>";
    const { sendEmail } = await freshClient();

    await sendEmail({
      to: "member@example.com",
      subject: "Invite",
      html: "<p>Join</p>",
    });

    expect(mocks.createTransport).toHaveBeenCalledWith("smtp://127.0.0.1:1025");
    expect(mocks.smtpSend).toHaveBeenCalledWith({
      from: "Eden <noreply@example.com>",
      to: "member@example.com",
      subject: "Invite",
      html: "<p>Join</p>",
    });
    expect(mocks.postmarkSend).not.toHaveBeenCalled();
  });

  it("maps production messages to Postmark", async () => {
    process.env.NODE_ENV = "production";
    process.env.POSTMARK_SERVER_TOKEN = "postmark-token";
    process.env.FROM_EMAIL = "Eden <noreply@example.com>";
    const { sendEmail } = await freshClient();

    await sendEmail({
      to: "person@example.com",
      subject: "Reset",
      html: "<p>Reset</p>",
    });

    expect(mocks.postmarkSend).toHaveBeenCalledWith({
      From: "Eden <noreply@example.com>",
      To: "person@example.com",
      Subject: "Reset",
      HtmlBody: "<p>Reset</p>",
    });
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });

  it("is a nonthrowing no-op when no provider is configured", async () => {
    process.env.NODE_ENV = "production";
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const { sendEmail } = await freshClient();

    await expect(
      sendEmail({
        to: "person@example.com",
        subject: "Reset",
        html: "<p>Reset</p>",
      }),
    ).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalled();
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.postmarkSend).not.toHaveBeenCalled();
  });
});
