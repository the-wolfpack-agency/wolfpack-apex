const DRAFT_KEY = "instinct_setup_draft_v1";

export interface SetupDraft {
  workspaceName?: string;
  invites?: { email: string; role: string }[];
}

export function loadDraft(): SetupDraft {
  if (typeof window === "undefined") return {};
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as SetupDraft;
  } catch {
    return {};
  }
}

export function saveDraft(draft: SetupDraft): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Non-fatal — storage may be unavailable
  }
}

export function clearDraft(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Non-fatal
  }
}
