/**
 * @jest-environment jsdom
 *
 * MetricTile + useCountUp. Asserts: renders value + label, zero state, the
 * count-up reaches its final value, accent + delta direction/colour, the
 * inverted-delta colour mapping, a pre-formatted display string, a sparkline
 * slot, and that the reduced-motion path (default in jsdom, no matchMedia)
 * shows the final value instantly without throwing.
 */

import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";
import { MetricTile, Sparkline } from "@/components/console";

/* Helper: enable animation (matchMedia → reduce:false) + a synchronous RAF so
 * the count-up runs deterministically to completion in the test. */
function withAnimation(run: () => void) {
  const origMM = window.matchMedia;
  const origRAF = window.requestAnimationFrame;
  const origCAF = window.cancelAnimationFrame;
  (window as unknown as { matchMedia: typeof window.matchMedia }).matchMedia =
    ((q: string) => ({
      matches: false,
      media: q,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      onchange: null,
      dispatchEvent: () => true,
    })) as unknown as typeof window.matchMedia;
  // Drive RAF forward in big time steps so easeOut completes immediately.
  let t = 0;
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    t += 1000;
    cb(t);
    return 1 as unknown as number;
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = (() => {}) as typeof window.cancelAnimationFrame;
  try {
    run();
  } finally {
    window.matchMedia = origMM;
    window.requestAnimationFrame = origRAF;
    window.cancelAnimationFrame = origCAF;
  }
}

describe("MetricTile — render", () => {
  test("renders the value and label (reduced-motion default → instant)", () => {
    render(<MetricTile value={128} label="Open findings" />);
    expect(screen.getByTestId("metric-value")).toHaveTextContent("128");
    expect(screen.getByTestId("metric-label")).toHaveTextContent(
      "Open findings",
    );
  });

  test("zero value renders 0, not a dash or blank", () => {
    render(<MetricTile value={0} label="Critical" />);
    expect(screen.getByTestId("metric-value")).toHaveTextContent("0");
  });

  test("non-numeric (no value, no display) renders an em-free placeholder", () => {
    render(<MetricTile label="N/A" />);
    expect(screen.getByTestId("metric-value")).toHaveTextContent("—");
  });

  test("pre-formatted display string takes precedence over value", () => {
    render(<MetricTile value={1500} display="1.5k" label="Events" />);
    expect(screen.getByTestId("metric-value")).toHaveTextContent("1.5k");
  });

  test("decimals are honoured in the formatted value", () => {
    render(<MetricTile value={3.14159} decimals={2} label="Score" animate={false} />);
    expect(screen.getByTestId("metric-value")).toHaveTextContent("3.14");
  });

  test("accent colour is applied to the value", () => {
    render(<MetricTile value={5} label="x" accent="var(--wp-gold)" />);
    expect(screen.getByTestId("metric-value").style.color).toBe(
      "var(--wp-gold)",
    );
  });

  test("renders a sparkline slot when provided", () => {
    render(
      <MetricTile
        value={9}
        label="trend"
        sparkline={<Sparkline data={[1, 2, 3]} />}
      />,
    );
    expect(screen.getByTestId("metric-sparkline")).toBeInTheDocument();
    expect(screen.getByTestId("sparkline")).toBeInTheDocument();
  });
});

describe("MetricTile — delta", () => {
  test("positive delta → up arrow, success colour by default", () => {
    render(<MetricTile value={10} label="x" delta={{ value: 4 }} />);
    const d = screen.getByTestId("metric-delta");
    expect(d.getAttribute("data-direction")).toBe("up");
    expect(d.getAttribute("data-sentiment")).toBe("good");
    expect(d.style.color).toBe("var(--wp-success, #22c55e)");
  });

  test("negative delta → down arrow, error colour by default", () => {
    render(<MetricTile value={10} label="x" delta={{ value: -2 }} />);
    const d = screen.getByTestId("metric-delta");
    expect(d.getAttribute("data-direction")).toBe("down");
    expect(d.style.color).toBe("var(--wp-error, #ef4444)");
  });

  test("invertColor flips the sentiment (a drop is good)", () => {
    render(
      <MetricTile
        value={3}
        label="vulns"
        delta={{ value: -5, invertColor: true }}
      />,
    );
    const d = screen.getByTestId("metric-delta");
    expect(d.getAttribute("data-sentiment")).toBe("good");
    expect(d.style.color).toBe("var(--wp-success, #22c55e)");
  });

  test("flat delta → neutral sentiment", () => {
    render(<MetricTile value={1} label="x" delta={{ value: 0 }} />);
    expect(
      screen.getByTestId("metric-delta").getAttribute("data-sentiment"),
    ).toBe("neutral");
  });

  test("custom delta label overrides the formatted value", () => {
    render(
      <MetricTile value={1} label="x" delta={{ value: 12, label: "+12%" }} />,
    );
    expect(screen.getByTestId("metric-delta")).toHaveTextContent("+12%");
  });
});

describe("MetricTile — count-up", () => {
  test("count-up reaches the final value when animation is enabled", () => {
    withAnimation(() => {
      act(() => {
        render(<MetricTile value={250} label="ramp" />);
      });
      // With our fast-forward RAF the easeOut settles on the final value.
      expect(screen.getByTestId("metric-value")).toHaveTextContent("250");
    });
  });

  test("reduced-motion (no matchMedia in jsdom) shows final value instantly, no throw", () => {
    expect(() => {
      render(<MetricTile value={77} label="instant" />);
    }).not.toThrow();
    expect(screen.getByTestId("metric-value")).toHaveTextContent("77");
  });
});

describe("MetricTile — responsive overflow contract", () => {
  // jsdom can't measure layout; assert the CSS contract that lets a long
  // value/label/delta wrap instead of forcing the tile wider than its track.
  test("the tile root can shrink below its content (minWidth:0)", () => {
    render(<MetricTile value={1} label="x" />);
    expect(screen.getByTestId("metric-tile").style.minWidth).toBe("0");
  });

  test("a long display value wraps instead of forcing width", () => {
    render(
      <MetricTile
        display="a-very-long-unbreakable-pre-formatted-value-string"
        label="x"
      />,
    );
    const v = screen.getByTestId("metric-value");
    expect(v.style.minWidth).toBe("0");
    expect(v.style.overflowWrap).toBe("anywhere");
  });

  test("the label wraps long unbreakable text (minWidth:0 / overflow-wrap)", () => {
    render(<MetricTile value={1} label="a-very-long-unbreakable-label" />);
    const l = screen.getByTestId("metric-label");
    expect(l.style.minWidth).toBe("0");
    expect(l.style.overflowWrap).toBe("anywhere");
  });
});
