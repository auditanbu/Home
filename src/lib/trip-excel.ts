import ExcelJS from "exceljs";

import { tripDatesLabel, tripPersonTotals } from "./expenses/trip-summary";
import type { TripDetailDTO } from "./expenses/types";

/** Whole rupees on screen; the cell keeps the exact amount so sums stay right. */
const INR_FORMAT = '"₹"#,##0';
const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1C1C1E" } };
const TOTAL_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F7" } };
const BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: "FFC8C8CD" } },
  bottom: { style: "thin", color: { argb: "FFC8C8CD" } },
  left: { style: "thin", color: { argb: "FFC8C8CD" } },
  right: { style: "thin", color: { argb: "FFC8C8CD" } },
};

/**
 * Excel stores a date with no timezone, so an expense at 1am IST would
 * otherwise land on the previous day. This pins the cell to the local
 * calendar day the expense was logged on.
 */
function excelDay(iso: string): Date {
  const local = new Date(iso);
  return new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()));
}

function styleHeader(row: ExcelJS.Row) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = HEADER_FILL;
    cell.border = BORDER;
  });
}

function styleBody(row: ExcelJS.Row) {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.border = BORDER;
  });
}

function styleTotal(row: ExcelJS.Row) {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { bold: true };
    cell.fill = TOTAL_FILL;
    cell.border = BORDER;
  });
}

/** A bold section heading; returns the row the table under it starts on. */
function sectionTitle(sheet: ExcelJS.Worksheet, rowNumber: number, title: string): number {
  const cell = sheet.getCell(rowNumber, 1);
  cell.value = title;
  cell.font = { bold: true, size: 13 };
  return rowNumber + 1;
}

/**
 * The trip statement as a workbook: a Summary sheet laid out like the PDF
 * (people, categories, pending payments) and an Expenses sheet with one row
 * per expense and one column per person's share — the shape someone who
 * lives in Excel will want to sort, filter and total themselves.
 */
