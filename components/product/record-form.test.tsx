// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { RecordForm } from "./record-form";
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("persisted product form behavior", () => {
  it("does not report success when creation fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "Permission denied" }), {
            status: 403,
          }),
        ),
    );
    render(
      <RecordForm
        fields={[{ key: "name", label: "Name", required: true }]}
        endpoint="/api/v1/crm/companies"
        redirectBase="/dashboard/crm/companies"
      />,
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Acme" },
    });
    fireEvent.click(screen.getByText("Create"));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain(
      "Permission denied",
    );
    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
  });
  it("preserves a current relationship outside initial selector limits", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "record", version: 2 })),
      );
    vi.stubGlobal("fetch", fetcher);
    render(
      <RecordForm
        fields={[
          { key: "company_id", label: "Company", reference: "companies" },
        ]}
        record={{
          id: "record",
          version: 1,
          company_id: "existing-outside-page",
        }}
        options={{ companies: [] }}
        endpoint="/api/v1/crm/deals"
        redirectBase="/dashboard/crm/deals"
      />,
    );
    expect((screen.getByLabelText("Company") as HTMLSelectElement).value).toBe(
      "existing-outside-page",
    );
    fireEvent.click(screen.getByText("Save changes"));
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      version: 1,
      company_id: "existing-outside-page",
    });
  });
  it("shows stale-write conflict and keeps operator edits intact", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: "Record changed. Reload before editing." }),
            { status: 409 },
          ),
        ),
    );
    render(
      <RecordForm
        fields={[{ key: "name", label: "Name" }]}
        record={{ id: "record", version: 1, name: "Old" }}
        endpoint="/api/v1/crm/companies"
        redirectBase="/dashboard/crm/companies"
      />,
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "My edit" },
    });
    fireEvent.click(screen.getByText("Save changes"));
    await screen.findByRole("alert");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "My edit",
    );
    expect(router.refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Reload"));
    expect(router.refresh).toHaveBeenCalledOnce();
  });
  it("navigates only after a confirmed create", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ id: "created" }), { status: 201 }),
        ),
    );
    render(
      <RecordForm
        fields={[{ key: "name", label: "Name" }]}
        endpoint="/api/v1/crm/companies"
        redirectBase="/dashboard/crm/companies"
      />,
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Acme" },
    });
    fireEvent.click(screen.getByText("Create"));
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith(
        "/dashboard/crm/companies/created",
      ),
    );
  });
});
