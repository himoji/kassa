/**
 * One translated, plain-language message per failure kind. Server refusals carry ReasonCodes and
 * are explained per code (reasonCodes namespace); transport failures get generic texts.
 */
import { ReasonCode } from "@kassa/shared";

import { ContractError, KassaApiError, NetworkError } from "@/api/errors";
import { OrderIntegrityError } from "@/api/hooks/orders";
import type { TFn } from "@/lib/i18n";
import {
  PasskeyBiometricsError,
  PasskeyCancelledError,
  PasskeyDomainError,
  PasskeyUnsupportedError,
} from "@/lib/passkey-errors";

export function errorText(t: TFn, err: unknown): string {
  if (err instanceof PasskeyCancelledError) return t("common:errors.passkeyCancelled");
  if (err instanceof PasskeyUnsupportedError) return t("common:errors.passkeyUnsupported");
  if (err instanceof PasskeyDomainError) return t("common:errors.passkeyDomain");
  if (err instanceof PasskeyBiometricsError) return t("common:errors.passkeyBiometrics");
  if (err instanceof OrderIntegrityError) return t("order:integrityError");
  if (err instanceof NetworkError) return t("common:errors.network");
  if (err instanceof ContractError) return t("common:errors.contract");
  if (err instanceof KassaApiError) {
    const [code] = err.allReasonCodes;
    if (code) return t(`reasonCodes:${code}.text`);
    if (err.status === 401) return t("common:errors.signedOut");
    if (err.status === 404) return t("common:errors.notFound");
    if (err.status === 409) return t("common:errors.conflict");
    if (err.status >= 500) return t("common:errors.server");
    return t("common:errors.request");
  }
  return t("common:errors.unknown");
}

/** Reason codes on an error, if any (for a ReasonCodeList). */
export function errorReasonCodes(err: unknown): ReasonCode[] {
  return err instanceof KassaApiError ? err.allReasonCodes : [];
}