export async function buildTripWorkbook(trip: TripDetailDTO): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();

  // --- Summary --------------------------------------------------------------
  const summary = workbook.addWorksheet("Summary");
  summary.columns = [{ width: 24 }, { width: 16 }, { width: 16 }, { width: 18 }, { width: 16 }];

  summary.getCell("A1").value = trip.name;
  summary.getCell("A1").font = { bold: true, size: 18 };
  summary.getCell("A2").value = trip.participants.map((person) => person.name).join(", ");
  const dates = tripDatesLabel(trip);
  summary.getCell("A3").value = dates ? `Trip dates: ${dates}` : "";
  summary.getCell("A4").value = "Total spent";
  summary.getCell("A4").font = { bold: true, size: 13 };
  summary.getCell("B4").value = trip.total;
  summary.getCell("B4").numFmt = INR_FORMAT;
  summary.getCell("B4").font = { bold: true, size: 13 };

  let row = 6;
  row = sectionTitle(summary, row, "Spent by person");
  summary.getRow(row).values = ["Person", "Share", "Paid", "Balance", "Status"];
  styleHeader(summary.getRow(row));
  row++;
  const people = tripPersonTotals(trip);
  const firstPersonRow = row;
  for (const person of people) {
    const current = summary.getRow(row);
    current.values = [
      person.name,
      person.spent,
      person.paid,
      Math.abs(person.net),
      person.net > 0 ? "To receive" : person.net < 0 ? "Pending" : "Settled",
    ];
    [2, 3, 4].forEach((column) => (current.getCell(column).numFmt = INR_FORMAT));
    styleBody(current);
    row++;
  }
  const personTotal = summary.getRow(row);
  personTotal.values = [
    "Total",
    { formula: `SUM(B${firstPersonRow}:B${row - 1})` },
    { formula: `SUM(C${firstPersonRow}:C${row - 1})` },
    "",
    "",
  ];
  [2, 3].forEach((column) => (personTotal.getCell(column).numFmt = INR_FORMAT));
  styleTotal(personTotal);
  row += 2;

  const categories = new Map<string, number>();
  for (const entry of trip.entries) {
    // Rounded to the paisa as it goes, so float drift never shows in a cell.
    const sum = (categories.get(entry.categoryNameEn) ?? 0) + entry.amount;
    categories.set(entry.categoryNameEn, Math.round(sum * 100) / 100);
  }
  if (categories.size > 0) {
    row = sectionTitle(summary, row, "By category");
    summary.getRow(row).values = ["Category", "Amount", "Share of trip"];
    styleHeader(summary.getRow(row));
    row++;
    const firstCategoryRow = row;
    for (const [name, amount] of [...categories.entries()].sort((a, b) => b[1] - a[1])) {
      const current = summary.getRow(row);
      current.values = [name, amount, trip.total > 0 ? amount / trip.total : 0];
      current.getCell(2).numFmt = INR_FORMAT;
      current.getCell(3).numFmt = "0%";
      styleBody(current);
      row++;
    }
    // A bar in each cell, the same picture as the PDF's By category.
    summary.addConditionalFormatting({
      ref: `C${firstCategoryRow}:C${row - 1}`,
      rules: [
        {
          type: "dataBar",
          priority: 1,
          minLength: 0,
          maxLength: 100,
          gradient: false,
          cfvo: [
            { type: "num", value: 0 },
            { type: "num", value: 1 },
          ],
          color: { argb: "FF0A84FF" },
        } as ExcelJS.DataBarRuleType,
      ],
    });
    const categoryTotal = summary.getRow(row);
    categoryTotal.values = ["Total", { formula: `SUM(B${firstCategoryRow}:B${row - 1})` }, 1];
    categoryTotal.getCell(2).numFmt = INR_FORMAT;
    categoryTotal.getCell(3).numFmt = "0%";
    styleTotal(categoryTotal);
    row += 2;
  }

  row = sectionTitle(summary, row, "Pending payments");
  summary.getRow(row).values = ["From", "To", "Amount"];
  styleHeader(summary.getRow(row));
  row++;
  if (trip.transfers.length === 0) {
    summary.getCell(row, 1).value = "Fully settled - no pending payments.";
    row++;
  }
  for (const transfer of trip.transfers) {
    const current = summary.getRow(row);
    current.values = [transfer.fromName, transfer.toName, transfer.amount];
    current.getCell(3).numFmt = INR_FORMAT;
    styleBody(current);
    row++;
  }

  if (trip.settlements.length > 0) {
    row++;
    row = sectionTitle(summary, row, "Settled payments");
    summary.getRow(row).values = ["Date", "From", "To", "Amount"];
    styleHeader(summary.getRow(row));
    row++;
    for (const settlement of trip.settlements) {
      const current = summary.getRow(row);
      current.values = [excelDay(settlement.settledAt), settlement.fromName, settlement.toName, settlement.amount];
      current.getCell(1).numFmt = "dd-mmm-yyyy";
      current.getCell(4).numFmt = INR_FORMAT;
      styleBody(current);
      row++;
    }
  }

  // --- Expenses -------------------------------------------------------------
  const sheet = workbook.addWorksheet("Expenses", { views: [{ state: "frozen", ySplit: 1 }] });
  const participants = trip.participants;
  sheet.columns = [
    { header: "#", width: 5 },
    { header: "Date", width: 13 },
    { header: "Category", width: 16 },
    { header: "Note", width: 26 },
    { header: "Paid by", width: 14 },
    { header: "Split", width: 10 },
    { header: "Amount", width: 12 },
    ...participants.map((person) => ({ header: `${person.name} share`, width: 14 })),
  ];
  styleHeader(sheet.getRow(1));

  const chronological = [...trip.entries].sort((a, b) => a.spentAt.localeCompare(b.spentAt));
  chronological.forEach((entry, index) => {
    const members = entry.shares.length > 0 ? entry.shares.length : 1;
    // An unsplit entry is wholly its payer's — the same rule tripPersonTotals uses.
    const shareOf = (personId: number) => {
      const share = entry.shares.find((candidate) => candidate.personId === personId);
      if (share) return share.amount;
      return entry.shares.length === 0 && entry.paidById === personId ? entry.amount : 0;
    };
    const current = sheet.addRow([
      index + 1,
      excelDay(entry.spentAt),
      entry.categoryNameEn,
      entry.note?.trim() ?? "",
      entry.paidByName ?? "",
      members === participants.length ? `All ${members}` : `${members} of ${participants.length}`,
      entry.amount,
      ...participants.map((person) => shareOf(person.id)),
    ]);
    current.getCell(2).numFmt = "dd-mmm-yyyy";
    for (let column = 7; column <= 7 + participants.length; column++) current.getCell(column).numFmt = INR_FORMAT;
    styleBody(current);
  });

  if (chronological.length > 0) {
    const last = chronological.length + 1;
    const columnLetter = (column: number) => sheet.getColumn(column).letter;
    const totals = sheet.addRow([
      "",
      "",
      "Total",
      "",
      "",
      "",
      ...Array.from({ length: participants.length + 1 }, (_, offset) => ({
        formula: `SUM(${columnLetter(7 + offset)}2:${columnLetter(7 + offset)}${last})`,
      })),
    ]);
    for (let column = 7; column <= 7 + participants.length; column++) totals.getCell(column).numFmt = INR_FORMAT;
    styleTotal(totals);
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: last, column: 7 + participants.length } };
  }

  return workbook;
}

/** Triggers a browser download of the trip statement as an .xlsx file. */
export async function downloadTripExcel(trip: TripDetailDTO): Promise<void> {
  const workbook = await buildTripWorkbook(trip);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const slug = trip.name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "Trip";
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `Trip-${slug}.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
