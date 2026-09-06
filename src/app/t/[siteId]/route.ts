import { z } from "zod";
import { readWorkspace, siteOwner } from "@/lib/attribution/store.server";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  try {
    const { siteId } = await params;
    z.string().uuid().parse(siteId);
    const owner = await siteOwner(siteId);
    const state = await readWorkspace(owner.organizationId);
    const site = state.sites.find((s) => s.id === siteId);
    if (!site || site.paused)
      return new Response("/* Tracking paused. */", {
        headers: {
          "Content-Type": "application/javascript",
          "Cross-Origin-Resource-Policy": "cross-origin",
        },
      });
    const endpoint = new URL(request.url).origin;
    const config = {
      siteId,
      endpoint,
      origin: site.origin,
      consent: site.consent,
      retentionDays: site.retentionDays,
      adapter: site.adapter,
      formSelector: site.formSelector,
      mapping: site.mapping,
      test: new URL(request.url).searchParams.get("test") === "1",
    };
    const body = `window.MaintainCodeConfig=${JSON.stringify(config).replace(/</g, "\\u003c")};(function(){var s=document.createElement('script');s.src=${JSON.stringify(endpoint + "/mc-tracker.js")};s.async=true;document.head.appendChild(s)})();`;
    return new Response(body, {
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch {
    return new Response(
      "/* Tracking unavailable; normal form submission is unaffected. */",
      {
        status: 503,
        headers: {
          "Content-Type": "application/javascript",
          "Cross-Origin-Resource-Policy": "cross-origin",
        },
      },
    );
  }
}
