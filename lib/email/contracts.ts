import { InputError, object, text } from "@/lib/product/validation";
export interface EmailIdentity {
  address: string;
  name?: string;
}
export interface EmailAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  downloadUrl?: string;
}
export interface EmailEnvelope {
  mailboxRef: string;
  threadRef: string;
  messageRef: string;
  inReplyTo?: string;
  references: string[];
  from: EmailIdentity;
  to: EmailIdentity[];
  cc: EmailIdentity[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  attachments: EmailAttachment[];
  occurredAt: string;
  direction: "inbound" | "outbound";
  delivery: "received" | "queued" | "sent" | "delivered" | "failed" | "unknown";
  failure?: { code: string; message: string };
}
export interface EmailReply {
  mailboxRef: string;
  threadRef: string;
  inReplyTo: string;
  from: EmailIdentity;
  to: EmailIdentity[];
  cc: EmailIdentity[];
  subject: string;
  textBody: string;
  attachmentIds: string[];
  idempotencyKey: string;
}
export interface EmailChannelAdapter {
  capabilities(
    mailboxRef: string,
  ): Promise<{
    inbound: boolean;
    outbound: boolean;
    html: boolean;
    attachments: boolean;
  }>;
  reply(
    input: EmailReply,
  ): Promise<{
    operationId: string;
    state: "queued" | "failed";
    error?: string;
  }>;
}
export function emailIdentity(value: unknown): EmailIdentity {
  const v = object(value);
  const address = text(v.address, "email address", 254, true);
  if (typeof v.name === "string" && /[\r\n]/.test(v.name))
    throw new InputError("Invalid sender name");
  if (
    /[\r\n]/.test(address) ||
    !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)
  )
    throw new InputError("Invalid email address");
  return {
    address,
    ...(v.name ? { name: text(v.name, "sender name", 200) } : {}),
  };
}
export function createEmailReply(
  message: EmailEnvelope,
  mailbox: EmailIdentity,
  body: string,
  key: string,
): EmailReply {
  if (message.direction !== "inbound")
    throw new InputError("Reply requires an inbound email");
  const from = emailIdentity(mailbox);
  const to = emailIdentity(message.from);
  if (from.address.toLowerCase() === to.address.toLowerCase())
    throw new InputError("Refusing a reply to the connected mailbox itself");
  if (!message.threadRef || !message.messageRef || !message.mailboxRef)
    throw new InputError("Email threading identifiers required");
  const subject = /^re:/i.test(message.subject)
    ? message.subject
    : `Re: ${message.subject}`;
  if (/[\r\n]/.test(subject)) throw new InputError("Invalid subject");
  return {
    mailboxRef: message.mailboxRef,
    threadRef: message.threadRef,
    inReplyTo: message.messageRef,
    from,
    to: [to],
    cc: [],
    subject: text(subject, "subject", 998),
    textBody: text(body, "body", 100000, true),
    attachmentIds: [],
    idempotencyKey: text(key, "idempotency key", 200, true),
  };
}
/** Rendering boundary: HTML is never injected into the application DOM. */
export function emailPreview(message: EmailEnvelope) {
  return {
    subject: message.subject,
    text:
      message.textBody ||
      "This email has no plain-text body. HTML preview is unavailable.",
    from: message.from.address,
    attachmentCount: message.attachments.length,
  };
}
