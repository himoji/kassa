/*
 * Synthetic bank statements for the import tests, in the layouts of three real statements (a Kaspi Gold PDF in Kazakh,
 * a Kazakh card bank's ruled table in Russian, a US bank's text lines in English). Every person, account and number
 * is fictitious. Real statements are run locally only and never committed (docs/spec/IMPORT_PLAN.md, Evaluation).
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { deflateRawSync } from "node:zlib";

export const HOLDER_KK = "Сейтқали Дана Нұрланқызы";
export const HOLDER_EN = "DANA SEITKALI";
export const IIN = "990101450123";
export const IBAN_KZ = "KZ86125KZT5004100100";
export const IBAN_KZ_USD = "KZ75125USD5004100101";
export const US_ACCOUNT = "4417 2290 1186";

/** Kaspi Gold "үзінді көшірме" as pdf.js extracts it: date, signed ₸ amount, operation, details; foreign amount below. */
export const KASPI_TEXT = `«Kaspi Bank» АҚ ${HOLDER_KK}, ЖСН ${IIN}, ${IBAN_KZ} шоты бар клиент екенін растайды:
15.10.25ж. бастап 15.10.26ж. дейінгі кезеңге Kaspi Gold бойынша
Карта нөмірі: *4821
Шот нөмірі: ${IBAN_KZ}
Шот валютасы: теңге
Күні Сомасы Операция Толығырақ
14.10.26 + 150 000,00 ₸ Толықтыру Нұрлан С.
12.10.26 - 9 500,00 ₸ Аударым Айгерім Т.
02.10.26 - 56,51 ₸ Зат сатып алу CINEMA CITY
Бағамдық айырма
30.09.26 - 5 519,45 ₸ Зат сатып алу CINEMA CITY
(- 4 000,00 HUF)
30.09.26 + 20 000,00 ₸ Толықтыру ДАНА С., Alatau City Bank
28.09.26 - 4 743,68 ₸ Зат сатып алу VERCEL DOMAINS
(- 10,59 USD)
14.09.26 + 150 000,00 ₸ Толықтыру Нұрлан С.
05.09.26 - 20 000,00 ₸ Өз шотыңызға Kaspi Депозит
-- 2 of 3 --
«Kaspi Bank» АҚ, БСК CASPKZKA, www.kaspi.kz
14.08.26 + 150 000,00 ₸ Толықтыру Нұрлан С.
10.08.26 - 3 990,00 ₸ Зат сатып алу SPAR MAGYARORSZAG
(- 2 890,00 HUF)
`;

const H = ["Дата\nсовершения\nоперации", "Дата\nзавершения\nоперации", "Операция", "Детали", "Сумма", "Валюта\nоперации", "Приход в\nвалюте счета", "Расход\nв\nвалюте\nсчета"];

/** A Kazakh card bank's ruled table, as pdf.js getTable returns it: header per page, a row split across a page break. */
export const ALATAU_TABLES: { page: number; rows: string[][] }[] = [
  {
    page: 1,
    rows: [
      H,
      ["15.10.2026\n08:09:10", "15.10.2026\n08:54:43", "Комиссия", "Оплата комиссии: Regular Charge", "200", "KZT", "0", "200"],
      ["13.10.2026\n17:44:44", "15.10.2026\n02:02:17", "Покупка", "BIJOU BRIGITTE\nКод авторизации: 870643", "1 590", "HUF", "0", "2\n288.88"],
      ["12.10.2026\n23:03:24", "14.10.2026\n02:28:25", "Покупка", "SPAR\nРеференс: 623954455922\nКод авторизации: 870641", "3 731", "HUF", "0", "5\n346.25"],
      ["11.10.2026\n10:00:00", "11.10.2026\n10:01:00", "Пополнение", "Пополнение по номеру телефона от Нұрлан С.", "50 000", "KZT", "50 000", "0"],
      ["09.10.2026", "11.10.2026", "Покупка", "LIDL HU 333 Budapest", "1 246", "HUF", "0", "1"],
    ],
  },
  {
    page: 2,
    rows: [
      H,
      ["20:33:44", "02:02:41", "", "Код авторизации: 870635", "", "", "", "793.36"],
      ["08.10.2026\n09:00:00", "08.10.2026\n09:10:00", "Покупка", "YANDEX.GO\nРеференс: 617951442089", "2 400", "KZT", "0", "2 400"],
      ["08.10.2026\n09:20:00", "08.10.2026\n09:25:00", "Пополнение", "YANDEX.GO\nРеференс: 617951442089", "2 400", "KZT", "2 400", "0"],
      ["01.10.2026\n13:17:20", "01.10.2026\n13:18:53", "Пополнение", `Перевод собственных средств на текущий счет\n${IBAN_KZ} по курсу 478.60 KZT за 1 USD`, "9 572", "KZT", "9 572", "0"],
      ["30.09.2026\n12:00:00", "30.09.2026\n12:01:00", "Перевод", "Перевод собственных средств на счет Kaspi", "20 000", "KZT", "0", "20 000"],
    ],
  },
];

