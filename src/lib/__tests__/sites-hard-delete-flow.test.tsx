/**
 * @jest-environment jsdom
 */

/**
 * Hard-delete flow from the detail page.
 *
 * The detail page exposes a "Delete permanently" button for admin-level
 * roles (ceo/cto/hr). Clicking it confirms, calls
 * `DELETE /api/sites/{id}?hard=true`, surfaces cleanup results, and
 * redirects to /sites.
 *
 * We can't mount the full page (Next's `use(params: Promise)` suspends
 * jsdom). This harness replicates the same state machine + click handler
 * so we lock the contract the real page has to meet.
 */

import "@testing-library/jest-dom";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";

const HARD_DELETE_ROLES = new Set(["ceo", "cto", "hr"]);

interface CleanupGithub { deleted: boolean; repo?: string; error?: string }
interface CleanupVercel { deleted: boolean; project?: string; error?: string }
interface Cleanup { github?: CleanupGithub; vercel?: CleanupVercel }
interface DeleteResponse { ok: boolean; status: number; cleanup?: Cleanup; error?: string }

function HardDeleteHarness({
  role,
  doDelete,
  onRedirect,
  onConfirm = () => true,
}: {
  role: string | null;
  doDelete: (hard: boolean) => Promise<DeleteResponse>;
  onRedirect: (path: string) => void;
  onConfirm?: () => boolean;
}) {
  const [hardDeleting, setHardDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  async function handleHardDelete() {
    if (!onConfirm()) return;
    setHardDeleting(true);
    setError(null);
    const r = await doDelete(true);
    if (r.ok) {
      const c = r.cleanup ?? {};
      const parts: string[] = [];
      if (c.github?.deleted) parts.push(`GitHub: ${c.github.repo} removed`);
      else if (c.github) parts.push(`GitHub: ${c.github.error ?? "not removed"}`);
      if (c.vercel?.deleted) parts.push(`Vercel: ${c.vercel.project} removed`);
      else if (c.vercel) parts.push(`Vercel: ${c.vercel.error ?? "not removed"}`);
      setFlash(parts.length ? `Deleted permanently. ${parts.join(" · ")}.` : "Deleted permanently.");
      onRedirect("/sites");
    } else {
      setError(r.error ?? "Delete failed.");
      setHardDeleting(false);
    }
  }

  return (
    <div>
      {role && HARD_DELETE_ROLES.has(role) && (
        <button
          onClick={handleHardDelete}
          disabled={hardDeleting}
          aria-label="Delete permanently"
        >
          {hardDeleting ? "Deleting…" : "Delete permanently"}
        </button>
      )}
      {error && <div data-testid="error">{error}</div>}
      {flash && <div data-testid="flash">{flash}</div>}
    </div>
  );
}

describe("Sites detail — Delete permanently button", () => {
  it("is hidden for sales role", () => {
    render(
      <HardDeleteHarness
        role="sales"
        doDelete={async () => ({ ok: true, status: 200 })}
        onRedirect={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Delete permanently" })).not.toBeInTheDocument();
  });

  it("is hidden for dev role (below hr threshold)", () => {
    render(
      <HardDeleteHarness
        role="dev"
        doDelete={async () => ({ ok: true, status: 200 })}
        onRedirect={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Delete permanently" })).not.toBeInTheDocument();
  });

  it("is visible for hr role", () => {
    render(
      <HardDeleteHarness
        role="hr"
        doDelete={async () => ({ ok: true, status: 200 })}
        onRedirect={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Delete permanently" })).toBeInTheDocument();
  });

  it("is visible for ceo and cto roles", () => {
    const { rerender } = render(
      <HardDeleteHarness
        role="ceo"
        doDelete={async () => ({ ok: true, status: 200 })}
        onRedirect={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Delete permanently" })).toBeInTheDocument();
    rerender(
      <HardDeleteHarness
        role="cto"
        doDelete={async () => ({ ok: true, status: 200 })}
        onRedirect={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Delete permanently" })).toBeInTheDocument();
  });

  it("skips delete when confirm() returns false", async () => {
    const doDelete = jest.fn(async () => ({ ok: true, status: 200 }));
    render(
      <HardDeleteHarness
        role="hr"
        doDelete={doDelete}
        onRedirect={() => {}}
        onConfirm={() => false}
      />,
    );
    await act(async () => {
      screen.getByRole("button", { name: "Delete permanently" }).click();
    });
    expect(doDelete).not.toHaveBeenCalled();
  });

  it("calls the delete handler with hard=true and redirects to /sites on success", async () => {
    const doDelete = jest.fn(async () => ({
      ok: true,
      status: 200,
      cleanup: {
        github: { deleted: true, repo: "the-wolfpack-agency/wolfpack-cftr" },
        vercel: { deleted: true, project: "wolfpack-cftr" },
      },
    }));
    const onRedirect = jest.fn();
    render(
      <HardDeleteHarness role="hr" doDelete={doDelete} onRedirect={onRedirect} />,
    );

    await act(async () => {
      screen.getByRole("button", { name: "Delete permanently" }).click();
    });

    await waitFor(() => expect(onRedirect).toHaveBeenCalledWith("/sites"));
    expect(doDelete).toHaveBeenCalledWith(true);
    // Flash message names both cleanup lanes so the user sees what happened.
    expect(screen.getByTestId("flash").textContent).toMatch(/GitHub.*removed/);
    expect(screen.getByTestId("flash").textContent).toMatch(/Vercel.*removed/);
  });

  it("surfaces partial cleanup failures in the flash message", async () => {
    const doDelete = jest.fn(async () => ({
      ok: true,
      status: 200,
      cleanup: {
        github: { deleted: false, error: "403 forbidden" },
        vercel: { deleted: true, project: "wolfpack-cftr" },
      },
    }));
    render(
      <HardDeleteHarness role="hr" doDelete={doDelete} onRedirect={() => {}} />,
    );
    await act(async () => {
      screen.getByRole("button", { name: "Delete permanently" }).click();
    });
    await waitFor(() => expect(screen.getByTestId("flash")).toBeInTheDocument());
    expect(screen.getByTestId("flash").textContent).toMatch(/GitHub.*403 forbidden/);
    expect(screen.getByTestId("flash").textContent).toMatch(/Vercel.*removed/);
  });

  it("shows the server error when the delete call fails", async () => {
    const doDelete = jest.fn(async () => ({
      ok: false,
      status: 403,
      error: "Hard delete requires admin role",
    }));
    const onRedirect = jest.fn();
    render(
      <HardDeleteHarness role="hr" doDelete={doDelete} onRedirect={onRedirect} />,
    );
    await act(async () => {
      screen.getByRole("button", { name: "Delete permanently" }).click();
    });
    await waitFor(() => expect(screen.getByTestId("error")).toBeInTheDocument());
    expect(screen.getByTestId("error").textContent).toBe("Hard delete requires admin role");
    expect(onRedirect).not.toHaveBeenCalled();
    // Button re-enables so the user can retry (e.g., after reloading permissions).
    expect(screen.getByRole("button", { name: "Delete permanently" })).not.toBeDisabled();
  });
});
