import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MentionEmailPreference } from "@/components/workspaces/MentionEmailPreference";
import { loadMentionEmailPreference, setMentionEmailPreference } from "@/lib/shell/requests";

vi.mock("@/lib/shell/requests", () => ({
  loadMentionEmailPreference: vi.fn(),
  setMentionEmailPreference: vi.fn(),
}));

const WORKSPACE_ID = "30000000-0000-4000-8000-000000000001";

const load = vi.mocked(loadMentionEmailPreference);
const save = vi.mocked(setMentionEmailPreference);

function toggle(): HTMLInputElement {
  return screen.getByRole("checkbox", { name: /mentions me in a note/iu });
}

describe("MentionEmailPreference", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the stored preference rather than assuming a default", async () => {
    load.mockResolvedValue({ ok: true, data: { mentionEmail: false } });
    render(<MentionEmailPreference workspaceId={WORKSPACE_ID} />);

    await waitFor(() => expect(toggle()).not.toBeChecked());
    expect(load).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it("turns mention email off and reports it, without claiming notifications stop too", async () => {
    load.mockResolvedValue({ ok: true, data: { mentionEmail: true } });
    save.mockResolvedValue({ ok: true, data: { mentionEmail: false } });
    render(<MentionEmailPreference workspaceId={WORKSPACE_ID} />);
    await waitFor(() => expect(toggle()).toBeChecked());

    await userEvent.click(toggle());

    expect(save).toHaveBeenCalledWith(WORKSPACE_ID, false);
    await waitFor(() => expect(toggle()).not.toBeChecked());
    // The in-app notification is a separate channel and must not be implied gone.
    expect(await screen.findByText(/still see mentions in your notifications/iu)).toBeVisible();
  });

  it("adopts the SERVER's value, never the clicked one", async () => {
    load.mockResolvedValue({ ok: true, data: { mentionEmail: true } });
    // A server that refuses the change still answers with the truth.
    save.mockResolvedValue({ ok: true, data: { mentionEmail: true } });
    render(<MentionEmailPreference workspaceId={WORKSPACE_ID} />);
    await waitFor(() => expect(toggle()).toBeChecked());

    await userEvent.click(toggle());

    await waitFor(() => expect(toggle()).toBeChecked());
  });

  it("leaves the preference untouched and says so when the write fails", async () => {
    load.mockResolvedValue({ ok: true, data: { mentionEmail: true } });
    save.mockResolvedValue({ ok: false, kind: "network" });
    render(<MentionEmailPreference workspaceId={WORKSPACE_ID} />);
    await waitFor(() => expect(toggle()).toBeChecked());

    await userEvent.click(toggle());

    expect(await screen.findByText(/could not be saved/iu)).toBeVisible();
    // Still checked: a failed save must never look like it worked.
    expect(toggle()).toBeChecked();
  });

  it("offers a retry when the preference cannot be read, and shows no toggle", async () => {
    load.mockResolvedValueOnce({ ok: false, kind: "network" });
    load.mockResolvedValueOnce({ ok: true, data: { mentionEmail: true } });
    render(<MentionEmailPreference workspaceId={WORKSPACE_ID} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not be loaded/iu);
    expect(screen.queryByRole("checkbox")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /try again/iu }));

    await waitFor(() => expect(toggle()).toBeChecked());
  });

  it("names permission as the cause when the read is forbidden", async () => {
    load.mockResolvedValue({ ok: false, kind: "forbidden" });
    render(<MentionEmailPreference workspaceId={WORKSPACE_ID} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/do not have access/iu);
  });
});
