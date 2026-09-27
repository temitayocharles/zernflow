import { describe, expect, it } from "vitest";
import { parseConfiguration } from "./config-contracts";
describe("product integration configuration", () => {
  it("rejects imaginary provider success and forged reviewers", () => {
    expect(() =>
      parseConfiguration(
        "editorial_drafts",
        { version: 1, state: "published" },
        true,
      ),
    ).toThrow();
    expect(() =>
      parseConfiguration(
        "editorial_drafts",
        { version: 1, reviewed_by: "forged" },
        true,
      ),
    ).toThrow();
  });
  it("validates identity and knowledge configuration", () => {
    expect(() =>
      parseConfiguration("mailbox_identities", {
        name: "Support",
        address: "bad",
      }),
    ).toThrow();
    expect(() =>
      parseConfiguration("knowledge_sources", {
        name: "Source",
        source_ref: "ref",
        enabled: "yes",
      }),
    ).toThrow();
    expect(
      parseConfiguration("knowledge_sources", {
        name: "Source",
        source_ref: "ref",
        enabled: false,
      }),
    ).toMatchObject({ enabled: false });
  });
  it("bounds variant media and verifies timezone", () => {
    expect(() =>
      parseConfiguration(
        "editorial_variants",
        { version: 1, media_refs: Array(21).fill("x") },
        true,
      ),
    ).toThrow();
    expect(() =>
      parseConfiguration(
        "editorial_drafts",
        { version: 1, timezone: "not-a-zone" },
        true,
      ),
    ).toThrow();
  });
});

describe("content (editorial_drafts) publishing fields", () => {
  const A = "a0000000-0000-4000-8000-000000000001";
  it("validates campaign, kind, link, utm and assets", () => {
    expect(
      parseConfiguration("editorial_drafts", {
        name: "x", campaign_id: "", kind: "reel", link_url: "https://shop.example/p", utm: { campaign: "fall", term: "" }, asset_ids: [A, A],
      }),
    ).toEqual({ name: "x", campaign_id: null, kind: "reel", link_url: "https://shop.example/p", utm: { campaign: "fall" }, asset_ids: [A] });
    expect(() => parseConfiguration("editorial_drafts", { name: "x", link_url: "javascript:alert(1)" })).toThrow(/http/);
    expect(() => parseConfiguration("editorial_drafts", { name: "x", utm: { source: "x", evil: "y" } })).toThrow(/UTM/);
    expect(() => parseConfiguration("editorial_drafts", { name: "x", kind: "hologram" })).toThrow();
    expect(() => parseConfiguration("editorial_drafts", { name: "x", asset_ids: ["../etc"] })).toThrow();
    expect(() => parseConfiguration("editorial_variants", { draft_id: A, channel_id: A, body: "b", publish_state: "published" })).toThrow();
  });
});
