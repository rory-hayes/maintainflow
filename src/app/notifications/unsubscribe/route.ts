import { z } from "zod";
import { sameOrigin } from "@/lib/attribution/store.server";
import { unsubscribeNotifications } from "@/lib/attribution/notifications.server";
const input = z.object({
  workspace: z.string().uuid(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});
const headers = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "strict-origin",
  "X-Robots-Tag": "noindex",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};
function page(body: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email preferences | MaintainCode Ads</title><body style="max-width:36rem;margin:4rem auto;padding:1rem;font:18px/1.6 system-ui"><h1>MaintainCode Ads email preferences</h1>${body}</body></html>`,
    { status, headers },
  );
}
// Link scanners may open this page. Only the explicit same-origin POST opts out.
export async function GET(request: Request) {
  const result = input.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!result.success)
    return page(
      "<p>This link is invalid. Open Workspace &amp; billing in the app to manage email preferences.</p>",
      400,
    );
  return page(
    `<p>Stop tracking-health and weekly-summary emails for this workspace? Other workspaces and account security emails are unchanged.</p><form method="post" action="/notifications/unsubscribe"><input type="hidden" name="workspace" value="${result.data.workspace}"><input type="hidden" name="token" value="${result.data.token}"><button type="submit">Stop workspace emails</button></form><p><a href="/app?view=Workspace%20%26%20billing">Manage preferences in the app</a></p>`,
  );
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const body = await request.text();
    if (body.length > 1000) return page("<p>This request is invalid.</p>", 400);
    const values = input.parse(Object.fromEntries(new URLSearchParams(body)));
    await unsubscribeNotifications(values.workspace, values.token);
    return page(
      '<p>This opt-out request is complete. If the link matched an active subscription, future workspace emails are now off. A message already accepted by the email provider may still arrive.</p><p><a href="/app?view=Workspace%20%26%20billing">Open email preferences</a></p>',
    );
  } catch {
    return page(
      "<p>Unable to update these preferences. Open Workspace &amp; billing in the app to turn emails off.</p>",
      400,
    );
  }
}
