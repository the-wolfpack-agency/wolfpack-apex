/**
 * Navigate freely. Mutate never.
 *
 * WHY THE OLD RULE WAS TOO BLUNT. explore.ts refuses to click anything at all,
 * for a good reason it states plainly: on a live Salesforce a stray click can
 * convert a lead, send an email or fire a workflow, and "we were only mapping"
 * does not undo it.
 *
 * But a modern dashboard keeps its structure behind tabs, expanders and
 * client-side routing rather than behind <a href>. A crawler that only follows
 * links maps the shell of an app and reports it as the app. So "never click"
 * buys safety by buying blindness, and the honest rule is narrower: moving
 * around somebody's system is fine, changing it is not.
 *
 * DENY BY DEFAULT, WHICH IS THE ENTIRE DESIGN. An unrecognised control is
 * refused. The cost of refusing a harmless tab is a smaller map; the cost of
 * clicking one unrecognised "Publish" is a client's live form going out. Those
 * are not symmetrical, so the default is not symmetrical either.
 *
 * IT DECIDES, IT DOES NOT ACT. Pure, like every other rule in this directory,
 * so the whole policy is testable without a browser and without a client
 * system. The driver asks; this answers.
 */

/** What a browser driver can cheaply read off an element before deciding. */
export interface ClickCandidate {
  /** Lowercased tag: button, a, div, input, summary. */
  tag: string;
  /** Visible text, trimmed. The strongest signal by far. */
  text: string;
  /** aria-label or title, when the visible text is an icon. */
  label?: string;
  /** input/button type, when present. */
  type?: string;
  /** ARIA role, when set. */
  role?: string;
  /** True when the element sits inside a form element. */
  insideForm?: boolean;
  /** Present on links and link-styled controls. */
  href?: string;
  /** aria-expanded, present on disclosure controls. */
  ariaExpanded?: boolean;
  /**
   * True when the control sits inside a dialog or modal.
   *
   * The discriminator that lets a modal be dismissed without loosening
   * "close" everywhere. Closing a RECORD changes something; closing a DIALOG
   * changes nothing and is the only way to reach what is behind it.
   */
  insideDialog?: boolean;
  disabled?: boolean;
}

export type ClickVerdict =
  | { allowed: true; because: string }
  | { allowed: false; because: string };

/**
 * Words that mean something will change.
 *
 * Matched against the control's own words rather than the page's, because a
 * page titled "Delete requests" is a list and the button on it is not.
 *
 * Deliberately generous: a false refusal costs one unexplored control, and a
 * false allow costs a client something real. "Save" is here even though many
 * saves are no-ops, because the ones that are not are expensive.
 */
const MUTATING = new RegExp(
  [
    "\\b(create|new|add|insert)\\b",
    "\\b(delete|remove|destroy|erase|purge|discard|trash)\\b",
    "\\b(save|submit|apply|confirm|update|edit|rename)\\b",
    "\\b(send|email|invite|share|publish|deploy|release)\\b",
    "\\b(archive|restore|duplicate|copy to|move to|merge)\\b",
    "\\b(approve|reject|assign|resolve|close)\\b",
    "\\b(pay|charge|refund|subscribe|upgrade|downgrade|cancel)\\b",
    "\\b(revoke|reset|deactivate|disable|enable|impersonate)\\b",
    "\\b(import|export|download|upload|sync|run|execute|start|stop)\\b",
  ].join("|"),
  "i",
);

/**
 * Anything that ends the run, whatever else it does.
 *
 * Separate from MUTATING because the consequence is different: a logout does
 * not damage the client, it silently turns an authenticated map into an
 * unauthenticated one and every page after it is wrong.
 */
const ENDS_SESSION = /\b(log ?out|sign ?out|switch account|end session|lock)\b/i;

/**
 * Controls that move you around without changing anything.
 *
 * Allowed by NAME rather than by shape, because shape lies: a "Delete" is
 * often a <button> and so is a tab.
 */
const NAVIGATIONAL = new RegExp(
  [
    "\\b(next|previous|prev|back|forward|first|last)\\b",
    "\\b(page \\d+|show more|load more|view all|see all|expand|collapse)\\b",
    "\\b(details|overview|summary|settings|preferences|dashboard|home)\\b",
    "\\b(filter|sort|search|refresh|reload|preview|open)\\b",
    "\\b(close|dismiss|cancel dialog|back to)\\b",
  ].join("|"),
  "i",
);

/**
 * Words that close a dialog and nothing else.
 *
 * Anchored to the whole label rather than matched loosely, so "Close" and
 * "Close dialog" pass while "Close ticket" and "Close and delete" do not: the
 * second pair name a thing being acted on, and that thing is not the modal.
 */
