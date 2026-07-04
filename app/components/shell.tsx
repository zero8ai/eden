/**
 * Shared application chrome, encoding the product hierarchy (D2/D3 + the eve model):
 *   workspace (org) → agents (projects, 1 repo == 1 root agent) → environments/deployments.
 *
 * AppShell renders the workspace-level header; AgentNav renders the per-agent section nav
 * (Overview = the repo-backed config surface, then Deployments / Runs / Secrets / Assistant).
 */
import { LogOut, User, Users } from "lucide-react";
import { Form, Link, NavLink, useLocation, useNavigate } from "react-router";

import { ThemeToggle } from "~/components/theme-toggle";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import { TooltipProvider } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

export function AppShell({
  workspaceName,
  userEmail,
  children,
}: {
  workspaceName?: string | null;
  userEmail?: string | null;
  children: React.ReactNode;
}) {
  return (
    <TooltipProvider>
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-4 px-6">
          <Link to="/dashboard" className="flex items-baseline gap-2">
            <span className="text-base font-semibold tracking-tight">Eden</span>
            {workspaceName && (
              <>
                <span className="text-muted-foreground">/</span>
                <span className="max-w-48 truncate text-sm text-muted-foreground">
                  {workspaceName}
                </span>
              </>
            )}
          </Link>
          <nav className="ml-4 flex items-center gap-1 text-sm">
            <HeaderLink to="/dashboard">Agents</HeaderLink>
            <HeaderLink to="/connect">Connect</HeaderLink>
            <HeaderLink to="/org/settings">Settings</HeaderLink>
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <AccountMenu userEmail={userEmail} />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
    </TooltipProvider>
  );
}

/** Account dropdown behind a user icon: shows who's signed in, and Sign out. */
function AccountMenu({ userEmail }: { userEmail?: string | null }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Account">
          <User className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {userEmail && (
          <>
            <DropdownMenuLabel className="font-normal">
              <span className="block text-xs text-muted-foreground">
                Signed in as
              </span>
              <span className="block truncate text-sm font-medium">
                {userEmail}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        <Form method="post" action="/dashboard">
          <DropdownMenuItem asChild>
            <button type="submit" className="w-full cursor-pointer">
              <LogOut className="mr-2 h-4 w-4" />
              Sign out
            </button>
          </DropdownMenuItem>
        </Form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HeaderLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground",
          isActive && "bg-accent text-foreground",
        )
      }
    >
      {children}
    </NavLink>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Minimal roster info the switcher needs (serializable through loaders). */
export interface RosterMember {
  name: string;
}

/**
 * Per-project section navigation. `base` is `/projects/<id>`. For team repos (roster > 1,
 * PRD §7.9) a member switcher renders beside the tabs, and every tab link carries the
 * active member as `?agent=<name>` so the selection follows you across tabs.
 */
export function AgentNav({
  base,
  roster,
  activeAgent,
}: {
  base: string;
  roster?: RosterMember[];
  activeAgent?: string;
}) {
  const isTeam = (roster?.length ?? 0) > 1;
  const suffix =
    isTeam && activeAgent ? `?agent=${encodeURIComponent(activeAgent)}` : "";
  const items = [
    { to: `${base}${suffix}`, label: "Overview", end: true },
    { to: `${base}/changes${suffix}`, label: "Changes" },
    { to: `${base}/deployments${suffix}`, label: "Deployments" },
    { to: `${base}/playground${suffix}`, label: "Playground" },
    { to: `${base}/runs${suffix}`, label: "Runs" },
    { to: `${base}/secrets${suffix}`, label: "Secrets" },
    { to: `${base}/assistant${suffix}`, label: "Assistant" },
  ];
  return (
    <div className="mb-8">
      <div className="flex items-center justify-between gap-3">
        <nav className="flex items-center gap-1 text-sm">
          {items.map((item) => (
            <NavLink
              key={item.label}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  "rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground",
                  isActive && "bg-accent font-medium text-foreground",
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        {isTeam && roster && activeAgent && (
          <AgentSwitcher roster={roster} activeAgent={activeAgent} />
        )}
      </div>
      <Separator className="mt-2" />
    </div>
  );
}

/** Team member picker: swaps `?agent=` on the current tab (state follows across tabs). */
function AgentSwitcher({
  roster,
  activeAgent,
}: {
  roster: RosterMember[];
  activeAgent: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <div className="flex items-center gap-2">
      <Users className="h-4 w-4 text-muted-foreground" aria-hidden />
      <Select
        value={activeAgent}
        onValueChange={(name) => {
          const params = new URLSearchParams(location.search);
          params.set("agent", name);
          navigate(`${location.pathname}?${params}`);
        }}
      >
        <SelectTrigger className="h-8 min-w-36 font-mono text-xs" aria-label="Team member">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {roster.map((m) => (
            <SelectItem key={m.name} value={m.name} className="font-mono text-xs">
              {m.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
