/**
 * List/search messages in an AgentMail inbox.
 *
 * One of the four AgentMail billing-inbox tools (read + label only — nothing here can send,
 * delete, or provision mail). Set AGENTMAIL_API_KEY as an Eden secret; the value is read from
 * the tool process environment and is never accepted as model input.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

const AGENTMAIL_API_URL = "https://api.agentmail.to/v0";

const attachmentSchema = z
  .object({
    attachment_id: z.string(),
    filename: z.string().nullish(),
    size: z.number(),
    content_type: z.string().nullish(),
  })
  .passthrough();

const messageItemSchema = z
  .object({
    message_id: z.string(),
    thread_id: z.string(),
    labels: z.array(z.string()),
    timestamp: z.string(),
    from: z.string(),
    to: z.array(z.string()),
    subject: z.string().nullish(),
    preview: z.string().nullish(),
    attachments: z.array(attachmentSchema).nullish(),
  })
  .passthrough();

const responseSchema = z
  .object({
    count: z.number(),
    next_page_token: z.string().nullish(),
    messages: z.array(messageItemSchema),
  })
  .passthrough();

/** Accepts an ISO 8601 datetime, or a bare date (treated as start-of-day UTC). */
const dateFilter = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/,
    "must be an ISO 8601 date or datetime",
  );

function toIsoDatetime(value: string): string {
  return value.length === 10 ? `${value}T00:00:00Z` : value;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** AgentMail's error body is { name, message, fix?, docs? } — surface the useful parts. */
function apiError(status: number, body: unknown): string {
  const err = body as { message?: string; fix?: string } | null;
  if (err && typeof err.message === "string") {
    return err.fix
      ? `${err.message} (HTTP ${status}) — ${err.fix}`
      : `${err.message} (HTTP ${status})`;
  }
  return `AgentMail request failed with HTTP ${status}.`;
}

export default defineTool({
  description:
    "List messages in an AgentMail inbox, newest first, with filters for date range, labels, " +
    "sender, recipient, and subject. Use labels [\"unread\"] to poll for mail the agent hasn't " +
    "processed yet. Returns message metadata and previews — call agentmail-get-message for a " +
    "message's full body and attachments.",
  inputSchema: z.object({
    inboxId: z
      .string()
      .min(1)
      .max(255)
      .describe(
        "Inbox id or email address (e.g. billing@agentmail.to) — from agentmail-list-inboxes.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum messages to return. Defaults to 25."),
    pageToken: z
      .string()
      .min(1)
      .optional()
      .describe("nextPageToken from a previous call, to fetch the next page."),
    labels: z
      .array(z.string().min(1).max(100))
      .min(1)
      .max(20)
      .optional()
      .describe(
        "Only messages carrying ALL of these labels, e.g. [\"unread\"]. Labels are free-form; " +
          "\"unread\"/\"read\" is the convention for processing state.",
      ),
    after: dateFilter
      .optional()
      .describe("Only messages at or after this ISO 8601 date/datetime."),
    before: dateFilter
      .optional()
      .describe("Only messages at or before this ISO 8601 date/datetime."),
    from: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe("Only messages whose sender contains this substring, e.g. a supplier domain."),
    to: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe("Only messages whose recipients (to, cc, or bcc) contain this substring."),
    subject: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe("Only messages whose subject contains this substring, e.g. \"invoice\"."),
    ascending: z
      .boolean()
      .optional()
      .describe("Sort oldest-first instead of newest-first."),
  }),
  async execute(input) {
    const apiKey = process.env.AGENTMAIL_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        error:
          "Missing AGENTMAIL_API_KEY. Set it as an Eden secret on this agent before using the AgentMail tools.",
      };
    }

    try {
      const params = new URLSearchParams();
      params.set("limit", String(input.limit ?? 25));
      if (input.pageToken) params.set("page_token", input.pageToken);
      for (const label of input.labels ?? []) params.append("labels", label);
      if (input.after) params.set("after", toIsoDatetime(input.after));
      if (input.before) params.set("before", toIsoDatetime(input.before));
      if (input.from) params.append("from", input.from);
      if (input.to) params.append("to", input.to);
      if (input.subject) params.append("subject", input.subject);
      if (input.ascending !== undefined) {
        params.set("ascending", String(input.ascending));
      }

      const response = await fetch(
        `${AGENTMAIL_API_URL}/inboxes/${encodeURIComponent(input.inboxId)}/messages?${params}`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);

      if (!response.ok) {
        return { ok: false, status: response.status, error: apiError(response.status, body) };
      }

      const parsed = responseSchema.safeParse(body);
      if (!parsed.success) {
        return {
          ok: false,
          status: response.status,
          error: "AgentMail returned an unexpected response shape.",
          response: body,
        };
      }

      return {
        ok: true,
        count: parsed.data.count,
        nextPageToken: parsed.data.next_page_token ?? undefined,
        messages: parsed.data.messages.map((message) => ({
          messageId: message.message_id,
          threadId: message.thread_id,
          timestamp: message.timestamp,
          from: message.from,
          to: message.to,
          subject: message.subject ?? undefined,
          preview: message.preview ?? undefined,
          labels: message.labels,
          attachments: (message.attachments ?? []).map((attachment) => ({
            attachmentId: attachment.attachment_id,
            filename: attachment.filename ?? undefined,
            contentType: attachment.content_type ?? undefined,
            size: attachment.size,
          })),
        })),
      };
    } catch (err) {
      return { ok: false, error: `AgentMail request failed: ${errorMessage(err)}` };
    }
  },
});
