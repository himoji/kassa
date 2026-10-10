import type { ErrorBoundaryProps } from "expo-router";
import { Component } from "react";

import { crash } from "@/lib/crash";
import { i18n } from "@/lib/i18n";
import { ErrorState, Screen, ThemeProvider } from "@/components/ui";

/**
 * Route-level error UI (docs: https://docs.expo.dev/router/error-handling/).
 *
 * Expo Router renders a route's `ErrorBoundary` export in place of the route when
 * it throws during render, passing `{ error, retry }`; `retry` re-mounts the route.
 * Exported from `src/app/_layout.tsx` so it also covers the root layout - at that
 * point `Providers` is gone, hence the local `ThemeProvider`. Each new error is
 * reported once through `@/lib/crash` (no-op shim unless a crash module is selected) and
 * logged. Users see a generic message: `error.message` can carry internals (URLs, SQL,
 * ids), so it is only shown in development builds.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps> {
  componentDidMount() {
    this.report();
  }

  componentDidUpdate(prev: ErrorBoundaryProps) {
    if (prev.error !== this.props.error) this.report();
  }

  private report() {
    console.error("[error-boundary]", this.props.error);
    crash.capture(this.props.error, { where: "route-error-boundary" });
  }

  private retry = () => {
    this.props.retry().catch((err: unknown) => {
      console.warn("[error-boundary] retry failed", err);
    });
  };

  render() {
    const { error } = this.props;
    return (
      <ThemeProvider>
        <Screen>
          <ErrorState
            title={i18n.t("Something went wrong")}
            description={
              __DEV__
                ? error.message || String(error)
                : i18n.t("Please try again. If it keeps happening, restart the app.")
            }
            retry={this.retry}
          />
        </Screen>
      </ThemeProvider>
    );
  }
}
