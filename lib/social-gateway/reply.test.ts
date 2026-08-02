import { describe, expect, it } from "vitest";
import { serializeReplyInput } from "./reply";

describe("serializeReplyInput", () => {
  it("maps flow content into the provider-neutral gateway contract", () => {
    expect(
      serializeReplyInput({
        text: "  Product details  ",
        attachments: [
          {
            type: "image",
            url: "https://cdn.example/product.jpg",
            mimeType: "image/jpeg",
            name: "product.jpg",
          },
        ],
        presentation: {
          quickReplies: [{ title: "More", payload: "product.more" }],
          buttons: [
            {
              title: "Open",
              type: "url",
              url: "https://example.com/product",
            },
          ],
          carousel: [
            {
              title: "Related",
              subtitle: "Another product",
              imageUrl: "https://cdn.example/related.jpg",
              buttons: [
                {
                  title: "Choose",
                  type: "postback",
                  payload: "product.choose",
                },
              ],
            },
          ],
        },
        idempotencyKey: "flow:session:node:1",
        replyToMessageId: "message-1",
      }),
    ).toEqual({
      text: "Product details",
      attachments: [
        {
          type: "image",
          url: "https://cdn.example/product.jpg",
          mime_type: "image/jpeg",
          name: "product.jpg",
        },
      ],
      presentation: {
        quick_replies: [{ title: "More", payload: "product.more" }],
        buttons: [
          {
            title: "Open",
            type: "url",
            url: "https://example.com/product",
          },
        ],
        carousel: [
          {
            title: "Related",
            subtitle: "Another product",
            image_url: "https://cdn.example/related.jpg",
            buttons: [
              {
                title: "Choose",
                type: "postback",
                payload: "product.choose",
              },
            ],
          },
        ],
      },
      idempotency_key: "flow:session:node:1",
      reply_to_message_id: "message-1",
    });
  });

  it("omits empty optional presentation content", () => {
    expect(
      serializeReplyInput({
        text: "Hello",
        idempotencyKey: "inbox:conversation:message:1",
      }),
    ).toEqual({
      text: "Hello",
      attachments: [],
      presentation: null,
      idempotency_key: "inbox:conversation:message:1",
      reply_to_message_id: null,
    });
  });
});