export const ALATAU_TEXT = `АО "Alatau City Bank"
БИК: TSESKZKA
ФИО: ${HOLDER_KK.toUpperCase()}
ИИН: ${IIN}
Номер карточки: 441328******7710
Валюта счета:KZT
Номер счета:${IBAN_KZ}
Транзакции по счету: ${IBAN_KZ} KZT`;

/** A US bank statement as pdf.js extracts it: tab-separated lines, sections, fee rows wrapped over three lines. */
export const US_TEXT = `BANK OF EXAMPLE
P.O. Box 15284
DANA SEITKALI
1401 16TH ST NW
WASHINGTON, DC 20036-2201
Your Adv SafeBalance Banking
for April 14, 2026 to May 11, 2026
Account number: ${US_ACCOUNT}
Beginning balance on April 14, 2026 $251.23
Deposits and other additions 2,450.00
-- 1 of 3 --
${HOLDER_EN} \t! \tAccount # ${US_ACCOUNT} \t! \tApril 14, 2026 to May 11, 2026
Deposits and other additions
Date \tDescription \tAmount
04/14/26 \tZelle payment from NURLAN SEITKALI Conf# jb4knpz4y \t1,000.00
04/28/26 \tZelle payment from NURLAN SEITKALI Conf# aj0na2rts \t300.00
Total deposits and other additions \t$1,300.00
Withdrawals and other subtractions
ATM and debit card subtractions
Date \tDescription \tAmount
04/15/26 \tCHECKCARD 0413 SIMPLEP*e-admission Budapest \t74908366103667036779390 \t-176.10
04/16/26 \tMOBILE PURCHASE 0414 METRO WASHINGTON \tDC \t-2.25
04/20/26 \tCHECKCARD 0417 BKG*HOTEL AT BOOKING.C (888)850-3958 \t74143616108000151712152 \t-386.58
05/11/26 \tCHECKCARD 0509 PURDUE UNIV PAYPATH 913-5996699 KS 24013396130002151004914 \t-500.00
Total ATM and debit card subtractions \t-$1,064.93
Service fees
Date \tTransaction description \tAmount
04/15/26 \tCHECKCARD 0413 SIMPLEP*e-admission Budapest
74908366103667036779390 INTERNATIONAL TRANSACTION FEE
-5.28
04/20/26 \tCHECKCARD 0417 BKG*HOTEL AT BOOKING.C (888)850-3958
74143616108000151712152 INTERNATIONAL TRANSACTION FEE
-11.60
Total service fees \t-$16.88
`;

/** A one-page PDF with the given lines (Latin text only: the standard fonts are Windows-1252). */
export async function textPdf(lines: string[], table?: { x: number[]; rows: string[][] }): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  let y = 800;
  for (const l of lines) {
    page.drawText(l.replace(/\t/g, "    "), { x: 40, y, size: 9, font });
    y -= 14;
  }
  if (table) {
    // A ruled table: cell borders drawn as lines (what getTable detects).
    const rowH = 22;
    const top = y - 10;
    const xs = table.x;
    table.rows.forEach((row, r) => {
      const yy = top - r * rowH;
      row.forEach((cell, c) => page.drawText(cell, { x: xs[c]! + 3, y: yy - 15, size: 8, font }));
    });
    const bottom = top - table.rows.length * rowH;
    for (let r = 0; r <= table.rows.length; r++) page.drawLine({ start: { x: xs[0]!, y: top - r * rowH }, end: { x: xs.at(-1)!, y: top - r * rowH }, thickness: 0.8, color: rgb(0, 0, 0) });
    for (const x of xs) page.drawLine({ start: { x, y: top }, end: { x, y: bottom }, thickness: 0.8, color: rgb(0, 0, 0) });
  }
  return doc.save();
}

/** A minimal XLSX (ZIP of Office Open XML parts, stored with deflate) holding one sheet of rows. */
export function xlsx(rows: (string | number)[][]): Uint8Array {
  const shared: string[] = [];
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const col = (i: number) => String.fromCharCode(65 + i);
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
    .map(
      (r, ri) =>
        `<row r="${ri + 1}">${r
          .map((v, ci) => {
            const ref = `${col(ci)}${ri + 1}`;
            if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
            shared.push(v);
            return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
          })
          .join("")}</row>`,
    )
    .join("")}</sheetData></worksheet>`;
  const files: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Выписка" sheetId="1"/></sheets></workbook>`,
    "xl/sharedStrings.xml": `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join("")}</sst>`,
    "xl/worksheets/sheet1.xml": sheet,
  };
  return zip(files);
}

function crc32(b: Uint8Array): number {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function zip(files: Record<string, string>): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, "utf8");
    const data = deflateRawSync(raw);
    const nameB = Buffer.from(name, "utf8");
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameB.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameB.length, 28);
    cen.writeUInt32LE(offset, 42);
    parts.push(local, nameB, data);
    central.push(cen, nameB);
    offset += local.length + nameB.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, end]));
}

/** Windows-1251 bytes for a CSV from a Russian bank (Cyrillic letters only; enough for the fixture). */
export function cp1251(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c >= 0x410 && c <= 0x44f) out.push(c - 0x410 + 0xc0);
    else if (c === 0x401) out.push(0xa8);
    else if (c === 0x451) out.push(0xb8);
    else out.push(0x3f);
  }
  return new Uint8Array(out);
}
