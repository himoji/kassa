import { describe, expect, it } from "@jest/globals";

import { detailsToForm, EMPTY_DETAILS, formToDetails } from "../recipient-fields";
import { firstDueDate } from "../recipient-sheets";

describe("recipient details form", () => {
  it("tuition needs a student ID and an https portal link", () => {
    expect(formToDetails("TUITION", EMPTY_DETAILS)).toEqual({
      ok: false,
      field: "studentId",
      code: "DETAILS_MISSING",
    });
    expect(
      formToDetails("TUITION", { ...EMPTY_DETAILS, studentId: "S1", portalUrl: "http://x.test" })
    ).toEqual({
      ok: false,
      field: "portalUrl",
      code: "URL_INVALID",
    });
    expect(
      formToDetails("TUITION", { ...EMPTY_DETAILS, studentId: " S1 ", term: "Fall 2026" })
    ).toEqual({
      ok: true,
      details: { category: "TUITION", studentId: "S1", term: "Fall 2026" },
    });
  });

  it("bills need a customer number; people take an optional 3-digit KNP code", () => {
    expect(formToDetails("BILLS", EMPTY_DETAILS)).toMatchObject({
      ok: false,
      field: "customerNumber",
    });
    expect(formToDetails("PEOPLE", { ...EMPTY_DETAILS, purposeCode: "31" })).toMatchObject({
      ok: false,
      code: "KNP_INVALID",
    });
    expect(
      formToDetails("PEOPLE", { ...EMPTY_DETAILS, relationship: "EMPLOYEE", purposeCode: "311" })
    ).toEqual({
      ok: true,
      details: { category: "PEOPLE", relationship: "EMPLOYEE", purposeCode: "311" },
    });
  });

  it("round-trips saved details into the form", () => {
    const rent = { category: "RENT", reference: "APT 4B", dueDay: 5 } as const;
    const back = formToDetails("RENT", detailsToForm(rent));
    expect(back).toEqual({ ok: true, details: rent });
  });

  it("the first due date is the next due day, or a week from today", () => {
    const today = new Date(2026, 9, 15);
    expect(firstDueDate(today, 20)).toBe("2026-10-20");
    expect(firstDueDate(today, 1)).toBe("2026-11-01");
    expect(firstDueDate(today, undefined)).toBe("2026-10-22");
  });
});
