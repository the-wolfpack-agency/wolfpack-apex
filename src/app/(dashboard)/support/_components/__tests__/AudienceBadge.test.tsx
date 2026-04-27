/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import AudienceBadge, {
  AUDIENCE_LABEL,
  type Audience,
} from "@/app/(dashboard)/support/_components/AudienceBadge";

describe("<AudienceBadge />", () => {
  const cases: Audience[] = ["client", "internal"];

  test.each(cases)("renders the correct label for %s", (aud) => {
    render(<AudienceBadge audience={aud} />);
    const el = screen.getByTestId(`audience-badge-${aud}`);
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute("data-audience", aud);
    expect(el.textContent).toBe(AUDIENCE_LABEL[aud]);
  });

  test("client and internal use distinct background colors", () => {
    const { unmount } = render(<AudienceBadge audience="client" />);
    const clientEl = screen.getByTestId("audience-badge-client");
    const clientBg = clientEl.style.background;
    unmount();

    render(<AudienceBadge audience="internal" />);
    const internalEl = screen.getByTestId("audience-badge-internal");
    const internalBg = internalEl.style.background;

    expect(clientBg).toBeTruthy();
    expect(internalBg).toBeTruthy();
    expect(clientBg).not.toBe(internalBg);
    /* `client` uses the info-blue rgb seed. */
    expect(clientBg).toContain("82, 154, 232");
  });

  test("each audience has an accessible label exposing its meaning", () => {
    render(<AudienceBadge audience="client" />);
    const el = screen.getByTestId("audience-badge-client");
    expect(el.getAttribute("aria-label")).toBe("Audience: Client");
    /* The title attr provides an extended hover hint that explains
       the routing behavior the badge represents. */
    expect(el.getAttribute("title")).toMatch(/support@thewolfpack\.agency/);
  });
});
