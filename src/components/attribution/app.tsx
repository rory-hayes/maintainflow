"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import {
  Building2,
  Code2,
  Home,
  Users,
  Megaphone,
  PanelsTopLeft,
  Activity,
  Plug,
  Settings2,
  CreditCard,
  Menu,
  Info,
  ArrowUpRight,
  X,
} from "lucide-react";
import {
  emptyWorkspace,
  type Workspace,
  type Submission,
} from "@/lib/attribution/model";
import { sampleWorkspace } from "@/lib/attribution/sample";
import { CustomerSignOut } from "@/components/auth/supabase-auth-form";
import { Reporting, Leads, LeadDetail } from "./reporting";
import {
  Setup,
  Websites,
  Integrations,
  Health,
  Settings,
  NewWorkspace,
} from "./setup";
import "./styles.css";
const nav = [
  { name: "Overview", icon: Home },
  { name: "Leads", icon: Users },
  { name: "Campaigns", icon: Megaphone },
  { name: "Websites & forms", icon: PanelsTopLeft },
  { name: "Tracking health", icon: Activity },
  { name: "Integrations", icon: Plug },
  { name: "Setup", icon: Settings2 },
  { name: "Workspace & billing", icon: CreditCard },
];
export function AttributionApp({
  local = false,
  initialView = "Overview",
  initialLive = false,
  initialSample,
  signedIn = false,
}: {
  local?: boolean;
  initialView?: string;
  initialLive?: boolean;
  initialSample?: Workspace;
  signedIn?: boolean;
}) {
  // A late response belongs to the workspace that started it. It must never
  // replace a newer client selection or a return to the example workspace.
  const requestVersion = useRef(0);
  const navigationToggle = useRef<HTMLButtonElement>(null);
  const [w, setW] = useState<Workspace>(() =>
      initialLive
        ? emptyWorkspace(
            "",
            local ? "Local workspace" : "Your workspace",
            local ? "local" : "live",
          )
        : (initialSample ?? sampleWorkspace()),
    ),
    [view, setView] = useState(
      nav.some((n) => n.name === initialView) ? initialView : "Overview",
    ),
    [lead, setLead] = useState<Submission | null>(null),
    [workspaces, setWorkspaces] = useState<
      { id: string; name: string; role: string }[]
    >([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [mobile, setMobile] = useState(false),
    [role, setRole] = useState(""),
    [listLoaded, setListLoaded] = useState(false),
    [accessLoaded, setAccessLoaded] = useState(false),
    [creating, setCreating] = useState(false);
  const workspaceListLoaded = listLoaded && (local || signedIn);
  const workspaceAccessLoaded = accessLoaded && (local || signedIn);
  const hasWorkspaceAccess = workspaceAccessLoaded && Boolean(w.id && role);

  function closeNavigation() {
    setMobile(false);
    navigationToggle.current?.focus();
  }
  function navigate(next: string) {
    setView(next);
    setLead(null);
    if (mobile) closeNavigation();
    const url = new URL(location.href);
    url.searchParams.set("view", next);
    history.replaceState(null, "", url);
  }
  function showSample() {
    requestVersion.current++;
    const url = new URL(location.href);
    url.searchParams.set("mode", "sample");
    url.searchParams.delete("workspace");
    history.replaceState(null, "", url);
    setW(sampleWorkspace());
    setCreating(false);
    setError("");
    setNotice("");
    setLoading(false);
    navigate("Overview");
  }
  const selectWorkspace = useCallback(async (id: string) => {
    const request = ++requestVersion.current;
    setLoading(true);
    setAccessLoaded(false);
    setRole("");
    setError("");
    try {
      const r = await fetch(`/api/attribution/workspaces/${id}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      if (request !== requestVersion.current) return;
      setW(data.state);
      const url = new URL(location.href);
      url.searchParams.set("workspace", id);
      url.searchParams.set("mode", "live");
      history.replaceState(null, "", url);
      setRole(data.role);
      setAccessLoaded(true);
      setCreating(false);
      setLead(null);
    } catch (e) {
      if (request !== requestVersion.current) return;
      setError(e instanceof Error ? e.message : "Workspace unavailable.");
    } finally {
      if (request === requestVersion.current) setLoading(false);
    }
  }, []);
  const openLive = useCallback(async () => {
    const request = ++requestVersion.current;
    setLoading(true);
    setListLoaded(false);
    setAccessLoaded(false);
    setRole("");
    setCreating(false);
    setError("");
    setW(
      emptyWorkspace(
        "",
        local ? "Local workspace" : "Your workspace",
        local ? "local" : "live",
      ),
    );
    try {
      const r = await fetch("/api/attribution/workspaces");
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      if (request !== requestVersion.current) return;
      setWorkspaces(data.workspaces);
      setListLoaded(true);
      setAccessLoaded(true);
      if (data.workspaces.length) {
        const requested = new URL(location.href).searchParams.get("workspace");
        await selectWorkspace(
          data.workspaces.find((item: { id: string }) => item.id === requested)
            ?.id ?? data.workspaces[0].id,
        );
      } else setCreating(true);
      if (request === requestVersion.current) {
        const url = new URL(location.href);
        url.searchParams.set("mode", "live");
        history.replaceState(null, "", url);
      }
    } catch (e) {
      if (request !== requestVersion.current) return;
      setError(e instanceof Error ? e.message : "Could not load workspaces.");
    } finally {
      if (request === requestVersion.current) setLoading(false);
    }
  }, [local, selectWorkspace]);
  useEffect(() => {
    if (initialLive) queueMicrotask(() => void openLive());
  }, [initialLive, openLive]);
  async function act(body: Record<string, unknown>) {
    const request = requestVersion.current;
    setNotice("");
    setError("");
    if (w.mode === "sample") {
      setNotice(
        "This is an example workspace. Open your live workspace to save changes or connect an account.",
      );
      return;
    }
    if (role === "analyst") {
      setError(
        "You have read-only access. Ask a workspace owner or admin to make this change.",
      );
      throw new Error("You have read-only access.");
    }
    setLoading(true);
    try {
      const r = await fetch(`/api/attribution/workspaces/${w.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      if (request !== requestVersion.current) return;
      setW(data.state);
      setNotice("Workspace updated.");
    } catch (e) {
      if (request !== requestVersion.current) return;
      const message =
        e instanceof Error ? e.message : "The change could not be saved.";
      setError(message);
      throw e;
    } finally {
      if (request === requestVersion.current) setLoading(false);
    }
  }
  const safeAct = async (body: Record<string, unknown>) => {
    try {
      await act(body);
    } catch {
      /* Persistent error is rendered above the active view. */
    }
  };
  async function create(name: string, agency: boolean) {
    const request = ++requestVersion.current;
    setError("");
    setLoading(true);
    try {
      const r = await fetch("/api/attribution/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, agency }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      if (request !== requestVersion.current) return;
      setW(data);
      const url = new URL(location.href);
      url.searchParams.set("workspace", data.id);
      url.searchParams.set("mode", "live");
      history.replaceState(null, "", url);
      setWorkspaces([
        ...workspaces,
        { id: data.id, name: data.name, role: "owner" },
      ]);
      setRole("owner");
      setCreating(false);
      navigate("Setup");
    } catch (e) {
      if (request !== requestVersion.current) return;
      setError(e instanceof Error ? e.message : "Could not create workspace.");
    } finally {
      if (request === requestVersion.current) setLoading(false);
    }
  }
  return (
    <div
      className="mc-app"
      onKeyDown={(event) => {
        if (event.key === "Escape" && mobile) {
          event.preventDefault();
          closeNavigation();
        }
      }}
    >
      <aside className={`mc-sidebar ${mobile ? "open" : ""}`}>
        <a className="mc-brand" href="/app">
          <span>
            <Code2 />
          </span>
          MaintainCode Ads
        </a>
        <div className="mc-workspace-select">
          <Building2 />
          <select
            aria-label="Workspace"
            value={
              w.mode === "sample"
                ? "sample"
                : workspaceAccessLoaded
                  ? w.id
                  : ""
            }
            onChange={(e) => {
              if (e.target.value === "new") {
                requestVersion.current++;
                setLoading(false);
                setCreating(true);
                return;
              }
              if (e.target.value === "sample") {
                showSample();
              } else void selectWorkspace(e.target.value);
            }}
          >
            <option value="sample">Acme Studio · sample</option>
            {w.mode !== "sample" && (!w.id || !workspaceAccessLoaded) && (
              <option value="">
                {loading
                  ? "Loading workspace…"
                  : !local && !signedIn
                    ? "Sign in to continue"
                    : error
                      ? "Workspace unavailable"
                      : "Choose a workspace"}
              </option>
            )}
            {workspaceListLoaded &&
              workspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>
                  {ws.name}
                </option>
              ))}
            {w.mode !== "sample" && workspaceAccessLoaded && (
              <option value="new">+ New client workspace</option>
            )}
          </select>
        </div>
        <nav id="mc-main-navigation" aria-label="Main navigation">
          {nav.map((n) => (
            <button
              key={n.name}
              className={view === n.name ? "selected" : ""}
              onClick={() => navigate(n.name)}
            >
              <n.icon />
              {n.name}
            </button>
          ))}
        </nav>
        <button className="mc-mobile-menu" onClick={closeNavigation}>
          <X /> Close navigation
        </button>
        <div className="mc-sidebar-bottom">
          <div>
            <Users />
            {w.mode === "sample"
              ? "Sample workspace"
              : hasWorkspaceAccess
                ? `${role} access`
                : loading
                  ? "Checking workspace access…"
                  : !local && !signedIn
                    ? "Signed out"
                    : workspaceAccessLoaded
                      ? "No workspace selected"
                      : "Workspace access unverified"}
          </div>
          <div>
            <Info />
            {w.mode === "sample"
              ? "Example data only"
              : !hasWorkspaceAccess
                ? "No workspace loaded"
                : w.mode === "local"
                  ? "Isolated local data"
                  : "Customer workspace"}
          </div>
          {signedIn ? (
            <CustomerSignOut />
          ) : (
            <a href="/auth/sign-in">
              Sign in <ArrowUpRight />
            </a>
          )}
        </div>
      </aside>
      <main className="mc-main">
        <header className="mc-topbar">
          <button
            className="mc-mobile-menu"
            ref={navigationToggle}
            aria-label="Toggle navigation"
            aria-expanded={mobile}
            aria-controls="mc-main-navigation"
            onClick={() => (mobile ? closeNavigation() : setMobile(true))}
          >
            {mobile ? <X /> : <Menu />}
          </button>
          <span>
            Workspace <span className="mc-slash">/</span>{" "}
            {lead ? "Lead detail" : view}
          </span>
          {w.mode === "sample" ? (
            <button className="mc-link" onClick={openLive}>
              View {local ? "local" : "live"} workspace <ArrowUpRight />
            </button>
          ) : (
            <button
              className="mc-link"
              onClick={() => {
                showSample();
              }}
            >
              Explore sample data <ArrowUpRight />
            </button>
          )}
        </header>
        {error && (
          <div className="mc-alert" role="alert">
            <span>{error}</span>
            <button onClick={openLive}>Retry workspace</button>
          </div>
        )}
        {notice && (
          <div className="mc-success-notice" role="status">
            {notice}
            <button
              aria-label="Dismiss notification"
              onClick={() => setNotice("")}
            >
              <X />
            </button>
          </div>
        )}
        {loading && (
          <div className="mc-loading" role="status">
            Loading workspace…
          </div>
        )}
        <div
          key={`${w.mode}:${w.id}`}
          aria-busy={loading}
          className={loading ? "mc-busy" : ""}
        >
          {creating && workspaceAccessLoaded ? (
            <NewWorkspace onCreate={create} />
          ) : !w.id && w.mode !== "sample" ? (
            <div className="mc-onboarding">
              <h1>Connect your workspace.</h1>
              <p>
                Sign in, then retry to load your data. An authentication or
                database error never substitutes sample results.
              </p>
              <a className="mc-button mc-primary" href="/auth/sign-in">
                Sign in
              </a>
            </div>
          ) : lead ? (
            <LeadDetail w={w} lead={lead} onBack={() => setLead(null)} />
          ) : view === "Overview" || view === "Campaigns" ? (
            <Reporting
              w={w}
              campaigns={view === "Campaigns"}
              onLead={setLead}
              onView={navigate}
            />
          ) : view === "Leads" ? (
            <Leads w={w} onLead={setLead} />
          ) : view === "Setup" ? (
            <Setup w={w} act={safeAct} onView={navigate} />
          ) : view === "Websites & forms" ? (
            <Websites w={w} act={act} />
          ) : view === "Integrations" ? (
            <Integrations w={w} act={act} />
          ) : view === "Tracking health" ? (
            <Health w={w} act={safeAct} onView={navigate} />
          ) : (
            <Settings w={w} act={safeAct} />
          )}
        </div>
      </main>
    </div>
  );
}
