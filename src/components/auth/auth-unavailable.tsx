export function AuthUnavailable() {
  return (
    <main className="grid min-h-[65vh] place-items-center px-5">
      <section className="max-w-md rounded-2xl border bg-white p-8">
        <h1 className="text-2xl font-semibold">
          Account access is being prepared.
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Please try again later. You can explore the labelled sample workspace
          while customer access is unavailable.
        </p>
        <a href="/app" className="mt-5 inline-block underline">
          Explore sample data
        </a>
      </section>
    </main>
  );
}
