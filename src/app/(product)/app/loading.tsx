import { MaintainFlowBrand } from "@/components/maintainflow/brand";

export default function AppLoading() {
  return (
    <main className="min-h-screen bg-[#FAFAFA]" aria-busy="true">
      <header className="border-b bg-background">
        <div className="flex min-h-16 items-center px-4 md:px-6">
          <MaintainFlowBrand />
        </div>
      </header>
      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 md:px-6 lg:grid-cols-[20rem_1fr] lg:py-8">
        <div className="grid content-start gap-3 rounded-xl border bg-background p-4 shadow-sm">
          <div className="h-4 w-24 animate-pulse rounded bg-muted" />
          <div className="h-20 animate-pulse rounded-lg bg-muted" />
          <div className="h-20 animate-pulse rounded-lg bg-muted" />
          <div className="h-20 animate-pulse rounded-lg bg-muted" />
        </div>
        <div className="grid content-start gap-5">
          <div className="h-8 w-64 max-w-full animate-pulse rounded bg-muted" />
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="h-28 animate-pulse rounded-xl border bg-background" />
            <div className="h-28 animate-pulse rounded-xl border bg-background" />
            <div className="h-28 animate-pulse rounded-xl border bg-background" />
          </div>
          <div className="h-64 animate-pulse rounded-xl border bg-background" />
        </div>
      </div>
      <p className="sr-only">Loading the MaintainFlow workspace.</p>
    </main>
  );
}
