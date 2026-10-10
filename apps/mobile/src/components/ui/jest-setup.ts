// The adapter imports `@/global.css` (the Tailwind entry point) so Metro
// compiles it; jest has no CSS transform, so the import is stubbed here.
import { jest } from "@jest/globals";

jest.mock("@/global.css", () => ({}));
