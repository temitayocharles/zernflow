import { describe, expect, it } from "vitest";
import { buildGatewayFlowReply, flowReplyIdempotencyKey } from "./gateway-message";

const BASE = {
  workspaceId: "workspace-1",
  flowId: "flow-1",
  sessionId: "session-1",
  nodeId: "node-1",
  messageIndex: 0,
};

describe("buildGatewayFlowReply", () => {
  it("preserves Meta rich controls and interpolates content", () => {
    const reply = buildGatewayFlowReply({
      ...BASE,
      platform: "instagram",
      variables: { name: "Ada", product: "Widget" },
      message: {
        text: "Hello {{name}}",
        imageUrl: "https://cdn.example/{{product}}.jpg",
        buttons: [
          {
            title: "Open {{product}}",
            type: "url",
            url: "https://example.com/{{product}}",
          },
        ],
        quickReplies: [{ title: "More", payload: "more.{{product}}" }],
      },
    });

    expect(reply).toMatchObject({
      text: "Hello Ada",
      attachments: [
        { type: "image", url: "https://cdn.example/Widget.jpg" },
      ],
      presentation: {
        buttons: [
          {
            title: "Open Widget",
            type: "url",
            url: "https://example.com/Widget",
          },
        ],
        quickReplies: [{ title: "More", payload: "more.Widget" }],
      },
    });
    expect(reply.idempotencyKey).toMatch(/^zernflow:flow:[a-f0-9]{48}$/);
  });

  it("uses the text fallback for Telegram carousels", () => {
    const reply = buildGatewayFlowReply({
      ...BASE,
      platform: "telegram",
      variables: {},
      message: {
        text: "Products",
        carousel: {
          elements: [
            {
              title: "One",
              subtitle: "First",
              buttons: [
                {
                  title: "Open",
                  type: "url",
                  url: "https://example.com/one",
                },
              ],
            },
          ],
        },
      },
    });

    expect(reply.text).toContain("Products");
    expect(reply.text).toContain("1. One");
    expect(reply.text).toContain("Open: https://example.com/one");
    expect(reply.presentation).toBeUndefined();
  });

  it("keeps Telegram button payloads for inline callbacks", () => {
    const reply = buildGatewayFlowReply({
      ...BASE,
      platform: "telegram",
      variables: {},
      message: {
        text: "Continue?",
        buttons: [
          { title: "Yes", type: "postback", payload: "yes" },
        ],
      },
    });

    expect(reply.presentation).toEqual({
      buttons: [{ title: "Yes", type: "postback", payload: "yes" }],
    });
  });
});

describe("flowReplyIdempotencyKey", () => {
  it("is deterministic and changes per message index", () => {
    const first = flowReplyIdempotencyKey(BASE);
    expect(flowReplyIdempotencyKey(BASE)).toBe(first);
    expect(flowReplyIdempotencyKey({ ...BASE, messageIndex: 1 })).not.toBe(first);
    expect(first.length).toBeLessThanOrEqual(128);
  });
});
