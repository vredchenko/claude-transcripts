import { useEffect, useRef } from "react";

/**
 * Fires `callback` when a sentinel element enters the viewport.
 *
 * The root margin is generous (600px below) so the next page starts loading
 * before the reader reaches the end — infinite scroll without a stall.
 */
export function useIntersectionObserver(callback: () => void, enabled: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) callbackRef.current();
      },
      { rootMargin: "0px 0px 600px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled]);

  return ref;
}
