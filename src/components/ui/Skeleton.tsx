"use client";

/**
 * Skeleton — content-shaped placeholder during load.
 *
 * Replaces "Loading..." text with a structural ghost so the page
 * doesn't reflow when data arrives. Gradient shimmer animation lives
 * in globals.css via @keyframes wp-skeleton-shimmer.
 *
 * Usage:
 *   <Skeleton width="60%" height={20} />
 *   <Skeleton.Block lines={3} />
 *   <Skeleton.Card />
 */

import React from "react";

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  rounded?: number | string;
  className?: string;
  testId?: string;
}

const baseStyle: React.CSSProperties = {
  display: "block",
  background: "linear-gradient(90deg, var(--wp-dark-surface2) 0%, var(--wp-dark-border) 50%, var(--wp-dark-surface2) 100%)",
  backgroundSize: "200% 100%",
  animation: "wp-skeleton-shimmer 1.4s ease-in-out infinite",
  borderRadius: 6,
};

function Skeleton({
  width = "100%",
  height = 14,
  rounded,
  className,
  testId,
}: SkeletonProps) {
  return (
    <span
      data-testid={testId ?? "skeleton"}
      aria-hidden
      className={className}
      style={{
        ...baseStyle,
        width,
        height,
        borderRadius: rounded ?? baseStyle.borderRadius,
      }}
    />
  );
}

function Lines({ lines = 3, lastWidth = "65%" }: { lines?: number; lastWidth?: string }) {
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? lastWidth : "100%"} />
      ))}
    </span>
  );
}

function Card({ height = 96 }: { height?: number }) {
  return <Skeleton height={height} rounded={10} />;
}

Skeleton.Lines = Lines;
Skeleton.Card = Card;
export default Skeleton;
