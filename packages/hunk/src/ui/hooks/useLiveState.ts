import { useCallback, useRef, useState, type SetStateAction } from "react";

/** Publish input-owned state eagerly so consecutive terminal events see preceding edits. */
export function useLiveState<T>(initial: T) {
  const [value, setValue] = useState(() => initial);
  const valueRef = useRef(initial);
  const getValue = useCallback(() => valueRef.current, []);
  const updateValue = useCallback((next: SetStateAction<T>) => {
    const resolved =
      typeof next === "function" ? (next as (previous: T) => T)(valueRef.current) : next;
    valueRef.current = resolved;
    setValue(() => resolved);
  }, []);
  return [value, updateValue, getValue] as const;
}
