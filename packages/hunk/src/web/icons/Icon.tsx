/** @jsxImportSource react */
/**
 * Draws one of the page's inline SVG icons.
 *
 * Icons are decoration: they are hidden from assistive technology, so the control that holds
 * one names itself (`aria-label` or visible text). They inherit the text color and size to
 * 16px unless a smaller `size` is asked for.
 */
import { ICON_PATHS, type IconName } from "./iconPaths";

export type { IconName } from "./iconPaths";

export interface IconProps {
  name: IconName;
  /** The rendered width and height in pixels; the drawing stays on its 16px grid. */
  size?: number;
  className?: string;
}

/** One inline icon. */
export function Icon({ name, size = 16, className }: IconProps) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}
