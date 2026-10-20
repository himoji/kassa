import { describe, expect, it } from "vitest";

import { multipartBody } from "../src/multipart.ts";

describe("multipartBody (native import upload)", () => {
  it("writes fields and files as RFC 7578 parts, the file name as UTF-8 and the bytes untouched", () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff]);
    const body = multipartBody(
      [
        { name: "ai", value: "auto" },
        { name: "file", filename: 'Выписка "1".pdf', type: "application/pdf", bytes },
      ],
      "B"
    );
    const text = Buffer.from(body).toString("utf8");
    expect(
      text.startsWith('--B\r\ncontent-disposition: form-data; name="ai"\r\n\r\nauto\r\n--B\r\n')
    ).toBe(true);
    expect(text).toContain(
      'content-disposition: form-data; name="file"; filename="Выписка _1_.pdf"\r\ncontent-type: application/pdf\r\n\r\n'
    );
    expect(text.endsWith("\r\n--B--\r\n")).toBe(true);
    const at = Buffer.from(body).indexOf(Buffer.from([0x25, 0x50, 0x44, 0x46]));
    expect([...body.slice(at, at + bytes.length)]).toEqual([...bytes]);
  });
});
