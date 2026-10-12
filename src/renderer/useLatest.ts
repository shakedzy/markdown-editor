import { useRef } from 'react';

/**
 * A ref holding `value` as of the latest render, for callbacks that stay
 * stable (listeners, editor extensions) yet must see current props or state.
 */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
