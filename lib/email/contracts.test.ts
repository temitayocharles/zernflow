import { describe, expect, it } from "vitest";
import {
  emailIdentity,
  createEmailReply,
  emailPreview,
  type EmailEnvelope,
} from "./contracts";
const message: EmailEnvelope = {
  mailboxRef: "mailbox",
  threadRef: "thread",
  messageRef: "message",
  references: [],
  from: { address: "customer@example.com" },
  to: [{ address: "support@example.com" }],
  cc: [],
  subject: "Help",
  textBody: "Question",
  htmlBody: "<script>bad()</script>",
  attachments: [],
  occurredAt: "2026-09-11T00:00:00Z",
  direction: "inbound",
  delivery: "received",
};
describe("email product contracts", () => {
  it("preserves thread/reply identities and avoids implicit reply-all", () => {
    expect(
      createEmailReply(
        message,
        { address: "support@example.com" },
        "Answer",
        "key",
      ),
    ).toMatchObject({
      threadRef: "thread",
      inReplyTo: "message",
      subject: "Re: Help",
      cc: [],
      idempotencyKey: "key",
    });
  });
  it("rejects header injection and self-replies", () => {
    expect(() =>
      emailIdentity({ address: "user@example.com\r\nBCC: bad@example.com" }),
    ).toThrow();
    expect(() =>
      createEmailReply(message, message.from, "Answer", "key"),
    ).toThrow();
  });
  it("does not expose HTML as rendered answer context", () => {
    expect(emailPreview(message)).not.toHaveProperty("htmlBody");
    expect(emailPreview({ ...message, textBody: "" }).text).toContain(
      "HTML preview is unavailable",
    );
  });
});
