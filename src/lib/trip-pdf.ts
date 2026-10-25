import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

import { tripPersonTotals } from "./expenses/trip-summary";
import type { TripDetailDTO } from "./expenses/types";

/**
 * jsPDF's built-in Helvetica has no ₹ glyph — it prints as garbage — so the
 * statement spells the currency out instead of reusing formatPrice.
 */
function rupees(value: number): string {
  // Whole rupees: a printed statement reads cleaner without paise.
  return `Rs. ${Math.round(value).toLocaleString("en-IN")}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

type AutoTableDoc = jsPDF & { lastAutoTable?: { finalY: number } };

/**
 * A closed trip's statement: the total, what each person spent and paid,
 * the category breakdown, every expense, and what is still pending — the same
 * story the WhatsApp share tells, in a form that can be kept or printed.
 */
export function buildTripPdf(trip: TripDetailDTO): jsPDF {
  const doc: AutoTableDoc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 14;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(trip.name, margin, 18);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(trip.participants.map((person) => person.name).join(", "), margin, 25, {
    maxWidth: pageWidth - margin * 2 - 60,
  });

  doc.text("Trip statement", pageWidth - margin, 18, { align: "right" });
  doc.setFontSize(9);
  doc.setTextColor(120);
  const closedLabel = trip.closedAt ? `Closed ${formatDate(trip.closedAt)}` : "Open";
  doc.text(closedLabel, pageWidth - margin, 25, { align: "right" });
  doc.setTextColor(0);

  doc.setDrawColor(200);
  doc.line(margin, 30, pageWidth - margin, 30);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text(`Total spent: ${rupees(trip.total)}`, margin, 38);

  const tableStyles = {
    theme: "grid" as const,
    styles: {
      font: "helvetica",
      fontSize: 10,
      cellPadding: { top: 2.5, bottom: 2.5, left: 2.5, right: 2.5 },
      lineColor: [190, 190, 195] as [number, number, number],
      lineWidth: 0.2,
      textColor: 20,
    },
    headStyles: {
      fontStyle: "bold" as const,
      fillColor: [28, 28, 30] as [number, number, number],
      textColor: 255,
    },
    footStyles: {
      fontStyle: "bold" as const,
      fillColor: [242, 242, 247] as [number, number, number],
      textColor: 20,
    },
    margin: { left: margin, right: margin, bottom: 20 },
  };

  let cursorY = 48;
  const heading = (title: string) => {
    if (cursorY > doc.internal.pageSize.getHeight() - 40) {
      doc.addPage();
      cursorY = 18;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text(title, margin, cursorY);
    cursorY += 3;
  };
  const advance = () => {
    cursorY = (doc.lastAutoTable?.finalY ?? cursorY) + 10;
  };

  const people = tripPersonTotals(trip);
  heading("Spent by person");
  autoTable(doc, {
    ...tableStyles,
    startY: cursorY,
    head: [["Person", "Spent (share)", "Paid", "Balance"]],
    body: people.map((person) => [
      person.name,
      rupees(person.spent),
      rupees(person.paid),
      person.net > 0
        ? `${rupees(person.net)} to receive`
        : person.net < 0
          ? `${rupees(Math.abs(person.net))} pending`
          : "Settled",
    ]),
    foot: [
      [
        "Total",
        { content: rupees(people.reduce((sum, person) => sum + person.spent, 0)), styles: { halign: "right" } },
        { content: rupees(people.reduce((sum, person) => sum + person.paid, 0)), styles: { halign: "right" } },
        "",
      ],
    ],
    columnStyles: { 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" } },
  });
  advance();

  const categories = new Map<string, number>();
  for (const entry of trip.entries) {
    categories.set(entry.categoryNameEn, (categories.get(entry.categoryNameEn) ?? 0) + entry.amount);
  }
  if (categories.size > 0) {
    heading("By category");
    autoTable(doc, {
      ...tableStyles,
      startY: cursorY,
      head: [["Category", "Amount"]],
      body: [...categories.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, total]) => [name, rupees(total)]),
      columnStyles: { 1: { halign: "right", cellWidth: 40 } },
    });
    advance();
  }

  if (trip.entries.length > 0) {
    heading("Expenses");
    const chronological = [...trip.entries].sort((a, b) => a.spentAt.localeCompare(b.spentAt));
    autoTable(doc, {
      ...tableStyles,
      startY: cursorY,
      head: [["#", "Date", "Expense", "Paid by", "Amount"]],
      body: chronological.map((entry, index) => [
        String(index + 1),
        formatDate(entry.spentAt),
        entry.note?.trim() ? `${entry.categoryNameEn} - ${entry.note.trim()}` : entry.categoryNameEn,
        entry.paidByName ?? "-",
        rupees(entry.amount),
      ]),
      foot: [["", "", "Total", "", { content: rupees(trip.total), styles: { halign: "right" } }]],
      columnStyles: {
        0: { cellWidth: 10, halign: "center" },
        1: { cellWidth: 26 },
        3: { cellWidth: 30 },
        4: { cellWidth: 32, halign: "right" },
      },
    });
    advance();
  }

  heading("Pending payments");
  autoTable(doc, {
    ...tableStyles,
    startY: cursorY,
    head: [["From", "To", "Amount"]],
    body:
      trip.transfers.length > 0
        ? trip.transfers.map((transfer) => [transfer.fromName, transfer.toName, rupees(transfer.amount)])
        : [[{ content: "Fully settled - no pending payments.", colSpan: 3 }]],
    columnStyles: { 2: { halign: "right", cellWidth: 40 } },
  });
  advance();

  if (trip.settlements.length > 0) {
    heading("Settled payments");
    autoTable(doc, {
      ...tableStyles,
      startY: cursorY,
      head: [["Date", "From", "To", "Amount"]],
      body: trip.settlements.map((settlement) => [
        formatDate(settlement.settledAt),
        settlement.fromName,
        settlement.toName,
        rupees(settlement.amount),
      ]),
      columnStyles: { 3: { halign: "right", cellWidth: 40 } },
    });
  }

  const pageHeight = doc.internal.pageSize.getHeight();
  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page++) {
    doc.setPage(page);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(130);
    doc.text(`Printed ${formatDate(new Date().toISOString())}`, margin, pageHeight - 10);
    doc.text(`Page ${page} / ${pageCount}`, pageWidth - margin, pageHeight - 10, { align: "right" });
    doc.setTextColor(0);
  }

  return doc;
}

/** Triggers a browser download of the trip statement. */
export function downloadTripPdf(trip: TripDetailDTO): void {
  const slug = trip.name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "Trip";
  buildTripPdf(trip).save(`Trip-${slug}.pdf`);
}
