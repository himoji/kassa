import { describe, expect, it } from "@jest/globals";
import type { SchoolInvoiceDto } from "@kassa/shared";
import { render, screen } from "@testing-library/react-native";

import { ThemeProvider } from "@/components/ui";

import { isDateOfBirth, SchoolInvoiceCard } from "../find-school";

const INVOICE: SchoolInvoiceDto = {
  invoiceId: "INV-BUD-KZ26-0417",
  schoolId: "budapest",
  studentId: "KZ26-0417",
  term: "Fall 2026",
  amountMinor: 240_000,
  paidMinor: 40_000,
  currency: "EUR",
  dueDate: "2026-10-31",
  reference: "RF39RUB2026F04217",
  status: "PARTLY_PAID",
};

describe("SchoolInvoiceCard", () => {
  it("shows what is still due, the status and the reference to pay with", async () => {
    await render(
      <ThemeProvider>
        <SchoolInvoiceCard invoice={INVOICE} />
      </ThemeProvider>
    );
    expect(screen.getByText("Fall 2026 tuition, student KZ26-0417")).toBeTruthy();
    expect(screen.getByText(/2,000\.00/)).toBeTruthy();
    expect(screen.getByText(/Partly paid/)).toBeTruthy();
    expect(screen.getByText("Reference RF39RUB2026F04217")).toBeTruthy();
  });
});

describe("isDateOfBirth", () => {
  it("takes a real YYYY-MM-DD date only", () => {
    expect(isDateOfBirth("2005-03-14")).toBe(true);
    expect(isDateOfBirth("2004-02-29")).toBe(true);
    expect(isDateOfBirth("2005-02-29")).toBe(false);
    expect(isDateOfBirth("14.03.2005")).toBe(false);
    expect(isDateOfBirth("2005-3-14")).toBe(false);
    expect(isDateOfBirth("")).toBe(false);
  });
});
