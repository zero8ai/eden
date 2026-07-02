/**
 * Theme selector: System (default, follows the OS) / Light / Dark.
 *
 * The choice persists in the `eden-theme` cookie (1yr, SameSite=Lax), read
 * before first paint by the inline script in app/root.tsx so there's no flash.
 * Setting it here applies the class immediately — no navigation/round-trip.
 */
import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

const THEME_COOKIE = "eden-theme";
type Theme = "system" | "light" | "dark";

function readTheme(): Theme {
  if (typeof document === "undefined") return "system";
  const m = document.cookie.match(/(?:^|; )eden-theme=([^;]+)/);
  const v = m ? decodeURIComponent(m[1]) : "system";
  return v === "light" || v === "dark" ? v : "system";
}

/** Apply `pref` to <html> and persist it; mirrors the pre-paint script in root.tsx. */
function applyTheme(pref: Theme) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = pref === "dark" || (pref === "system" && prefersDark);
  document.documentElement.classList.toggle("dark", dark);
  document.cookie = `${THEME_COOKIE}=${pref}; path=/; max-age=31536000; SameSite=Lax`;
}

const OPTIONS: { value: Theme; label: string; icon: typeof Monitor }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

export function ThemeToggle() {
  // Start as "system" for a stable SSR/first-client render, then hydrate the
  // real cookie value in an effect to avoid a hydration mismatch.
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => setTheme(readTheme()), []);

  const Active = OPTIONS.find((o) => o.value === theme)?.icon ?? Monitor;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Change theme">
          <Active className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {OPTIONS.map(({ value, label, icon: Icon }) => (
          <DropdownMenuItem
            key={value}
            onSelect={() => {
              setTheme(value);
              applyTheme(value);
            }}
            className={theme === value ? "font-medium" : undefined}
          >
            <Icon className="mr-2 h-4 w-4" />
            {label}
            {theme === value && <span className="ml-auto text-xs">✓</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
