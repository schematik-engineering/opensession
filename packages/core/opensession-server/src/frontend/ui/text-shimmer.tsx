import type { CSSProperties } from "react";
import { cn } from "./cn";

const sweepAnimation: CSSProperties = {
  animationName: "text-shimmer-window",
  animationDuration: "var(--text-shimmer-duration, 2s)",
  animationTimingFunction: "var(--text-shimmer-easing, linear)",
  animationDelay: "var(--text-shimmer-delay, 0s)",
  animationIterationCount: "infinite",
  animationFillMode: "both",
};

const copyAnimation: CSSProperties = {
  ...sweepAnimation,
  animationName: "text-shimmer-copy",
};

/**
 * A compositor-only highlight sweep over a short text label.
 *
 * The masked window and its text copy move in opposite directions, so the
 * duplicate glyphs stay registered with the visible label while only the mask
 * travels. Both animations change `transform`, avoiding the per-frame paint
 * caused by animating a clipped gradient's background position.
 */
export function TextShimmer({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <span
      className={cn("relative inline-block [contain:paint]", className)}
      data-text-shimmer=""
    >
      <span>{children}</span>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 select-none text-[var(--text-shimmer-highlight)] [mask-image:linear-gradient(90deg,transparent_25%,black_45%,black_55%,transparent_75%)] [mask-repeat:no-repeat] [mask-size:100%_100%] [will-change:transform] [-webkit-mask-image:linear-gradient(90deg,transparent_25%,black_45%,black_55%,transparent_75%)] [-webkit-mask-repeat:no-repeat] [-webkit-mask-size:100%_100%]"
        style={sweepAnimation}
      >
        <span
          className="block w-full [will-change:transform]"
          style={copyAnimation}
        >
          {children}
        </span>
      </span>
    </span>
  );
}