const DISMISSES_DIALOG = /^(close|dismiss|cancel|not now|no thanks|got it|skip|maybe later|×|✕|x)(\s+(dialog|modal|window|this|welcome|popup|banner|message|tour))?$/i;

/** ARIA roles whose whole purpose is moving between views. */
const NAVIGATIONAL_ROLES = new Set(["tab", "tablist", "menuitem", "treeitem", "link", "navigation"]);

function words(c: ClickCandidate): string {
  return `${c.text ?? ""} ${c.label ?? ""}`.replace(/\s+/g, " ").trim();
}

/**
 * May the explorer click this?
 *
 * Order matters and is deliberate: the refusals run first, so a control
 * labelled "Save filter" is refused despite containing a navigational word.
 */
export function mayClick(candidate: ClickCandidate): ClickVerdict {
  const c = candidate;
  const said = words(c);

  if (c.disabled) {
    return { allowed: false, because: "disabled, so clicking proves nothing" };
  }

  /* AN UNLABELLED CONTROL IS AN UNKNOWN CONTROL. An icon button with no
     accessible name could be a refresh or a delete, and there is no way to
     tell from here. That it cannot be identified is itself a finding worth
     reporting, not a reason to try it. */
  if (!said) {
    return { allowed: false, because: "no accessible name, so its effect cannot be known" };
  }

  if (ENDS_SESSION.test(said)) {
    return { allowed: false, because: "would end the session and invalidate the rest of the map" };
  }

  /* DISMISSING A DIALOG IS NAVIGATION, AND IT HAS TO BE.
   *
   * Measured while mapping this product: "Close welcome" was refused, because
   * "close" is also how a ticket is closed and refusals run before
   * permissions. A modal that cannot be dismissed blocks everything behind it,
   * so one unclosable dialog costs the whole map below it.
   *
   * Loosening "close" globally would be the wrong fix: closing a record is
   * genuinely mutating. The dialog role is the discriminator, because it says
   * what the control is closing rather than what it is called.
   *
   * Deliberately narrow. Only plain dismissal words, and only inside a dialog:
   * a "Delete" button inside a confirmation modal is still a delete, and this
   * must never become a way to press it. */
  if (c.insideDialog && DISMISSES_DIALOG.test(said)) {
    return { allowed: true, because: "dismisses a dialog, which reveals what is behind it" };
  }

  if (MUTATING.test(said)) {
    return { allowed: false, because: `"${said}" reads as changing something` };
  }

  /* A SUBMIT IS A SUBMIT WHATEVER IT SAYS. The type attribute is the browser's
     own declaration that this sends a form, and it outranks a friendly label:
     "Continue" on a submit button still posts. */
  if (c.type === "submit" || c.type === "reset" || c.type === "image") {
    return { allowed: false, because: `type="${c.type}" submits a form` };
  }

  /* Inside a form, only a plainly navigational control is safe. Everything
     else in there exists to act on the form. */
  if (c.insideForm && !NAVIGATIONAL.test(said)) {
    return { allowed: false, because: "inside a form, and not plainly a navigation control" };
  }

  /* A real link is the case the old rule already allowed, and the safest
     thing on the page: the URL says where it goes before it is clicked. */
  if (c.tag === "a" && c.href) {
    return { allowed: true, because: "an ordinary link, whose destination is visible in advance" };
  }

  if (c.role && NAVIGATIONAL_ROLES.has(c.role)) {
    return { allowed: true, because: `role="${c.role}" exists to move between views` };
  }

  /* A disclosure control: its aria-expanded says it reveals rather than acts. */
  if (typeof c.ariaExpanded === "boolean") {
    return { allowed: true, because: "a disclosure control, which reveals rather than changes" };
  }

  if (c.tag === "summary") {
    return { allowed: true, because: "a details summary, which only expands" };
  }

  if (NAVIGATIONAL.test(said)) {
    return { allowed: true, because: `"${said}" reads as moving around rather than changing` };
  }

  /* THE DEFAULT, AND THE POINT OF THE FILE. Everything unrecognised is
     refused. A smaller map is a cost we can absorb; a client's form going out
     because a button was ambiguous is not. */
  return { allowed: false, because: "unrecognised control, and the default is to leave it alone" };
}

/** Split a set of candidates, so a caller can report what it declined and why. */
export function partitionByPolicy(candidates: ClickCandidate[]): {
  clickable: ClickCandidate[];
  declined: Array<{ candidate: ClickCandidate; because: string }>;
} {
  const clickable: ClickCandidate[] = [];
  const declined: Array<{ candidate: ClickCandidate; because: string }> = [];
  for (const c of candidates) {
    const verdict = mayClick(c);
    if (verdict.allowed) clickable.push(c);
    else declined.push({ candidate: c, because: verdict.because });
  }
  return { clickable, declined };
}
