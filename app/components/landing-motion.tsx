/**
 * Landing-page motion primitives.
 *
 * Reveal   — fades + rises its children in the first time they scroll into view
 *            (IntersectionObserver; reveals once, then stops observing).
 * Parallax — nudges its children up/down as they cross the viewport, driven by a
 *            single rAF-throttled scroll listener for a subtle layered-depth feel.
 *
 * Both no-op for visitors who ask for reduced motion. The hidden pre-reveal state
 * lives in app.css under `@media (prefers-reduced-motion: no-preference)`, so with
 * reduced motion (or if this JS never runs) the content is simply visible.
 */
import {
  useEffect,
  useRef,
  type ElementType,
  type ReactNode,
  type CSSProperties,
} from "react";

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

type RevealProps = {
  as?: ElementType;
  /** Stagger, in ms, applied as the transition-delay. */
  delay?: number;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
};

export function Reveal({
  as: Tag = "div",
  delay = 0,
  className,
  style,
  children,
}: RevealProps) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion()) {
      el.classList.add("is-visible");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            el.classList.add("is-visible");
            io.unobserve(el);
          }
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Tag
      ref={ref}
      data-reveal=""
      className={className}
      style={{ ...style, "--reveal-delay": `${delay}ms` } as CSSProperties}
    >
      {children}
    </Tag>
  );
}

type ParallaxProps = {
  as?: ElementType;
  /**
   * Drift strength. Positive numbers make the element lag the scroll (drifts
   * down as the page moves up); ~0.05–0.25 stays subtle. Larger = more travel.
   */
  speed?: number;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
};

export function Parallax({
  as: Tag = "div",
  speed = 0.15,
  className,
  style,
  children,
}: ParallaxProps) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;

    let raf = 0;
    const update = () => {
      raf = 0;
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight || 1;
      // -1 (element below the fold) … 0 (centered) … 1 (above the fold)
      const progress = (rect.top + rect.height / 2 - vh / 2) / (vh / 2);
      const clamped = Math.max(-1.5, Math.min(1.5, progress));
      el.style.transform = `translate3d(0, ${clamped * speed * 100}px, 0)`;
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };

    el.style.willChange = "transform";
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [speed]);

  return (
    <Tag ref={ref} className={className} style={style}>
      {children}
    </Tag>
  );
}
