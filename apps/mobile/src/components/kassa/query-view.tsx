import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { Box, ErrorState, Skeleton } from "@/components/ui";
import { useKassaT } from "@/lib/i18n";

import { errorText } from "./error-text";

interface QueryViewProps<T> {
  query: Pick<UseQueryResult<T>, "data" | "error" | "isPending" | "refetch">;
  /** Skeleton rows while the first load runs (never the empty state). */
  skeletonRows?: number;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}

/** The four data states (loading, error, empty, content) for one query. */
export function QueryView<T>({
  query,
  skeletonRows = 3,
  isEmpty,
  empty,
  children,
}: QueryViewProps<T>) {
  const t = useKassaT();
  if (query.isPending) {
    return (
      <Box gap={3} style={{ paddingVertical: 4 }}>
        {Array.from({ length: skeletonRows }, (_, i) => (
          <Skeleton key={i} h={44} radius="md" />
        ))}
      </Box>
    );
  }
  if (query.error || query.data === undefined) {
    return (
      <ErrorState
        title={t("common:errors.loadTitle")}
        description={errorText(t, query.error)}
        retry={() => void query.refetch()}
      />
    );
  }
  if (isEmpty?.(query.data)) return <>{empty}</>;
  return <>{children(query.data)}</>;
}
