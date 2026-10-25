import { jsPDF } from "jspdf";

import { escapeHtml, TAMIL_FONT_STACK } from "./pdf";
import { tripPersonTotals } from "./expenses/trip-summary";
import type { TripDetailDTO } from "./expenses/types";

const A4_WIDTH_MM = 210;
const A4_HEIGHT_MM = 297;
const MARGIN_MM = 14;
/** Room kept clear at the foot of each page for the printed-on / page line. */
const FOOTER_MM = 12;
const CONTENT_WIDTH_MM = A4_WIDTH_MM - MARGIN_MM * 2;
const CONTENT_HEIGHT_MM = A4_HEIGHT_MM - MARGIN_MM - FOOTER_MM;

/** Whole rupees with the ₹ sign — a printed statement reads cleaner without paise. */
function inr(value: number): string {
  return `₹${Math.round(value).toLocaleString("en-IN")}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

/**
 * "20 Oct 2026 to 22 Oct 2026 (3 days)" — the first and last expense dates,
 * which is when the trip actually ran; closing it can come days later.
 */
function tripDatesLabel(trip: TripDetailDTO): string {
  if (trip.entries.length === 0) return "";
  const times = trip.entries.map((entry) => Date.parse(entry.spentAt));
  const first = new Date(Math.min(...times));
  const last = new Date(Math.max(...times));
  const dayOf = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((dayOf(last) - dayOf(first)) / 86_400_000) + 1;
  const range =
    days === 1
      ? formatDate(first.toISOString())
      : `${formatDate(first.toISOString())} to ${formatDate(last.toISOString())}`;
  return `${range} (${days} day${days === 1 ? "" : "s"})`;
}

type Align = "left" | "right" | "center";

const CELL = "padding:2mm 2.5mm; border:1px solid #c8c8cd; vertical-align:middle;";

/**
 * One table of the statement. Every body and footer row carries `data-row`,
 * which marks it as a place a page may break — see paginate below.
 */
function tableHtml({
  head,
  rows,
  foot,
  align = [],
  widths = [],
  empty,
}: {
  head: string[];
  rows: string[][];
  foot?: string[];
  align?: Align[];
  widths?: (string | undefined)[];
  empty?: string;
}): string {
  const cell = (tag: "td" | "th", text: string, index: number, extra = "") =>
    `<${tag} style="${CELL} text-align:${align[index] ?? "left"}; ${widths[index] ? `width:${widths[index]};` : ""} ${extra}">${escapeHtml(text)}</${tag}>`;

  const headHtml = `<tr style="background:#1c1c1e; color:#fff;">${head
    .map((text, index) => cell("th", text, index, "font-weight:700; border-color:#1c1c1e;"))
    .join("")}</tr>`;
  const bodyHtml =
    rows.length > 0
      ? rows.map((row) => `<tr data-row>${row.map((text, index) => cell("td", text, index)).join("")}</tr>`).join("")
      : `<tr data-row><td colspan="${head.length}" style="${CELL} color:#555;">${escapeHtml(empty ?? "")}</td></tr>`;
  const footHtml = foot
    ? `<tr data-row style="background:#f2f2f7; font-weight:700;">${foot
        .map((text, index) => cell("td", text, index))
        .join("")}</tr>`
    : "";

  return `<table style="width:100%; border-collapse:collapse; font-size:11pt;"><thead>${headHtml}</thead><tbody>${bodyHtml}${footHtml}</tbody></table>`;
}

/**
 * By category as bars rather than a bare list: each bar's length is that
 * category's slice of the trip, so the biggest spends stand out before any
 * number is read. Each line is still a `data-row` break point.
 */
function categoryChartHtml(categories: [string, number][], total: number): string {
  const percent = (value: number) => (total > 0 ? Math.round((value / total) * 100) : 0);
  const cell = "padding:2mm 1.5mm; border-bottom:1px solid #e5e5ea; vertical-align:middle;";
  const line = (name: string, amount: string, pct: number, bar: string, bold = false) => `
    <tr data-row style="${bold ? "font-weight:700;" : ""}">
      <td style="${cell} width:36mm; white-space:nowrap;">${escapeHtml(name)}</td>
      <td style="${cell}">${bar}</td>
      <td style="${cell} width:13mm; text-align:right; color:#555;">${pct}%</td>
      <td style="${cell} width:26mm; text-align:right;">${amount}</td>
    </tr>`;
  const bar = (pct: number) =>
    `<div style="height:4.5mm; border-radius:2.25mm; background:#e5e5ea;"><div style="height:100%; width:${Math.max(pct, 1)}%; border-radius:2.25mm; background:#0a84ff;"></div></div>`;

  return `<table style="width:100%; border-collapse:collapse; font-size:11pt;"><tbody>${
    categories.map(([name, amount]) => line(name, inr(amount), percent(amount), bar(percent(amount)))).join("") +
    line("Total", inr(total), 100, "", true)
  }</tbody></table>`;
}

function sectionHtml(title: string, body: string): string {
  return `<section data-row style="margin-top:7mm;"><h2 style="font-size:14pt; font-weight:700; margin:0 0 2.5mm;">${escapeHtml(title)}</h2>${body}</section>`;
}

/**
 * The statement as one long HTML column: the total, what each person spent
 * and paid, the category breakdown, every expense, and what is still
 * pending — the same story the WhatsApp share tells, in a form that can be
 * kept or printed.
 */
function statementHtml(trip: TripDetailDTO): string {
  const people = tripPersonTotals(trip);
  const participants = trip.participants.length;
  const dates = tripDatesLabel(trip);

  const header = `
    <div data-row>
      <div style="display:flex; justify-content:space-between; align-items:baseline; gap:6mm;">
        <div style="font-size:20pt; font-weight:700;">${escapeHtml(trip.name)}</div>
        <div style="font-size:11pt; flex:none;">Trip statement</div>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:baseline; gap:6mm; margin-top:1.5mm; font-size:11pt;">
        <div>${escapeHtml(trip.participants.map((person) => person.name).join(", "))}</div>
        <div style="color:#777; flex:none;">${trip.closedAt ? `Closed ${formatDate(trip.closedAt)}` : "Open"}</div>
      </div>
      ${dates ? `<div style="margin-top:1.5mm; font-size:11pt;"><span style="color:#777;">Trip dates:</span> ${escapeHtml(dates)}</div>` : ""}
      <div style="border-bottom:1px solid #ccc; margin:3mm 0;"></div>
      <div style="font-size:15pt; font-weight:700;">Total spent: ${inr(trip.total)}</div>
    </div>`;

  const byPerson = sectionHtml(
    "Spent by person",
    tableHtml({
      head: ["Person", "Share", "Paid", "Balance"],
      rows: people.map((person) => [
        person.name,
        inr(person.spent),
        inr(person.paid),
        person.net > 0
          ? `${inr(person.net)} to receive`
          : person.net < 0
            ? `${inr(Math.abs(person.net))} pending`
            : "Settled",
      ]),
      foot: [
        "Total",
        inr(people.reduce((sum, person) => sum + person.spent, 0)),
        inr(people.reduce((sum, person) => sum + person.paid, 0)),
        "",
      ],
      align: ["left", "right", "right", "right"],
    }),
  );

  const categories = new Map<string, number>();
  for (const entry of trip.entries) {
    categories.set(entry.categoryNameEn, (categories.get(entry.categoryNameEn) ?? 0) + entry.amount);
  }
  const byCategory =
    categories.size > 0
      ? sectionHtml(
          "By category",
          categoryChartHtml([...categories.entries()].sort((a, b) => b[1] - a[1]), trip.total),
        )
      : "";

  const chronological = [...trip.entries].sort((a, b) => a.spentAt.localeCompare(b.spentAt));
  const expenses =
    chronological.length > 0
      ? sectionHtml(
          "Expenses",
          tableHtml({
            head: ["#", "Date", "Expense", "Paid by", "Split", "Amount"],
            rows: chronological.map((entry, index) => {
              // How many people share it; an unsplit entry is its payer's alone.
              const members = entry.shares.length > 0 ? entry.shares.length : 1;
              return [
                String(index + 1),
                formatDate(entry.spentAt).replace(/ /g, "\u00a0"),
                entry.note?.trim() ? `${entry.categoryNameEn} - ${entry.note.trim()}` : entry.categoryNameEn,
                entry.paidByName ?? "-",
                members === participants ? `All ${members}` : `${members} of ${participants}`,
                inr(entry.amount),
              ];
            }),
            foot: ["", "", "Total", "", "", inr(trip.total)],
            align: ["center", "left", "left", "left", "center", "right"],
            widths: ["8mm", "27mm", undefined, "28mm", "18mm", "26mm"],
          }),
        )
      : "";

  const pending = sectionHtml(
    "Pending payments",
    tableHtml({
      head: ["From", "To", "Amount"],
      rows: trip.transfers.map((transfer) => [transfer.fromName, transfer.toName, inr(transfer.amount)]),
      empty: "Fully settled - no pending payments.",
      align: ["left", "left", "right"],
      widths: [undefined, undefined, "34mm"],
    }),
  );

  const settled =
    trip.settlements.length > 0
      ? sectionHtml(
          "Settled payments",
          tableHtml({
            head: ["Date", "From", "To", "Amount"],
            rows: trip.settlements.map((settlement) => [
              formatDate(settlement.settledAt),
              settlement.fromName,
              settlement.toName,
              inr(settlement.amount),
            ]),
            align: ["left", "left", "left", "right"],
            widths: ["26mm", undefined, undefined, "34mm"],
          }),
        )
      : "";

  // The rupee sign comes out small next to the digits in most fonts; give it
  // a bit more presence. It only ever comes from inr(), already escaped.
  return (header + byPerson + byCategory + expenses + pending + settled).replace(
    /₹/g,
    '<span style="font-size:1.2em; font-weight:600; line-height:1;">₹</span>',
  );
}

/**
 * Where each page ends, in CSS pixels down the column: as far as a page
 * holds, but only ever at the bottom of a row or a section, so no row is cut
 * in half. A section heading never ends a page on its own — headings are not
 * break points, so one always travels with its table's first row.
 */
function paginate(column: HTMLElement, pageHeightPx: number): number[] {
  const top = column.getBoundingClientRect().top;
  const breaks = [...column.querySelectorAll<HTMLElement>("[data-row]")]
    .map((element) => element.getBoundingClientRect().bottom - top)
    .sort((a, b) => a - b);
  const end = column.getBoundingClientRect().height;

  const pageEnds: number[] = [];
  let start = 0;
  while (end - start > 1) {
    const limit = start + pageHeightPx;
    if (limit >= end) {
      pageEnds.push(end);
      break;
    }
    const fit = breaks.filter((y) => y > start + 1 && y <= limit).pop();
    // A single row taller than a page is cut where the page runs out.
    const pageEnd = fit ?? limit;
    pageEnds.push(pageEnd);
    start = pageEnd;
  }
  return pageEnds;
}

/**
 * Tamil names and the ₹ sign are both beyond jsPDF's built-in fonts, and
 * jsPDF cannot shape Tamil even with a font embedded (see buildTamilPdf in
 * pdf.ts). So, like the Tamil grocery sheet, the statement is laid out as
 * HTML off-screen, captured with the browser's own text engine via
 * html2canvas, and cut into A4 pages at row boundaries.
 */
export async function buildTripPdf(trip: TripDetailDTO): Promise<jsPDF> {
  const html2canvas = (await import("html2canvas")).default;
  if (document.fonts?.ready) await document.fonts.ready;

  const column = document.createElement("div");
  Object.assign(column.style, {
    position: "fixed",
    top: "0",
    left: "-10000px",
    width: `${CONTENT_WIDTH_MM}mm`,
    backgroundColor: "#ffffff",
    color: "#111",
    fontFamily: TAMIL_FONT_STACK,
    fontSize: "11pt",
    lineHeight: "1.35",
  });
  column.innerHTML = statementHtml(trip);
  document.body.appendChild(column);

  try {
    const pxPerMm = column.getBoundingClientRect().width / CONTENT_WIDTH_MM;
    const pageEnds = paginate(column, CONTENT_HEIGHT_MM * pxPerMm);

    const canvas = await html2canvas(column, { scale: 2, backgroundColor: "#ffffff", useCORS: true });
    const canvasScale = canvas.width / column.getBoundingClientRect().width;

    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const printed = `Printed ${formatDate(new Date().toISOString())}`;
    let start = 0;
    pageEnds.forEach((pageEnd, index) => {
      const slice = document.createElement("canvas");
      slice.width = canvas.width;
      slice.height = Math.max(1, Math.round((pageEnd - start) * canvasScale));
      const context = slice.getContext("2d");
      if (!context) throw new Error("Canvas is not available.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, slice.width, slice.height);
      context.drawImage(canvas, 0, -Math.round(start * canvasScale));

      if (index > 0) doc.addPage();
      doc.addImage(
        slice.toDataURL("image/jpeg", 0.92),
        "JPEG",
        MARGIN_MM,
        MARGIN_MM,
        CONTENT_WIDTH_MM,
        (pageEnd - start) / pxPerMm,
      );

      // The footer is plain Latin text, so it can stay crisp vector text.
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(130);
      doc.text(printed, MARGIN_MM, A4_HEIGHT_MM - 8);
      doc.text(`Page ${index + 1} / ${pageEnds.length}`, A4_WIDTH_MM - MARGIN_MM, A4_HEIGHT_MM - 8, {
        align: "right",
      });
      start = pageEnd;
    });
    return doc;
  } finally {
    document.body.removeChild(column);
  }
}

/** Triggers a browser download of the trip statement. */
export async function downloadTripPdf(trip: TripDetailDTO): Promise<void> {
  const slug = trip.name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "Trip";
  (await buildTripPdf(trip)).save(`Trip-${slug}.pdf`);
}
