import { useEffect, useRef, useState } from "react";

/**
 * Fires `callback` when a sentinel element enters the viewport.
 *
 * The root margin is generous (600px below) so the next page starts loading
 * before the reader reaches the end — infinite scroll without a stall.
 *
 * Returns a callback ref, not a ref object: the observer follows whichever element
 * is mounted. One page can swap its sentinel for another while `enabled` stays true
 * (the sessions list and the all-time calendar each render their own), and an
 * observer bound to the first one would keep watching a detached node — the next
 * page would never load.
 */
export function useIntersectionObserver(callback: () => void, enabled: boolean) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled || !el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) callbackRef.current();
      },
      { rootMargin: "0px 0px 600px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled, el]);

  return setEl;
}
