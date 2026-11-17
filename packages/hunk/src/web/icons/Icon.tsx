/** @jsxImportSource react */
/**
 * Draws one of the page's inline SVG icons.
 *
 * Icons are decoration: they are hidden from assistive technology, so the control that holds
 * one names itself (`aria-label` or visible text). They inherit the text color and size to
 * 16px unless a smaller `size` is asked for.
 */
import { isValidElement, type ReactNode } from "react";
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

const SVG_NS = "http://www.w3.org/2000/svg";

/** Appends the SVG nodes one icon entry describes, walking its fragments and shapes. */
function appendShapes(parent: Element, node: ReactNode) {
  if (!isValidElement(node)) return;
  const { children, ...attributes } = node.props as Record<string, unknown> & {
    children?: ReactNode;
  };
  if (typeof node.type !== "string") {
    // A fragment: its children belong to the parent.
    for (const child of Array.isArray(children) ? children : [children]) {
      appendShapes(parent, child as ReactNode);
    }
    return;
  }
  const shape = document.createElementNS(SVG_NS, node.type);
  for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, String(value));
  parent.append(shape);
}

/**
 * Builds one icon as a DOM node, for the controls the page draws inside Pierre's diff, which
 * React does not render. It matches `Icon` exactly: same grid, stroke, and hidden-from-AT
 * treatment.
 */
export function createIconElement(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.dataset.icon = name;
  appendShapes(svg, ICON_PATHS[name]);
  return svg;
}
