/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * The section renders, and a concept cannot pass for a product.
 *
 * The defect being guarded: Phase One sat in the same nav as Assistant and
 * Search, styled identically, with nothing on it saying it was built for one
 * client. These assert the marker is present and carries the sentence that
 * distinguishes a measurement from a drawing.
 */

import { render, screen } from "@testing-library/react";
import BuildsPage from "@/app/(dashboard)/builds/page";
import ChangeManagementPage from "@/app/(dashboard)/builds/change-management/page";
import CourseProgramPage from "@/app/(dashboard)/builds/course-program/page";
import BuildBanner from "@/components/BuildBanner";
import { CLIENT_BUILDS, buildFor } from "@/lib/builds/registry";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

describe("the client builds index", () => {
  it("lists every build in the register", () => {
    render(<BuildsPage />);
    const list = screen.getByTestId("builds-list");
    for (const b of CLIENT_BUILDS) {
      expect(list).toHaveTextContent(b.title);
      expect(list).toHaveTextContent(b.client);
    }
  });

  /* Somebody deciding what to open should already know whether they are
     about to look at a measurement or a drawing. */
  it("says what each build's numbers are before it is opened", () => {
    render(<BuildsPage />);
    const list = screen.getByTestId("builds-list");
    for (const b of CLIENT_BUILDS) expect(list).toHaveTextContent(b.data);
  });

  it("links each build to its page", () => {
    render(<BuildsPage />);
    for (const b of CLIENT_BUILDS) {
      expect(screen.getByRole("link", { name: b.title })).toHaveAttribute("href", b.href);
    }
  });
});

describe("the build banner", () => {
  it("carries the stage, the client and what the numbers are", () => {
    render(<BuildBanner build={buildFor("/builds/change-management")!} />);
    expect(screen.getByTestId("build-banner-stage")).toHaveTextContent("Concept");
    expect(screen.getByTestId("build-banner")).toHaveTextContent("Porsche Academy US");
    /* THE LINE THAT STOPS A CONCEPT BEING DEMOED AS A PRODUCT. */
    expect(screen.getByTestId("build-banner-data")).toHaveTextContent(/Nothing is wired/i);
  });

  it("marks a measured page differently from a drawn one", () => {
    const { container } = render(<BuildBanner build={buildFor("/pilot")!} />);
    expect(container.querySelector(".wp-build-banner--in-flight")).not.toBeNull();
    expect(screen.getByTestId("build-banner-data")).toHaveTextContent(/measured against our own/i);
  });

  it("offers a way back to the register", () => {
    render(<BuildBanner build={buildFor("/pilot")!} />);
    expect(screen.getByRole("link", { name: /all client builds/i })).toHaveAttribute(
      "href",
      "/builds",
    );
  });
});

describe("the change management concept", () => {
  it("opens with their own words rather than a paraphrase", () => {
    render(<ChangeManagementPage />);
    expect(screen.getByTestId("cm-their-words")).toHaveTextContent(
      /share your plan with managers/i,
    );
  });

  /* THE FINDING THE WHOLE PAGE RESTS ON, ON THE PAGE. Three of the four
     moments have nowhere to live, and a reader has to see that without being
     told it in a sentence they could skip. */
  it("shows which moments a form can hold", () => {
    render(<ChangeManagementPage />);
    const flow = screen.getByTestId("cm-flow");
    expect(flow.querySelectorAll(".wp-build-flow--loose")).toHaveLength(3);
    expect(flow.querySelectorAll(".wp-build-flow--held")).toHaveLength(1);
  });

  it("puts a figure under every finding", () => {
    render(<ChangeManagementPage />);
    const findings = screen.getByTestId("cm-findings");
    expect(findings).toHaveTextContent(/39 screens walked/i);
    expect(findings).toHaveTextContent(/13 forms found/i);
  });

  it("shows overdue as a state a commitment can be in", () => {
    render(<ChangeManagementPage />);
    expect(screen.getByTestId("cm-states")).toHaveTextContent("overdue");
  });

  it("shows the constraint that keeps plans honest", () => {
    render(<ChangeManagementPage />);
    expect(screen.getByTestId("cm-candour")).toHaveTextContent(/counts and recurring themes/i);
  });

  /* A concept that hides what it does not know gets found out in the room
     where it is presented. */
  it("says on the page that the plan's fields have not been read", () => {
    render(<ChangeManagementPage />);
    expect(screen.getByTestId("cm-open")).toHaveTextContent(/what does the plan actually ask/i);
  });

  it("wears the concept banner, not an in-flight one", () => {
    const { container } = render(<ChangeManagementPage />);
    expect(container.querySelector(".wp-build-banner--concept")).not.toBeNull();
  });
});

/**
 * The new-course page: taking the method to a client who is not Porsche.
 *
 * The assertions below are the ones that would cost real money if the page
 * drifted: the copyright constraint, the ladder's order, and the admission
 * that we do not know who the client is.
 */
describe("the new course concept", () => {
  /* FIRST ON THE PAGE, BEFORE ANY IDEAS. Somebody skimming has to hit this
     before they start imagining slides. */
  it("leads with what we are not allowed to take", () => {
    render(<CourseProgramPage />);
    const ip = screen.getByTestId("cp-ip");
    expect(ip).toHaveTextContent(/cannot be copied or distributed/i);
    expect(ip).toHaveTextContent(/method transfers/i);
    expect(ip).toHaveTextContent(/materials do not/i);
  });

  /* The value is the ORDER, and a page that lost it would be selling a pile
     of worksheets. */
  it("shows the ladder as a sequence", () => {
    render(<CourseProgramPage />);
    const ladder = screen.getByTestId("cp-ladder");
    const text = ladder.textContent ?? "";
    expect(text.indexOf("SWOT")).toBeLessThan(text.indexOf("SMART"));
    expect(text.indexOf("SMART")).toBeLessThan(text.indexOf("Change Management Plan"));
    expect(text.indexOf("Change Management Plan")).toBeLessThan(text.indexOf("capstone"));
  });

  it("says of each component whether it travels", () => {
    render(<CourseProgramPage />);
    const table = screen.getByTestId("cp-components");
    expect(table).toHaveTextContent("rebuild");
    expect(table).toHaveTextContent("as written");
    expect(table).toHaveTextContent("structure only");
  });

  /* THE CORRECTION, VISIBLE. Claiming nobody follows up would be contradicted
     by the client's own material in the room. */
  it("credits the coaching that already runs", () => {
    render(<CourseProgramPage />);
    expect(screen.getByTestId("cp-improvements")).toHaveTextContent(/weekly for a year/i);
  });

  it("does not quote a price for a client it cannot name", () => {
    render(<CourseProgramPage />);
    expect(screen.getByTestId("cp-open")).toHaveTextContent(/who is the client/i);
  });

  it("wears the concept banner", () => {
    const { container } = render(<CourseProgramPage />);
    expect(container.querySelector(".wp-build-banner--concept")).not.toBeNull();
  });
});

/* The two pages are read together and must not contradict each other. */
describe("the change management page, corrected", () => {
  it("no longer claims nobody follows up", () => {
    render(<ChangeManagementPage />);
    expect(screen.getByTestId("cm-correction")).toHaveTextContent(/already runs for a year/i);
  });
});
