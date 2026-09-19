/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { AgentOriginMap } from "@/components/AgentOriginMap";

const origins = [
  { country: "US", total: 40, welcomed: 6, flagged: 20, hostile: 14 },
  { country: "DE", total: 12, welcomed: 2, flagged: 10, hostile: 0 },
  { country: "ZZ", total: 3, welcomed: 0, flagged: 0, hostile: 3 }, // no centroid
];

describe("AgentOriginMap", () => {
  it("renders a node for countries with a centroid and lists all origins with exact counts", () => {
    render(<AgentOriginMap origins={origins} />);
    expect(screen.getByTestId("agent-origin-map")).toBeInTheDocument();
    // US + DE have centroids -> map nodes; ZZ has none -> no node but still listed.
    expect(screen.getByTestId("origin-node-US")).toBeInTheDocument();
    expect(screen.getByTestId("origin-node-DE")).toBeInTheDocument();
    expect(screen.queryByTestId("origin-node-ZZ")).not.toBeInTheDocument();
    const list = screen.getByTestId("agent-origin-list");
    expect(list).toHaveTextContent("US");
    expect(list).toHaveTextContent("ZZ"); // uncharted origin still surfaced
    expect(list).toHaveTextContent("14 hostile");
  });

  it("states the honest network-origin caveat, not a confirmed operator location", () => {
    render(<AgentOriginMap origins={origins} />);
    expect(screen.getByTestId("agent-origin-map")).toHaveTextContent(/network origin/i);
    expect(screen.getByTestId("agent-origin-map")).toHaveTextContent(/not a confirmed operator location/i);
  });

  it("renders an explicit empty state with no origins", () => {
    render(<AgentOriginMap origins={[]} />);
    expect(screen.getByTestId("agent-origin-map-empty")).toBeInTheDocument();
  });
});
