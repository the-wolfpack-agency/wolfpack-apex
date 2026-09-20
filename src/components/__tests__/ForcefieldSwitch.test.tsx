/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { ForcefieldSwitch } from "@/components/ForcefieldSwitch";

describe("ForcefieldSwitch", () => {
  it("reads MONITORING and invites turning protection on when off", () => {
    const onToggle = jest.fn();
    render(<ForcefieldSwitch mode="monitor" canManage onToggle={onToggle} wouldActCount={3} />);
    expect(screen.getByTestId("edge-policy-mode")).toHaveTextContent(/monitoring/i);
    expect(screen.getByTestId("edge-policy")).toHaveTextContent(/nothing is blocked/i);
    // the protection stat frames the standby count as motivation to turn it on
    expect(screen.getByTestId("forcefield-standby-count")).toHaveTextContent(/3 hostile agents.*turn this on/i);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("reads PROTECTING and shows what it is guarding against when on", () => {
    render(<ForcefieldSwitch mode="enforce" canManage onToggle={jest.fn()} wouldActCount={2} />);
    expect(screen.getByTestId("edge-policy-mode")).toHaveTextContent(/protecting/i);
    expect(screen.getByTestId("edge-policy")).toHaveTextContent(/blocked or challenged in real time/i);
    expect(screen.getByTestId("forcefield-standby-count")).toHaveTextContent(/guarding against 2 hostile agents/i);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("toggles monitor -> enforce on click", () => {
    const onToggle = jest.fn();
    render(<ForcefieldSwitch mode="monitor" canManage onToggle={onToggle} wouldActCount={0} />);
    fireEvent.click(screen.getByTestId("edge-policy-toggle"));
    expect(onToggle).toHaveBeenCalledWith("enforce");
  });

  it("is disabled and does not toggle for a viewer who cannot manage", () => {
    const onToggle = jest.fn();
    render(<ForcefieldSwitch mode="monitor" canManage={false} onToggle={onToggle} wouldActCount={1} />);
    const sw = screen.getByTestId("edge-policy-toggle");
    expect(sw).toBeDisabled();
    fireEvent.click(sw);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("says all clear when nothing hostile is in range", () => {
    render(<ForcefieldSwitch mode="enforce" canManage onToggle={jest.fn()} wouldActCount={0} />);
    expect(screen.getByTestId("forcefield-standby-count")).toHaveTextContent(/all clear/i);
  });
});
