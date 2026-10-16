import { describe, expect, it } from "@jest/globals";
import { KycStartRequest, type KycCheckDto } from "@kassa/shared";
import { render, screen } from "@testing-library/react-native";

import { ThemeProvider } from "@/components/ui";

import { KycLatestCheck, sampleDocument } from "../identity-check-screen";

const CHECK: KycCheckDto = {
  id: "8b0f2a8e-2f7d-4f0c-9a51-0d6f3c1e2b77",
  outcome: "REJECTED",
  reasonCodes: ["DOCUMENT_EXPIRED", "NAME_MISMATCH"],
  documentType: "PASSPORT",
  documentCountry: "KZ",
  documentLast4: "4567",
  createdAt: "2026-10-16T10:00:00.000Z",
  checkedAt: "2026-10-16T10:00:00.000Z",
  simulated: true,
};

describe("identity check screen", () => {
  it("the sample document is a valid request in the account's name, valid and for an adult", () => {
    const doc = sampleDocument("Test Person", new Date("2026-10-16T00:00:00Z"));
    const req = KycStartRequest.parse({ document: doc, liveness: { result: "PASS" } });
    expect(req.document.fullName).toBe("Test Person");
    expect(req.document.expiresOn > "2026-10-16").toBe(true);
    expect(Number(req.document.dateOfBirth.slice(0, 4))).toBeLessThanOrEqual(2026 - 18);
  });

  it("shows the last check with the document summary and each reason in plain language", async () => {
    await render(
      <ThemeProvider>
        <KycLatestCheck check={CHECK} />
      </ThemeProvider>
    );
    expect(screen.getByText("Passport, KZ, number ending 4567")).toBeTruthy();
    expect(screen.getByText("The document has expired.")).toBeTruthy();
    expect(screen.getByText("The name does not match the name on your account.")).toBeTruthy();
  });
});
