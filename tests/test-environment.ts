// Each serial test file receives its own database counter namespace. App
// instances inside that file still share and enforce the same request limits.
process.env.FOLIO_RATE_LIMIT_NAMESPACE = `test-${process.pid}`;
