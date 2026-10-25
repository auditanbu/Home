import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

import {
  UNIT_LABEL,
  displayUnitFor,
  formatQtyValue,
  sizeOf,
  type UnitType,
} from "./units";

export type PdfItem = {
  nameEn: string;
  nameTa: string;
  /** Tamil name in Latin script; falls back to nameEn when absent. */
  nameTl?: string | null;
  quantity: number;
  unitType: UnitType;
  /** Pack size, for items bought by the packet. Null when sold loose. */
  sizeValue?: number | null;
  sizeUnit?: UnitType | null;
  shopName: string | null;
  categoryName: string | null;
};

export type PdfLanguage = "en" | "ta" | "tl";

export type PdfOptions = {
  /** e.g. "Jul 2026" */
  listName: string;
  /** Shop the view is filtered to; null when printing every shop. */
  shopName?: string | null;
  /** Group rows under shop headings — used for the unfiltered print. */
  groupByShop?: boolean;
  language: PdfLanguage;
};

const CONTACT = {
  en: "Anbarasu - 9865027890",
  ta: "அன்பரசு - 9865027890",
};

const A4_WIDTH_MM = 210;
const A4_HEIGHT_MM = 297;

function formatToday(locale: string): string {
  return new Date().toLocaleDateString(locale, { day: "2-digit", month: "short", year: "numeric" });
}

/**
 * Builds the traditional print sheet:
 *
 *   [S.No] | [Item Name] | [Quantity] | [Unit] | [Price — left blank]
 *
 * The price column stays empty so it can be filled in by hand at the shop.
 * Tamil text needs a different rendering path — see buildTamilPdf below.
 * Tanglish is Latin script, so it rides the Latin path and gets the same
 * crisp vector text the English sheet does.
 */
export async function buildGroceryPdf(items: PdfItem[], options: PdfOptions): Promise<jsPDF> {
  return options.language === "ta" ? buildTamilPdf(items, options) : buildLatinPdf(items, options);
}

/**
 * Vector text via jsPDF-autotable — crisp, small file, searchable/selectable.
 * jsPDF's built-in fonts are Latin-only, which is fine here: this path only
 * ever prints nameEn or the Latin-script Tanglish name.
 */
function buildLatinPdf(items: PdfItem[], options: PdfOptions): jsPDF {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 14;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("Monthly Grocery List", margin, 18);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text(options.listName, margin, 25);

  const shopLabel = options.shopName ? `Shop: ${options.shopName}` : "All shops";
  doc.text(shopLabel, pageWidth - margin, 18, { align: "right" });
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(`Printed ${formatToday("en-IN")}`, pageWidth - margin, 25, { align: "right" });
  doc.setTextColor(0);

  doc.setDrawColor(200);
  doc.line(margin, 29, pageWidth - margin, 29);

  const grouped = options.groupByShop && !options.shopName;
  const body: (string | { content: string; colSpan: number; styles: object })[][] = [];

  if (grouped) {
    const byShop = new Map<string, PdfItem[]>();
    for (const item of items) {
      const key = item.shopName ?? "Unassigned";
      byShop.set(key, [...(byShop.get(key) ?? []), item]);
    }

    for (const [shop, shopItems] of byShop) {
      body.push([
        {
          content: shop,
          colSpan: 5,
          styles: { fontStyle: "bold", fillColor: [242, 242, 247], textColor: 40 },
        },
      ]);
      shopItems.forEach((item, index) => body.push(rowFor(item, index + 1, options.language)));
    }
  } else {
    items.forEach((item, index) => body.push(rowFor(item, index + 1, options.language)));
  }

  autoTable(doc, {
    startY: 34,
    head: [["S.No", "Item Name", "Qty", "Unit", "Price"]],
    body,
    theme: "grid",
    styles: {
      font: "helvetica",
      fontSize: 11,
      cellPadding: { top: 3, bottom: 3, left: 2.5, right: 2.5 },
      lineColor: [190, 190, 195],
      lineWidth: 0.2,
      textColor: 20,
    },
    headStyles: {
      font: "helvetica",
      fontStyle: "bold",
      fillColor: [28, 28, 30],
      textColor: 255,
      halign: "center",
    },
    columnStyles: {
      0: { cellWidth: 14, halign: "center" },
      1: { cellWidth: "auto" },
      2: { cellWidth: 20, halign: "right" },
      3: { cellWidth: 18, halign: "center" },
      4: { cellWidth: 32 },
    },
    margin: { left: margin, right: margin, bottom: 24 },
    didDrawPage: () => {
      const pageHeight = doc.internal.pageSize.getHeight();
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(130);
      doc.text(`${items.length} item${items.length === 1 ? "" : "s"}`, margin, pageHeight - 14);
      doc.text(`Page ${doc.getNumberOfPages()}`, pageWidth - margin, pageHeight - 14, {
        align: "right",
      });
      doc.setTextColor(0);
    },
  });

  // Blank total line, in keeping with a hand-filled shop sheet.
  const finalY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY;
  if (finalY && finalY < doc.internal.pageSize.getHeight() - 34) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text("Total", pageWidth - margin - 52, finalY + 10);
    doc.setDrawColor(120);
    doc.line(pageWidth - margin - 32, finalY + 10.5, pageWidth - margin, finalY + 10.5);
  }

  addContactFooterToAllPages(doc, "en", margin);
  return doc;
}

