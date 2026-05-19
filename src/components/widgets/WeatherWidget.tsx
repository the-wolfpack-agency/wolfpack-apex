/**
 * WeatherWidget — empty-state demo widget for the `weather` tool.
 * Pure render: data flows in via WeatherWidgetSpec from the handler.
 *
 * Stays inside the var(--wp-*) token system so it inherits theme
 * changes. Uses a single emoji glyph for the condition icon (no new
 * dependency) — neighbors mix lucide-react + emoji depending on the
 * widget; emoji is the lowest-cost option and reads on every OS.
 */

"use client";

import { useEffect } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type { WeatherWidgetSpec } from "@/lib/assistant/widgets/types";

function emojiFor(condition: string): string {
  const c = condition.toLowerCase();
  if (c.includes("clear")) return "☀️";
  if (c.includes("partly")) return "⛅";
  if (c.includes("cloud")) return "☁️";
  if (c.includes("fog")) return "🌫️";
  if (c.includes("drizzle")) return "🌦️";
  if (c.includes("rain")) return "🌧️";
  if (c.includes("snow")) return "❄️";
  if (c.includes("thunder")) return "⛈️";
  return "🌡️";
}

export interface WeatherWidgetProps {
  spec: WeatherWidgetSpec;
  workflowId?: string;
}

export function WeatherWidget({ spec, workflowId }: WeatherWidgetProps) {
  useEffect(() => {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_rendered",
        metadata: {
          widget_kind: "weather",
          location: spec.location,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }, [spec.location, workflowId]);

  return (
    <div
      data-testid="weather-widget"
      className="mt-2 rounded-md p-3"
      style={{
        background: "var(--wp-dark-surface2, #1a1a1a)",
        border: "1px solid var(--wp-dark-border, #333)",
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div
            className="text-xs uppercase tracking-wider"
            style={{ color: "var(--wp-text-muted, #6b7280)" }}
          >
            {spec.location}
          </div>
          <div
            className="text-3xl font-semibold leading-tight mt-1"
            style={{ color: "var(--wp-text, #eee)" }}
            data-testid="weather-temperature"
          >
            {Math.round(spec.temperatureF)}°F
          </div>
          <div
            className="text-sm"
            style={{ color: "var(--wp-gold, #eab308)" }}
            data-testid="weather-condition"
          >
            {spec.condition}
          </div>
        </div>
        <div
          className="text-4xl"
          aria-hidden="true"
          data-testid="weather-icon"
        >
          {emojiFor(spec.condition)}
        </div>
      </div>

      <div
        className="mt-3 grid grid-cols-3 gap-2 text-xs"
        style={{ color: "var(--wp-text-dim, #aaa)" }}
      >
        <div data-testid="weather-highlow">
          High {Math.round(spec.highC * 9 / 5 + 32)}°F
          <br />
          Low {Math.round(spec.lowC * 9 / 5 + 32)}°F
        </div>
        <div data-testid="weather-humidity">Humidity {spec.humidity}%</div>
        <div data-testid="weather-wind">Wind {Math.round(spec.windMph)} mph</div>
      </div>
    </div>
  );
}
