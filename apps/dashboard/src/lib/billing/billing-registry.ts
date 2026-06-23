import type { BillingProvider } from "@/lib/billing/types";
import { NoopBillingProvider } from "@/lib/billing/noop-provider";
import { PolarBillingProvider } from "@/lib/billing/polar-provider";

/**
 * Select the billing provider. The ONLY module that imports the concrete
 * adapters, so pure/unit-test code never pulls in the SDK. The caller (a cron /
 * route entry point) reads `billingEnabled(env)` and passes the boolean in — the
 * registry never reads env itself (mirrors resolveExecutor(name)).
 */
export function resolveBillingProvider(enabled: boolean): BillingProvider {
  return enabled ? new PolarBillingProvider() : new NoopBillingProvider();
}
