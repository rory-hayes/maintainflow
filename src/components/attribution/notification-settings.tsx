"use client";
import { useEffect, useState } from "react";
import type { NotificationStatus } from "@/lib/attribution/notifications";
export function NotificationSettings({
  workspaceId,
  mode,
}: {
  workspaceId: string;
  mode: string;
}) {
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const endpoint = `/api/attribution/workspaces/${workspaceId}/notifications`;
  useEffect(() => {
    if (mode !== "live") return;
    const controller = new AbortController();
    fetch(endpoint, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error || "Email preferences are unavailable.");
        setStatus(data);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [endpoint, mode]);
  async function save(resume = false) {
    if (!status) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          health: status.health,
          weekly: status.weekly,
          resume,
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Email preferences could not be saved.");
      setStatus(data);
      setSaved(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Please retry.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mc-panel mc-form" aria-labelledby="email-reports-title">
      <h2 id="email-reports-title">Email reports</h2>
      <p>
        Choose tracking-health changes and a weekly aggregate summary. Both
        start off. Emails go only to your verified account address.
      </p>
      {mode !== "live" ? (
        <p className="mc-muted">
          Email reports are available in a live workspace with a verified
          customer account.
        </p>
      ) : (
        <>
          {!status && !error && (
            <p role="status">Loading your email preferences…</p>
          )}
          {status && (
            <>
              <p>
                Recipient: <strong>{status.recipient}</strong>
              </p>
              {!status.available && (
                <p role="status">
                  Email delivery is not configured yet. You can turn existing
                  preferences off.
                </p>
              )}
              {!status.canEnable && (
                <p className="mc-muted">
                  Owner or admin access is required to enable reports.
                </p>
              )}
              <label className="mc-checkbox">
                <input
                  type="checkbox"
                  checked={status.health}
                  disabled={
                    busy ||
                    ((!status.available || !status.canEnable) && !status.health)
                  }
                  onChange={(e) => {
                    setStatus({ ...status, health: e.target.checked });
                    setSaved(false);
                  }}
                />{" "}
                Tracking-health changes
              </label>
              <p className="mc-muted">
                Receive actionable changes after scheduled checks. Unchanged
                issues do not generate repeat emails.
              </p>
              <label className="mc-checkbox">
                <input
                  type="checkbox"
                  checked={status.weekly}
                  disabled={
                    busy ||
                    ((!status.available || !status.canEnable) && !status.weekly)
                  }
                  onChange={(e) => {
                    setStatus({ ...status, weekly: e.target.checked });
                    setSaved(false);
                  }}
                />{" "}
                Weekly workspace summary
              </label>
              <p className="mc-muted">
                The first summary becomes due seven days after enabling.
                Scheduled processing may delay reports; this is not real-time
                monitoring.
              </p>
              {status.acceptedAt && (
                <p className="mc-muted">
                  Last provider acceptance:{" "}
                  {new Date(status.acceptedAt).toLocaleString()}. Inbox delivery
                  is not verified.
                </p>
              )}
              {status.status === "retrying" && (
                <p role="status">
                  An email is awaiting a safe retry during scheduled processing.
                </p>
              )}
              {status.status === "needs_review" && (
                <p role="status">
                  A previous send could not be confirmed. Automatic retries
                  stopped to avoid duplicates. Resume future reports to skip
                  that message and start a new weekly period.
                </p>
              )}
              <button disabled={busy} onClick={() => void save()}>
                {busy ? "Saving…" : "Save email preferences"}
              </button>
              {status.status === "needs_review" && status.available && (
                <button disabled={busy} onClick={() => void save(true)}>
                  Resume future reports
                </button>
              )}
              <p className="mc-muted">
                Turn both options off to stop future sends. A message already
                accepted by the provider may still arrive.
              </p>
            </>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="mc-error">
          {error}
        </p>
      )}
      {saved && <p role="status">Email preferences saved.</p>}
    </section>
  );
}