/**
 * A packaged item prints as its count against its pack size ("1 | 200 g")
 * — which is the pair that matters at the counter — rather than "1 | nos",
 * which would leave the size on the shelf label to guesswork.
 */
function unitCellFor(item: PdfItem, display: { unit: UnitType }, label: Record<UnitType, string>): string {
  const size = sizeOf(item.sizeValue, item.sizeUnit);
  if (size && item.unitType === "COUNT") {
    const sizeDisplay = displayUnitFor(size.value, size.unit);
    return `${formatQtyValue(sizeDisplay.quantity, sizeDisplay.unit)} ${label[sizeDisplay.unit]}`.trim();
  }
  return label[display.unit];
}

function rowFor(item: PdfItem, serial: number, language: PdfLanguage): string[] {
  const display = displayUnitFor(item.quantity, item.unitType);
  const name = language === "tl" ? (item.nameTl?.trim() || item.nameEn) : item.nameEn;
  return [
    String(serial),
    name,
    formatQtyValue(display.quantity, display.unit),
    unitCellFor(item, display, UNIT_LABEL) || "nos",
    "",
  ];
}

/** Prints "Anbarasu - 9865027890" bottom-left of every page, English mode only. */
function addContactFooterToAllPages(doc: jsPDF, language: "en", margin: number) {
  const pageHeight = doc.internal.pageSize.getHeight();
  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page++) {
    doc.setPage(page);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(90);
    doc.text(CONTACT[language], margin, pageHeight - 8);
    doc.setTextColor(0);
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Single-quoted: this stack is interpolated straight into a double-quoted
// HTML style="..." attribute (see tamilPageHtml) — double-quoted family
// names here would close that attribute early and silently drop every
// declaration after font-family (margin, fixed page height, overflow
// clip, font-size), which is exactly what caused Tamil PDFs to render
// with no page margins and get stretched to fill the sheet.
//
// var(--font-tamil) is the webfont loaded in the root layout; next/font/local
// hashes the family name, so the variable is the only stable way to reach it.
// The device faces stay behind it for the case where it has not loaded. This
// is what makes the printed sheet match the screen instead of depending on
// the machine.
export const TAMIL_FONT_STACK =
  "var(--font-tamil), 'Noto Sans Tamil', 'Tamil Sangam MN', 'Tamil MN', 'Nirmala UI', -apple-system, sans-serif";

const TAMIL_PAGE_MARGIN_MM = 14;

/**
 * The Tamil sheet is paginated by row count, not by measured height: every
 * page carries exactly this many item rows (the last page holds the
 * remainder). Shop headings ride along on the page of the items they
 * introduce and don't consume one of the slots.
 */
const TAMIL_ROWS_PER_PAGE = 30;

/** The shop the Tamil sheet is always printed for — as fixed as the contact line. */
const TAMIL_SHOP_NAME = "பாலமுருகன் மளிகை";

/**
 * Unit names spelled out in Tamil. Countable items print nothing at all
 * (the English sheet's "nos" reads as noise here), which is why this is a
 * separate map rather than a translation of UNIT_LABEL.
 */
const TAMIL_UNIT_LABEL: Record<UnitType, string> = {
  KG: "கிலோ",
  G: "கிராம்",
  L: "லிட்டர்",
  ML: "மில்லி",
  RS: "ரூபாய்",
  COUNT: "",
};

/**
 * Base row metrics, in the units they're written out in. A single fit
 * factor (see fitScaleFor) multiplies all of them together when a full
 * page of rows would otherwise overflow the sheet — long wrapping names,
 * or grouped prints where shop headings eat extra height.
 */
const TAMIL_METRICS = {
  rowPaddingMm: 1.5,
  headPaddingMm: 1.6,
  shopPaddingMm: 1.4,
  tablePt: 10.5,
};

/** Never shrink past this — below it the sheet stops being readable at arm's length. */
const TAMIL_MIN_SCALE = 0.6;

type TamilRow = { kind: "shop"; label: string } | { kind: "item"; item: PdfItem; serial: number };

/** Same grouping as the English sheet's `rowFor`/shop-heading loop. */
function buildTamilRows(items: PdfItem[], grouped: boolean): TamilRow[] {
  const rows: TamilRow[] = [];
  if (grouped) {
    const byShop = new Map<string, PdfItem[]>();
    for (const item of items) {
      const key = item.shopName ?? "வேறு";
      byShop.set(key, [...(byShop.get(key) ?? []), item]);
    }
    for (const [shop, shopItems] of byShop) {
      rows.push({ kind: "shop", label: shop });
      shopItems.forEach((item, index) => rows.push({ kind: "item", item, serial: index + 1 }));
    }
  } else {
    items.forEach((item, index) => rows.push({ kind: "item", item, serial: index + 1 }));
  }
  return rows;
}

/**
 * One line per item, Tamil name only — the English name the row used to
 * carry alongside it is what made the row too tall to fit 30 of them on a
 * sheet at a readable size.
 */
function tamilRowHtml(row: TamilRow, rowIndex: number, scale: number): string {
  const mm = (value: number) => `${(value * scale).toFixed(2)}mm`;

  if (row.kind === "shop") {
    return `<tr data-row="${rowIndex}"><td colspan="5" style="padding:${mm(TAMIL_METRICS.shopPaddingMm)};background:#f2f2f7;font-weight:700;color:#333;">${escapeHtml(row.label)}</td></tr>`;
  }
  const { item, serial } = row;
  const display = displayUnitFor(item.quantity, item.unitType);
  const pad = `padding:${mm(TAMIL_METRICS.rowPaddingMm)};`;
  return `<tr data-row="${rowIndex}" style="border-bottom:1px solid #ddd;">
    <td style="${pad} text-align:center;color:#666;">${serial}</td>
    <td style="${pad} font-weight:600;">${escapeHtml(item.nameTa)}</td>
    <td style="${pad} text-align:right;">${escapeHtml(formatQtyValue(display.quantity, display.unit))}</td>
    <td style="${pad} text-align:center;">${escapeHtml(unitCellFor(item, display, TAMIL_UNIT_LABEL))}</td>
    <td style="${pad}"></td>
  </tr>`;
}

/** Header row, styled to match the English sheet's dark, centered thead exactly. */
function tamilTableHeadHtml(scale: number): string {
  const pad = `padding:${(TAMIL_METRICS.headPaddingMm * scale).toFixed(2)}mm;`;
  return `
  <thead>
    <tr style="background:#1c1c1e; color:#fff;">
      <th style="${pad} text-align:center; width:12mm;">வ.எண்</th>
      <th style="${pad} text-align:center;">பொருளின் பெயர்</th>
      <th style="${pad} text-align:center; width:18mm;">அளவு</th>
      <th style="${pad} text-align:center; width:22mm;">அலகு</th>
      <th style="${pad} text-align:center; width:30mm;">விலை</th>
    </tr>
  </thead>`;
}

/**
 * Mirrors the English sheet's title block — page 1 only, and deliberately
 * more compact than that one: the sheet's height is spoken for by 30 rows,
 * so the heading gives back everything it can. No print date.
 */
function tamilTitleBlockHtml(options: PdfOptions): string {
  return `
    <div data-block="title" style="display:flex; justify-content:space-between; align-items:baseline; border-bottom:1px solid #ccc; padding-bottom:2.5mm; margin-bottom:3mm;">
      <div style="font-size:12pt; font-weight:700;">மாத மளிகை பட்டியல்</div>
      <div style="font-size:9.5pt; color:#333;">
        <span>${escapeHtml(options.listName)}</span>
        <span style="margin-left:5mm;">கடை: ${escapeHtml(TAMIL_SHOP_NAME)}</span>
      </div>
    </div>`;
}

/** Mirrors the English sheet's blank hand-filled total line — last page only. */
function tamilTotalLineHtml(): string {
  return `
    <div data-block="total" style="display:flex; justify-content:flex-end; align-items:baseline; margin-top:5mm; font-size:9.5pt;">
      <div style="font-weight:700; margin-right:4mm;">மொத்தம்</div>
      <div style="width:32mm; border-bottom:1px solid #888;"></div>
    </div>`;
}

/**
 * The English sheet's per-page footer (item count, contact, page number),
 * squeezed onto a single line so it costs the table as little height as
 * possible.
 */
function tamilFooterHtml(itemCount: number, page: number, pageCount: number): string {
  return `
    <div data-block="footer" style="display:flex; justify-content:space-between; margin-top:3mm; padding-top:2mm; border-top:1px solid #eee; font-size:8pt; color:#666;">
      <div>${itemCount} பொருட்கள்</div>
      <div>${escapeHtml(CONTACT.ta)}</div>
      <div>பக்கம் ${page} / ${pageCount}</div>
    </div>`;
}

/**
 * `fixedHeight` pins the page to exactly one A4 sheet with overflow
 * clipped — a safety net for the final per-page renders so any residual
 * measurement drift trims invisible whitespace instead of bleeding text
 * past the page edge. The probe render omits it so nothing is clipped
 * before it's been measured.
 */
function tamilPageHtml(bodyHtml: string, fixedHeight = false): string {
  const heightStyle = fixedHeight ? `height:${A4_HEIGHT_MM}mm; overflow:hidden;` : "";
  return `<div style="font-family:${TAMIL_FONT_STACK}; color:#111; padding:${TAMIL_PAGE_MARGIN_MM}mm; box-sizing:border-box; font-size:11pt; ${heightStyle}">
    ${bodyHtml}
  </div>`;
}

function tamilTableHtml(rowsHtml: string, scale: number): string {
  const fontSize = (TAMIL_METRICS.tablePt * scale).toFixed(2);
  return `<table style="width:100%; border-collapse:collapse; font-size:${fontSize}pt;">${tamilTableHeadHtml(scale)}<tbody>${rowsHtml}</tbody></table>`;
}

/**
 * Splits the rows into pages of exactly TAMIL_ROWS_PER_PAGE item rows.
 * Shop headings are carried on the page of the items beneath them and
 * don't count against the limit, so every page holds the same number of
 * items whether or not the print is grouped. A heading is never left
 * stranded at the foot of a page: the page break happens before it.
 */
function paginateTamilRows(rows: TamilRow[]): number[][] {
  const pages: number[][] = [[]];
  let itemsOnPage = 0;

  for (let index = 0; index < rows.length; index++) {
    if (itemsOnPage === TAMIL_ROWS_PER_PAGE) {
      pages.push([]);
      itemsOnPage = 0;
    }
    pages[pages.length - 1].push(index);
    if (rows[index].kind === "item") itemsOnPage++;
  }

  if (pages.length > 1 && pages[pages.length - 1].length === 0) pages.pop();
  return pages;
}

function tamilPageBodyHtml(
  rows: TamilRow[],
  rowIndexes: number[],
  options: PdfOptions,
  itemCount: number,
  page: number,
  pageCount: number,
  scale: number,
): string {
  return (
    (page === 1 ? tamilTitleBlockHtml(options) : "") +
    tamilTableHtml(rowIndexes.map((index) => tamilRowHtml(rows[index], index, scale)).join(""), scale) +
    (page === pageCount ? tamilTotalLineHtml() : "") +
    tamilFooterHtml(itemCount, page, pageCount)
  );
}

/**
 * Because the row count per page is now fixed, the sheet has to bend to
 * the rows rather than the other way round. This renders every page
 * off-screen at full size, finds the tallest, and returns the factor that
 * pulls it back inside one A4 sheet. It re-measures after each estimate
 * because text reflows as it shrinks — a name that wrapped onto two lines
 * may unwrap — so a single height/budget ratio isn't reliably enough.
 */
function fitScaleFor(
  probe: HTMLElement,
  renderAt: (scale: number) => string,
): number {
  const measure = (scale: number): number => {
    probe.innerHTML = renderAt(scale);
    let tallest = 0;
    probe.querySelectorAll("[data-page]").forEach((page) => {
      tallest = Math.max(tallest, page.getBoundingClientRect().height);
    });
    return tallest;
  };

  // 2mm of slack keeps the footer clear of the hard clip at the page edge.
  const budgetPx = (probe.getBoundingClientRect().width / A4_WIDTH_MM) * (A4_HEIGHT_MM - 2);

  let scale = 1;
  for (let pass = 0; pass < 3; pass++) {
    const tallest = measure(scale);
    if (tallest <= budgetPx || scale <= TAMIL_MIN_SCALE) break;
    scale = Math.max(TAMIL_MIN_SCALE, scale * (budgetPx / tallest));
  }
  return scale;
}

/**
 * Tamil text needs real OpenType shaping (combining vowel signs, conjunct
 * consonants) that jsPDF cannot do — it draws glyphs one Unicode codepoint
 * at a time, which silently mangles Tamil (e.g. "துவரம்" renders as
 * "தவரம்"). Instead this renders the print sheet as HTML off-screen and
 * captures it with the browser's own — correct — text engine via
 * html2canvas.
 *
 * Pages are laid out the same way the English autoTable print does: the
 * table header repeats on every page, the title block only appears on
 * page 1, and a footer (item count / page number / contact) repeats on
 * every page. Every page carries exactly TAMIL_ROWS_PER_PAGE items; the
 * row density is measured off-screen and scaled down if that many rows
 * wouldn't otherwise fit the sheet.
 */
async function buildTamilPdf(items: PdfItem[], options: PdfOptions): Promise<jsPDF> {
  const html2canvas = (await import("html2canvas")).default;
  if (document.fonts?.ready) await document.fonts.ready;

  const grouped = Boolean(options.groupByShop && !options.shopName);
  const rows = buildTamilRows(items, grouped);
  const pages = paginateTamilRows(rows);

  const bodyFor = (page: number, scale: number) =>
    tamilPageBodyHtml(rows, pages[page - 1], options, items.length, page, pages.length, scale);

  const probe = document.createElement("div");
  probe.style.position = "fixed";
  probe.style.top = "0";
  probe.style.left = "-10000px";
  probe.style.width = `${A4_WIDTH_MM}mm`;
  probe.style.backgroundColor = "#ffffff";
  document.body.appendChild(probe);

  let scale: number;
  try {
    scale = fitScaleFor(probe, (candidate) =>
      pages
        .map(
          (_, index) =>
            `<div data-page="${index}">${tamilPageHtml(bodyFor(index + 1, candidate))}</div>`,
        )
        .join(""),
    );
  } finally {
    document.body.removeChild(probe);
  }

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  for (let page = 0; page < pages.length; page++) {
    const bodyHtml = bodyFor(page + 1, scale);

    const container = document.createElement("div");
    container.style.position = "fixed";
    container.style.top = "0";
    container.style.left = "-10000px";
    container.style.width = `${A4_WIDTH_MM}mm`;
    container.style.backgroundColor = "#ffffff";
    container.innerHTML = tamilPageHtml(bodyHtml, true);
    document.body.appendChild(container);

    try {
      const canvas = await html2canvas(container, { scale: 2, backgroundColor: "#ffffff", useCORS: true });
      const imageData = canvas.toDataURL("image/jpeg", 0.92);
      if (page > 0) doc.addPage();
      doc.addImage(imageData, "JPEG", 0, 0, A4_WIDTH_MM, A4_HEIGHT_MM);
    } finally {
      document.body.removeChild(container);
    }
  }

  return doc;
}

export function pdfFileName(listName: string, shopName?: string | null): string {
  const parts = [listName, shopName ?? "All Shops"].map((part) =>
    part.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, ""),
  );
  return `Grocery-${parts.join("-")}.pdf`;
}

/** Triggers a browser download of the print sheet. */
export async function downloadGroceryPdf(items: PdfItem[], options: PdfOptions): Promise<void> {
  const doc = await buildGroceryPdf(items, options);
  doc.save(pdfFileName(options.listName, options.shopName));
}
