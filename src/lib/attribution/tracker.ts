import {
  advanceEvidence,
  attributionFields,
  captureTouch,
  evidenceSchema,
  type Evidence,
  type FormMapping,
} from "./model";

type Config = {
  siteId: string;
  endpoint: string;
  consent: "required" | "not_required";
  retentionDays: number;
  formSelector: string;
  adapter: "html" | "hubspot_v4";
  mapping: FormMapping;
  test?: boolean;
  origin: string;
};
type HSForm = {
  getFormId: () => string;
  getInstanceId: () => string;
  setFieldValue: (name: string, value: string[]) => void;
  getFieldValue: (name: string) => Promise<string | string[]>;
};
declare global {
  interface Window {
    MaintainCode?: ReturnType<typeof installTracker>;
    MaintainCodeConfig?: Config;
    HubSpotFormsV4?: {
      getFormFromEvent: (e: Event) => HSForm;
      getForms: () => HSForm[];
    };
  }
}
export function installTracker(config: Config) {
  const key = `mc_attribution:${config.siteId}`;
  const deliveryKey = `mc_delivery:${config.siteId}`;
  let allowed = config.consent === "not_required";
  let consentEpoch = 0;
  let evidence: Evidence | null = null;
  let ids = new WeakMap<HTMLFormElement, string>();
  const hsIds = new Map<string, string>();
  const filled = new Map<HTMLInputElement, string>();
  const hubFilled = new Map<string, Map<string, string>>();
  const hubPending = new Set<string>();
  type Delivery = {
    id: string;
    formId: string;
    status: "attempted" | "confirmed";
    evidence: Evidence;
    test: boolean;
    at: string;
    siteId: string;
    attempts: number;
    nextAttempt: number;
  };
  let queue: Delivery[] = [];
  const deliveries = new Map<string, Delivery>();
  let activeRequest: AbortController | undefined;
  const guard = (fn: () => void) => {
    try {
      fn();
    } catch {
      /* Attribution must never interrupt the business form. */
    }
  };
  const save = () =>
    guard(() => {
      if (allowed && evidence)
        localStorage.setItem(key, JSON.stringify(evidence));
    });
  const saveQueue = () =>
    guard(() => {
      if (allowed && queue.length)
        localStorage.setItem(deliveryKey, JSON.stringify(queue));
      else localStorage.removeItem(deliveryKey);
    });
  function restoreQueue() {
    guard(() => {
      if (!allowed) return;
      const pending: unknown = JSON.parse(
        localStorage.getItem(deliveryKey) ?? "[]",
      );
      if (!Array.isArray(pending)) return;
      queue = pending
        .filter((item): item is Delivery => {
          if (!item || typeof item !== "object") return false;
          return (
            item.siteId === config.siteId &&
            typeof item.id === "string" &&
            /^[\da-f-]{36}$/i.test(item.id) &&
            typeof item.formId === "string" &&
            item.formId.length <= 200 &&
            typeof item.test === "boolean" &&
            ["attempted", "confirmed"].includes(item.status) &&
            typeof item.at === "string" &&
            Date.parse(item.at) <= Date.now() &&
            Date.parse(item.at) > Date.now() - 86400000 &&
            evidenceSchema.safeParse(item.evidence).success &&
            Date.parse(item.evidence.expiresAt) > Date.now()
          );
        })
        .slice(-20)
        .map(
          ({
            id,
            formId,
            siteId,
            status,
            evidence,
            test,
            at,
            attempts,
            nextAttempt,
          }) => ({
            id,
            formId,
            siteId,
            status,
            evidence,
            test,
            at,
            attempts:
              Number.isInteger(attempts) && attempts >= 0 ? attempts : 0,
            nextAttempt: Number.isFinite(nextAttempt)
              ? Math.min(nextAttempt, Date.now() + 3600000)
              : 0,
          }),
        );
      queue.forEach((item) => deliveries.set(item.id, item));
      saveQueue();
      void flush();
    });
  }
  function capture() {
    guard(() => {
      if (!allowed) return;
      let previous: Evidence | null = null;
      try {
        previous = evidenceSchema.parse(
          JSON.parse(localStorage.getItem(key) ?? "null"),
        );
      } catch {
        /* Unavailable storage remains memory only. */
      }
      evidence = advanceEvidence(
        previous ?? evidence,
        captureTouch(location.href, document.referrer),
        config.retentionDays,
      );
      save();
    });
  }
  function values(id: string) {
    return evidence ? attributionFields(evidence, id) : null;
  }
  function fill(form: HTMLFormElement) {
    guard(() => {
      if (
        !allowed ||
        !evidence ||
        !form.matches(config.formSelector) ||
        new URL(form.action || location.href, location.href).origin !==
          location.origin
      )
        return;
      let id = ids.get(form);
      if (!id) {
        id = crypto.randomUUID();
        ids.set(form, id);
      }
      const fields = values(id)!;
      for (const [logical, name] of Object.entries(config.mapping)) {
        if (!(logical in fields)) continue;
        let field = Array.from(form.elements).find(
          (el) => el instanceof HTMLInputElement && el.name === name,
        ) as HTMLInputElement | undefined;
        if (field && field.type !== "hidden") continue;
        if (!field) {
          field = document.createElement("input");
          field.type = "hidden";
          field.name = name;
          form.appendChild(field);
        }
        // Preserve non-empty customer fields unless this tracker owns their value.
        if (
          logical !== "submission_id" &&
          field.value &&
          field.value !== filled.get(field)
        )
          continue;
        field.value = fields[logical as keyof typeof fields];
        filled.set(field, field.value);
      }
    });
  }
  async function fillHub(form: HSForm) {
    let instance = "";
    let started = false;
    const epoch = consentEpoch;
    try {
      if (!allowed || !evidence || config.adapter !== "hubspot_v4") return;
      instance = form.getInstanceId();
      if (hubPending.has(instance)) return;
      hubPending.add(instance);
      started = true;
      const id = hsIds.get(instance) ?? crypto.randomUUID();
      hsIds.set(instance, id);
      const fields = values(id)!;
      const owned = hubFilled.get(instance) ?? new Map<string, string>();
      hubFilled.set(instance, owned);
      for (const [logical, name] of Object.entries(config.mapping)) {
        if (!(logical in fields)) continue;
        const fieldName = `0-1/${name}`;
        const current = await form.getFieldValue(fieldName);
        if (!allowed || epoch !== consentEpoch) return;
        const value = Array.isArray(current) ? current.join("") : current;
        if (logical !== "submission_id" && value && value !== owned.get(name))
          continue;
        const next = fields[logical as keyof typeof fields];
        form.setFieldValue(fieldName, [next]);
        owned.set(name, next);
      }
    } catch {
      // A missing mapped property never interrupts the customer's form.
    } finally {
      if (started) {
        hubPending.delete(instance);
        if (allowed && epoch !== consentEpoch) void fillHub(form);
      }
    }
  }
  function scan() {
    guard(() => {
      if (config.adapter === "html")
        document
          .querySelectorAll<HTMLFormElement>(config.formSelector)
          .forEach(fill);
      else window.HubSpotFormsV4?.getForms().forEach(fillHub);
    });
  }
  let sending = false;
  async function flush() {
    if (sending || !allowed || !queue.length) return;
    sending = true;
    try {
      queue = queue.filter(
        (item) =>
          item.attempts < 28 &&
          Date.parse(item.at) > Date.now() - 86400000 &&
          Date.parse(item.evidence.expiresAt) > Date.now(),
      );
      saveQueue();
      for (let i = 0; i < 3 && queue.length && allowed; i++) {
        const item = queue.find((pending) => pending.nextAttempt <= Date.now());
        if (!item) break;
        item.attempts++;
        item.nextAttempt =
          Date.now() + Math.min(15000 * 2 ** (item.attempts - 1), 3600000);
        saveQueue();
        const controller = new AbortController();
        activeRequest = controller;
        const timeout = setTimeout(() => controller.abort(), 5000);
        let response: Response | undefined;
        try {
          response = await fetch(`${config.endpoint}/api/attribution/collect`, {
            method: "POST",
            body: JSON.stringify({
              id: item.id,
              formId: item.formId,
              siteId: item.siteId,
              status: item.status,
              evidence: item.evidence,
              test: item.test,
              at: item.at,
            }),
            headers: { "Content-Type": "application/json" },
            credentials: "omit",
            keepalive: true,
            signal: controller.signal,
          });
        } catch {
          // The next eligible item can still be delivered during a provider outage.
        } finally {
          clearTimeout(timeout);
          if (activeRequest === controller) activeRequest = undefined;
        }
        const terminal =
          response &&
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408 &&
          response.status !== 429;
        if (!response?.ok && !terminal) continue;
        item.nextAttempt = 0;
        // An in-flight attempt may have been replaced by a confirmation. Do not
        // remove that newer delivery when the older request completes.
        queue = queue.filter((pending) => pending !== item);
        saveQueue();
      }
    } catch {
      /* Bounded retry via online event or timer, with stable IDs. */
    } finally {
      sending = false;
    }
  }
  function send(id: string, formId: string, status: "attempted" | "confirmed") {
    if (!allowed || !evidence) return;
    const previous = deliveries.get(id);
    if (
      previous &&
      (previous.status === "confirmed" || status === "attempted")
    ) {
      // Only attempted -> confirmed creates a new delivery version. Repeated
      // callbacks must not replace an equivalent in-flight record and keep an
      // already acknowledged submission queued behind its retry backoff.
      void flush();
      return;
    }
    const item: Delivery = previous
      ? {
          ...previous,
          status: previous.status === "confirmed" ? "confirmed" : status,
          nextAttempt:
            status === "confirmed" && previous.status === "attempted"
              ? 0
              : previous.nextAttempt,
        }
      : {
          id,
          formId,
          siteId: config.siteId,
          status,
          evidence: structuredClone(evidence),
          test: config.test === true,
          at: new Date().toISOString(),
          attempts: 0,
          nextAttempt: 0,
        };
    deliveries.set(id, item);
    queue = queue.filter((x) => x.id !== id);
    queue.push(item);
    queue = queue.slice(-20);
    saveQueue();
    void flush();
  }
  const onSubmit = (e: Event) =>
    guard(() => {
      if (config.adapter !== "html" || !(e.target instanceof HTMLFormElement))
        return;
      fill(e.target);
      const id = ids.get(e.target);
      if (id) send(id, e.target.id || config.formSelector, "attempted");
    });
  const onReady = (e: Event) =>
    guard(() => {
      const form = window.HubSpotFormsV4?.getFormFromEvent(e);
      if (form) void fillHub(form);
    });
  const onSuccess = (e: Event) =>
    guard(() => {
      const form = window.HubSpotFormsV4?.getFormFromEvent(e);
      if (!form) return;
      const id = hsIds.get(form.getInstanceId());
      if (id) send(id, form.getFormId(), "confirmed");
    });
  const onOnline = () => {
    queue.forEach((item) => {
      item.nextAttempt = 0;
    });
    void flush();
  };
  if (location.origin !== config.origin)
    return {
      setConsent: () => {},
      confirm: () => {},
      refresh: () => {},
      newSubmission: () => {},
      destroy: () => {},
    };
  capture();
  scan();
  restoreQueue();
  const observer = new MutationObserver(scan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  document.addEventListener("submit", onSubmit, true);
  window.addEventListener("hs-form-event:on-ready", onReady);
  window.addEventListener("hs-form-event:on-submission:success", onSuccess);
  window.addEventListener("online", onOnline);
  const timer = setInterval(() => void flush(), 15000);
  return {
    setConsent(granted: boolean) {
      if (granted !== allowed) consentEpoch++;
      allowed = granted;
      if (granted) {
        capture();
        scan();
        if (!queue.length) restoreQueue();
      } else {
        evidence = null;
        queue = [];
        deliveries.clear();
        ids = new WeakMap<HTMLFormElement, string>();
        hsIds.clear();
        activeRequest?.abort();
        guard(() => localStorage.removeItem(key));
        saveQueue();
        filled.forEach((last, field) => {
          if (field.value === last) field.value = "";
        });
        const epoch = consentEpoch;
        guard(() =>
          window.HubSpotFormsV4?.getForms().forEach((form) => {
            const owned = hubFilled.get(form.getInstanceId());
            owned?.forEach((last, name) => {
              void form
                .getFieldValue(`0-1/${name}`)
                .then((current) => {
                  if (allowed || consentEpoch !== epoch) return;
                  const value = Array.isArray(current)
                    ? current.join("")
                    : current;
                  if (value === last) form.setFieldValue(`0-1/${name}`, []);
                })
                .catch(() => {});
            });
          }),
        );
      }
    },
    // Call only from the customer's documented successful-submit callback.
    confirm(form: HTMLFormElement) {
      guard(() => {
        const id = ids.get(form);
        if (id) send(id, form.id || config.formSelector, "confirmed");
      });
    },
    // Use after the successful form is reset for a genuinely new enquiry.
    // Retry and duplicate success callbacks should continue using confirm().
    newSubmission(form: HTMLFormElement) {
      guard(() => {
        ids.delete(form);
        fill(form);
      });
    },
    refresh() {
      capture();
      scan();
    },
    destroy() {
      allowed = false;
      activeRequest?.abort();
      observer.disconnect();
      clearInterval(timer);
      document.removeEventListener("submit", onSubmit, true);
      window.removeEventListener("hs-form-event:on-ready", onReady);
      window.removeEventListener(
        "hs-form-event:on-submission:success",
        onSuccess,
      );
      window.removeEventListener("online", onOnline);
    },
  };
}
if (typeof window !== "undefined" && window.MaintainCodeConfig) {
  try {
    window.MaintainCode = installTracker(window.MaintainCodeConfig);
  } catch {
    /* Fail open. */
  }
}
