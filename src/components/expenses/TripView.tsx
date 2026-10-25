"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { AdminLoginButton } from "@/components/AdminLoginButton";
import { FilterSheet, selectedOption, type FilterOption } from "@/components/FilterSheet";
import { Sheet } from "@/components/Sheet";
import { ThemeToggle } from "@/components/ThemeToggle";
import { EntrySheet } from "@/components/expenses/EntrySheet";
import {
  deleteExpense,
  deleteTrip,
  settleTrip,
  setTripClosed,
  updateTrip,
} from "@/lib/expenses/actions";
import { useAdmin } from "@/lib/admin-context";
import { formatIsoDate } from "@/lib/dates";
import { tripPersonTotals } from "@/lib/expenses/trip-summary";
import { primeKeyboard } from "@/lib/focus-keyboard";
import { formatPrice } from "@/lib/units";
import type {
  ExpenseDTO,
  ExpenseMonthDTO,
  TransferDTO,
  TripDetailDTO,
} from "@/lib/expenses/types";

/**
 * One trip's own page: its expenses, its total, and its balance — settled
 * as a unit, independent of the household's ongoing balance. What "split
 * the trip equally at the end" looks like once it is open.
 */
export function TripView({ trip }: { trip: TripDetailDTO }) {
  const router = useRouter();
  const { isAdmin } = useAdmin();
  const [entrySheet, setEntrySheet] = useState<{ open: boolean; entry: ExpenseDTO | null }>({
    open: false,
    entry: null,
  });
  const [editOpen, setEditOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settling, setSettling] = useState<TransferDTO | null>(null);
  // Which balance row is unfolded to show what that person paid for — one
  // at a time, tap the same name again (or a different one) to change it.
  const [expandedPersonId, setExpandedPersonId] = useState<number | null>(null);
  // Same idea for the category breakdown — its own toggle, independent of
  // whichever balance row is open.
  const [expandedCategoryId, setExpandedCategoryId] = useState<number | null>(null);
  // And for the By person rows: what that person paid, and their share.
  const [expandedSpenderId, setExpandedSpenderId] = useState<number | null>(null);
  // Folded by default — the totals above usually answer the question, and
  // the debts are a tap away when it is time to settle.
  const [balanceOpen, setBalanceOpen] = useState(false);
  // Narrows the Expenses list only — the totals above it still cover the
  // whole trip, so a filter can't be mistaken for having changed them.
  const [friendFilter, setFriendFilter] = useState<number | undefined>(undefined);
  const [categoryFilter, setCategoryFilter] = useState<number | undefined>(undefined);
  const [openFilter, setOpenFilter] = useState<"friend" | "category" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const filteredEntries = useMemo(
    () =>
      trip.entries.filter(
        (entry) =>
          (friendFilter === undefined || entry.paidById === friendFilter) &&
          (categoryFilter === undefined || entry.categoryId === categoryFilter),
      ),
    [trip.entries, friendFilter, categoryFilter],
  );

  const days = useMemo(() => {
    const grouped = new Map<string, ExpenseDTO[]>();
    for (const entry of filteredEntries) {
      const day = entry.spentAt.slice(0, 10);
      grouped.set(day, [...(grouped.get(day) ?? []), entry]);
    }
    return [...grouped.entries()];
  }, [filteredEntries]);

  // What this trip cost, broken down by what it was for — the total on its
  // own answers "how much", not "on what".
  const categoryTotals = useMemo(() => {
    const totals = new Map<number, { nameEn: string; total: number }>();
    for (const entry of trip.entries) {
      const current = totals.get(entry.categoryId);
      totals.set(entry.categoryId, {
        nameEn: entry.categoryNameEn,
        total: (current?.total ?? 0) + entry.amount,
      });
    }
    return [...totals.entries()]
      .map(([categoryId, { nameEn, total }]) => ({ categoryId, nameEn, total }))
      .sort((a, b) => b.total - a.total);
  }, [trip.entries]);

  // The whole trip as one message: what was spent, who fronted the money,
  // and the fewest payments that clear it — everything a group chat needs
  // to actually settle up, without anyone opening the app.
  const whatsappHref = useMemo(() => {
    const lines = [`*${trip.name}*`, `Total: ${formatPrice(trip.total)}`, ""];

    if (trip.entries.length > 0) {
      lines.push("*Expenses*");
      const chronological = [...trip.entries].sort((a, b) => a.spentAt.localeCompare(b.spentAt));
      for (const entry of chronological) {
        const paidBy = entry.paidByName ? ` (${entry.paidByName})` : "";
        const note = entry.note?.trim();
        const noteSuffix = note ? ` - ${note}` : "";
        lines.push(`- ${entry.categoryNameEn}: ${formatPrice(entry.amount)}${paidBy}${noteSuffix}`);
      }
      lines.push("");
    }

    const paidTotals = new Map<number, { name: string; total: number }>();
    for (const entry of trip.entries) {
      if (entry.paidById === null) continue;
      const current = paidTotals.get(entry.paidById);
      paidTotals.set(entry.paidById, {
        name: entry.paidByName ?? "Someone",
        total: (current?.total ?? 0) + entry.amount,
      });
    }
    if (paidTotals.size > 0) {
      lines.push("*Paid by*");
      for (const { name, total } of paidTotals.values()) {
        lines.push(`- ${name}: ${formatPrice(total)}`);
      }
      lines.push("");
    }

    if (trip.transfers.length > 0) {
      lines.push("*Pending payments*");
      for (const transfer of trip.transfers) {
        lines.push(`- ${transfer.fromName}: ${formatPrice(transfer.amount)} pending to ${transfer.toName}`);
      }
    } else {
      lines.push("Fully settled — no pending payments.");
    }

    return `https://wa.me/?text=${encodeURIComponent(lines.join("\n"))}`;
  }, [trip]);

  // What the trip cost each person, and what each of them fronted — the
  // total split by people rather than by category.
  const personTotals = useMemo(() => tripPersonTotals(trip), [trip]);

  const [pdfBusy, setPdfBusy] = useState(false);
  // jsPDF is imported lazily so it stays out of the trip page's bundle.
  const exportPdf = async () => {
    setPdfBusy(true);
    setError(null);
    try {
      const { downloadTripPdf } = await import("@/lib/trip-pdf");
      await downloadTripPdf(trip);
    } catch {
      setError("Could not generate the PDF. Please try again.");
    } finally {
      setPdfBusy(false);
    }
  };

  const [excelBusy, setExcelBusy] = useState(false);
  // One button in the header, then a choice: PDF, Excel or WhatsApp — more
  // round buttons would squeeze the trip name off a phone screen.
  const [downloadOpen, setDownloadOpen] = useState(false);
  // Same for exceljs — it only loads when someone asks for the workbook.
  const exportExcel = async () => {
    setExcelBusy(true);
    setError(null);
    try {
      const { downloadTripExcel } = await import("@/lib/trip-excel");
      await downloadTripExcel(trip);
    } catch {
      setError("Could not generate the Excel file. Please try again.");
    } finally {
      setExcelBusy(false);
    }
  };

  const friendFilterOptions: FilterOption<number | undefined>[] = [
    { key: "all", label: "All friends", value: undefined, count: trip.entries.length },
    ...trip.participants.map((person) => ({
      key: String(person.id),
      label: person.name,
      value: person.id,
      count: trip.entries.filter((entry) => entry.paidById === person.id).length,
    })),
  ];

  const categoryFilterOptions: FilterOption<number | undefined>[] = [
    { key: "all", label: "All categories", value: undefined, count: trip.entries.length },
    ...categoryTotals.map((total) => ({
      key: String(total.categoryId),
      label: total.nameEn,
      value: total.categoryId,
      count: trip.entries.filter((entry) => entry.categoryId === total.categoryId).length,
    })),
  ];

  // What EntrySheet needs, shaped as the one-trip ExpenseMonthDTO it expects
  // — the trip page's "Add expense" opens the same sheet already in this
  // trip's context, rather than a second form.
  const monthShim: ExpenseMonthDTO = {
    monthKey: "",
    spent: 0,
    income: 0,
    entries: [],
    categoryTotals: [],
    settlements: [],
    balances: [],
    transfers: [],
    categories: trip.categories,
    people: trip.people,
    methods: trip.methods,
    openTrips: [
      {
        id: trip.id,
        name: trip.name,
        closedAt: trip.closedAt,
        participantIds: trip.participants.map((person) => person.id),
        participantNames: trip.participants.map((person) => person.name),
        total: trip.total,
        settled: trip.balances.length === 0,
      },
    ],
    closedTrips: [],
  };

  const remove = (entry: ExpenseDTO) => {
    if (!window.confirm(`Delete ${formatPrice(entry.amount)} from this trip? This can't be undone.`)) {
      return;
    }
    startTransition(async () => {
      const result = await deleteExpense(entry.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEntrySheet({ open: false, entry: null });
      router.refresh();
    });
  };

  const toggleClosed = () => {
    startTransition(async () => {
      await setTripClosed(trip.id, trip.closedAt === null);
      router.refresh();
    });
  };

  const removeTrip = () => {
    if (
      !window.confirm(
        `Delete "${trip.name}"? All ${trip.entries.length} of its expenses go with it. This can't be undone.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      const result = await deleteTrip(trip.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push("/expenses");
    });
  };

  return (
    <div className="space-y-6 pb-4">
      {/*
        Pinned down through the trip name: on a long trip the name and the
        options menu are worth having on hand while scrolling through
        categories, balance and entries below — z-20 under AppNav (z-30) and
        Sheet (z-50), the -mx-4/px-4 pair spans <main>'s gutter, and the
        env() margin/padding pair cancels body's own safe-area padding so
        the pinned header clears the notch instead of sliding under it.
      */}
      <div
        className="sticky top-0 z-20 -mx-4 space-y-3 border-b border-ios-separator bg-ios-bg/90 px-4 pb-3 backdrop-blur-xl"
        style={{
          marginTop: "calc(-1 * env(safe-area-inset-top))",
          paddingTop: "calc(env(safe-area-inset-top) + 1rem)",
        }}
      >
        <header className="flex items-start justify-between gap-2">
          {/* Just the chevron — the name is what the row is about, so the
              back link gives it the width rather than spelling out "Expenses". */}
          <Link
            href="/expenses"
            aria-label="Back to expenses"
            title="Back to expenses"
            className="-ml-2 flex h-9 w-8 flex-none items-center justify-center text-ios-blue active:opacity-60"
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden>
              <path
                d="M15 5l-7 7 7 7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[30px] font-bold leading-tight tracking-tight">{trip.name}</h1>
            <p className="truncate text-[15px] text-ios-label-2">
              {trip.participants.map((person) => person.name).join(", ")}
              {trip.closedAt ? " · Closed" : ""}
            </p>
          </div>
          <div className="flex flex-none items-center gap-2">
            {/* Only once the trip is closed — a summary shared mid-trip goes
                stale with the next expense, and the group settles at the end. */}
            {trip.closedAt !== null ? (
              <button
                type="button"
                onClick={() => setDownloadOpen(true)}
                disabled={pdfBusy || excelBusy}
                aria-label="Download or share trip statement"
                title="Download or share trip statement"
                className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-ios-surface text-ios-blue shadow-ios active:scale-95 disabled:opacity-40"
              >
                <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" aria-hidden>
                  <path
                    d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V17"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-label="Trip options"
              className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-ios-surface text-ios-blue shadow-ios active:scale-95"
            >
              <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" aria-hidden>
                <path
                  d="M4 7h16M4 12h16M4 17h16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        </header>
      </div>

      {error ? (
        <p className="rounded-ios bg-ios-red-soft px-4 py-3 text-[14px] text-ios-red">{error}</p>
      ) : null}

      <section className="ios-card p-5">
        <p className="text-[13px] text-ios-label-2">Total spent on this trip</p>
        <p className="text-[32px] font-bold leading-none tabular-nums tracking-tight">
          {formatPrice(trip.total)}
        </p>
        <p className="mt-2 text-[12px] text-ios-label-3">
          Every expense here defaults to an equal split across everyone on the trip.
        </p>
      </section>

      {trip.closedAt === null ? (
        <button
          type="button"
          onClick={() => {
            primeKeyboard();
            setEntrySheet({ open: true, entry: null });
          }}
          className="h-11 w-full rounded-ios bg-ios-blue text-[15px] font-semibold text-white active:scale-[0.99]"
        >
          + Add expense
        </button>
      ) : null}

      {categoryTotals.length > 0 ? (
        <section>
          <h2 className="px-1 pb-2 text-[20px] font-semibold tracking-tight">By category</h2>
          <ul className="ios-card divide-y divide-ios-separator overflow-hidden">
            {categoryTotals.map((total) => {
              const expanded = expandedCategoryId === total.categoryId;
              return (
                <li key={total.categoryId}>
                  <div className="flex min-h-[3.25rem] items-center gap-3 px-4 py-2.5">
                    <NameToggle
                      name={total.nameEn}
                      expanded={expanded}
                      onClick={() => setExpandedCategoryId(expanded ? null : total.categoryId)}
                    />
                    <span className="flex-none text-[15px] font-semibold tabular-nums">
                      {formatPrice(total.total)}
                    </span>
                  </div>
                  {expanded ? (
                    <CategoryEntries
                      entries={trip.entries.filter((entry) => entry.categoryId === total.categoryId)}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {trip.entries.length > 0 ? (
        <section>
          <h2 className="px-1 pb-2 text-[20px] font-semibold tracking-tight">By person</h2>
          <ul className="ios-card divide-y divide-ios-separator overflow-hidden">
            {personTotals.map((person) => {
              const expanded = expandedSpenderId === person.personId;
              return (
                <li key={person.personId}>
                  <div className="flex min-h-[3.25rem] items-center gap-3 px-4 py-2.5">
                    <span className="min-w-0 flex-1">
                      <NameToggle
                        name={person.name}
                        expanded={expanded}
                        onClick={() => setExpandedSpenderId(expanded ? null : person.personId)}
                      />
                      <span className="block truncate text-[13px] text-ios-label-2">
                        Paid {formatPrice(person.paid)}
                      </span>
                    </span>
                    <span className="flex-none text-[15px] font-semibold tabular-nums">
                      {formatPrice(person.spent)}
                    </span>
                  </div>
                  {expanded ? (
                    <>
                      <p className="px-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ios-label-3">
                        Paid
                      </p>
                      <PersonEntries
                        entries={trip.entries.filter((entry) => entry.paidById === person.personId)}
                      />
                      <p className="px-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ios-label-3">
                        Their share
                      </p>
                      <PersonShares entries={trip.entries} personId={person.personId} />
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="px-1 pt-1.5 text-[12px] text-ios-label-3">
            Spent is each person&apos;s own share of the trip; paid is what they handed over.
          </p>
        </section>
      ) : null}

      <section>
        <button
          type="button"
          onClick={() => setBalanceOpen((open) => !open)}
          aria-expanded={balanceOpen}
          className="flex w-full items-center justify-between gap-3 px-1 pb-2"
        >
          <h2 className="text-[20px] font-semibold tracking-tight">Balance</h2>
          <span className="flex flex-none items-center gap-1.5">
            {/* Says whether anything is owed, so the folded section isn't a blank. */}
            <span
              className={`text-[13px] font-medium ${trip.transfers.length === 0 ? "text-ios-green" : "text-ios-red"}`}
            >
              {trip.transfers.length === 0
                ? trip.entries.length === 0
                  ? ""
                  : "Settled"
                : `${trip.transfers.length} pending`}
            </span>
            <svg
              viewBox="0 0 24 24"
              className={`h-4 w-4 flex-none text-ios-label-3 transition-transform ${balanceOpen ? "rotate-180" : ""}`}
              aria-hidden
            >
              <path
                d="M6 9l6 6 6-6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </button>
        {!balanceOpen ? null : trip.balances.length === 0 ? (
          <p className="ios-card p-5 text-[15px] text-ios-label-2">
            {trip.entries.length === 0
              ? "Add an expense to get started."
              : "Fully settled — no pending payments on this trip."}
          </p>
        ) : (
          <ul className="ios-card divide-y divide-ios-separator overflow-hidden">
            {trip.balances.flatMap((balance) => {
              const expanded = expandedPersonId === balance.personId;
              const paidEntries = trip.entries.filter((entry) => entry.paidById === balance.personId);
              const toggle = () => setExpandedPersonId(expanded ? null : balance.personId);

              if (balance.net > 0) {
                return (
                  <li key={balance.personId}>
                    <div className="flex min-h-[3.25rem] items-center gap-3 px-4 py-2.5">
                      <NameToggle name={balance.personName} expanded={expanded} onClick={toggle} />
                      <span className="flex-none text-[15px] font-semibold tabular-nums text-ios-green">
                        {formatPrice(balance.net)} to receive
                      </span>
                    </div>
                    {expanded ? <PersonEntries entries={paidEntries} /> : null}
                  </li>
                );
              }

              // Each debt this person still owes — usually just one, but the
              // debt-minimising split can leave someone owing two different
              // people, so a settle icon goes with each one.
              const debts = trip.transfers.filter((transfer) => transfer.fromPersonId === balance.personId);
              if (debts.length === 0) {
                return (
                  <li key={balance.personId}>
                    <div className="flex min-h-[3.25rem] items-center gap-3 px-4 py-2.5">
                      <NameToggle name={balance.personName} expanded={expanded} onClick={toggle} />
                      <span className="flex-none text-[15px] font-semibold tabular-nums text-ios-red">
                        {formatPrice(Math.abs(balance.net))} pending
                      </span>
                    </div>
                    {expanded ? <PersonEntries entries={paidEntries} /> : null}
                  </li>
                );
              }

              return debts.map((transfer, index) => (
                <li key={`${balance.personId}-${transfer.toPersonId}`}>
                  <div className="flex min-h-[3.25rem] items-center gap-2 px-4 py-2.5">
                    <button
                      type="button"
                      onClick={() => setSettling(transfer)}
                      aria-label={`Settle up: ${transfer.fromName} pays ${transfer.toName}`}
                      title="Settle up"
                      className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-ios-blue text-white active:scale-95"
                    >
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden>
                        <path
                          d="M5 12.5l4.5 4.5L19 7"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                    <NameToggle
                      name={`${transfer.fromName} pending to ${transfer.toName}`}
                      expanded={expanded}
                      onClick={toggle}
                    />
                    <span className="flex-none text-[15px] font-semibold tabular-nums text-ios-red">
                      {formatPrice(transfer.amount)}
                    </span>
                  </div>
                  {expanded && index === 0 ? <PersonEntries entries={paidEntries} /> : null}
                </li>
              ));
            })}
          </ul>
        )}
      </section>

      <section>
        <h2 className="px-1 pb-2 text-[20px] font-semibold tracking-tight">Expenses</h2>
        {trip.entries.length > 0 ? (
          <div className="flex gap-2 pb-2">
            <button
              type="button"
              onClick={() => setOpenFilter("friend")}
              className={`h-9 flex-1 truncate rounded-full px-3.5 text-[13px] font-medium transition active:scale-95 ${
                friendFilter !== undefined
                  ? "bg-ios-blue text-white"
                  : "bg-ios-surface-2 text-ios-label-2 ring-1 ring-inset ring-ios-separator"
              }`}
            >
              {/* Unfiltered, the pill says how many friends are on the trip. */}
              {friendFilter === undefined
                ? `All friends - ${trip.participants.length}`
                : (selectedOption(friendFilterOptions, friendFilter)?.label ?? "Friend")}
            </button>
            <button
              type="button"
              onClick={() => setOpenFilter("category")}
              className={`h-9 flex-1 truncate rounded-full px-3.5 text-[13px] font-medium transition active:scale-95 ${
                categoryFilter !== undefined
                  ? "bg-ios-blue text-white"
                  : "bg-ios-surface-2 text-ios-label-2 ring-1 ring-inset ring-ios-separator"
              }`}
            >
              {selectedOption(categoryFilterOptions, categoryFilter)?.label ?? "Category"}
            </button>
          </div>
        ) : null}
        {days.length === 0 ? (
          <p className="ios-card p-6 text-center text-[15px] text-ios-label-2">
            {friendFilter !== undefined || categoryFilter !== undefined
              ? "No expenses match this filter."
              : "Nothing logged for this trip yet."}
          </p>
        ) : (
          <div className="space-y-4">
            {days.map(([day, entries]) => (
              <div key={day}>
                <p className="px-1 pb-1.5 text-[13px] font-semibold uppercase tracking-wide text-ios-label-3">
                  {formatIsoDate(`${day}T12:00:00.000Z`)}
                </p>
                <ul className="ios-card divide-y divide-ios-separator overflow-hidden">
                  {entries.map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        onClick={() => setEntrySheet({ open: true, entry })}
                        className="ios-row w-full text-left active:bg-ios-surface-2"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[16px] font-medium">
                            {entry.note?.trim() || entry.categoryNameEn}
                          </span>
                          <span className="block truncate text-[13px] text-ios-label-2">
                            {entry.categoryNameEn}
                            {entry.paidByName ? ` · ${entry.paidByName} paid` : ""}
                          </span>
                        </span>
                        {entry.shares.length > 0 && entry.shares.length !== trip.participants.length ? (
                          <span className="flex-none rounded-full bg-ios-surface-2 px-2 py-0.5 text-[11px] font-medium text-ios-label-2 ring-1 ring-inset ring-ios-separator">
                            split {entry.shares.length}
                          </span>
                        ) : null}
                        <span className="flex-none text-[15px] font-semibold tabular-nums">
                          {formatPrice(entry.amount)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      {trip.settlements.length > 0 ? (
        <section>
          <h2 className="px-1 pb-2 text-[20px] font-semibold tracking-tight">Settled</h2>
          <ul className="ios-card divide-y divide-ios-separator overflow-hidden">
            {trip.settlements.map((settlement) => (
              <li key={settlement.id} className="ios-row">
                <span className="min-w-0 flex-1 truncate text-[15px]">
                  {settlement.fromName} paid {settlement.toName}
                </span>
                <span className="flex-none text-[15px] font-semibold tabular-nums">
                  {formatPrice(settlement.amount)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {entrySheet.open ? (
        <EntrySheet
          entry={entrySheet.entry}
          month={monthShim}
          defaultTripId={entrySheet.entry ? undefined : trip.id}
          onClose={() => setEntrySheet({ open: false, entry: null })}
          onDelete={isAdmin && entrySheet.entry ? () => remove(entrySheet.entry as ExpenseDTO) : undefined}
        />
      ) : null}

      <Sheet open={downloadOpen} onClose={() => setDownloadOpen(false)} title="Download or share">
        <ul className="mb-3 divide-y divide-ios-separator overflow-hidden rounded-ios bg-ios-surface-2">
          {[
            { label: "PDF", hint: "To print or share", busy: pdfBusy, run: exportPdf },
            { label: "Excel", hint: "To sort, filter and total", busy: excelBusy, run: exportExcel },
          ].map((option) => (
            <li key={option.label}>
              <button
                type="button"
                disabled={option.busy}
                onClick={() => {
                  setDownloadOpen(false);
                  void option.run();
                }}
                className="flex h-14 w-full items-center justify-between px-4 text-left active:bg-ios-surface disabled:opacity-50"
              >
                <span className="text-[15px] font-medium text-ios-blue">
                  {option.busy ? `Preparing ${option.label}…` : option.label}
                </span>
                <span className="text-[13px] text-ios-label-3">{option.hint}</span>
              </button>
            </li>
          ))}
          <li>
            <a
              href={whatsappHref}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setDownloadOpen(false)}
              className="flex h-14 w-full items-center justify-between px-4 text-left active:bg-ios-surface"
            >
              <span className="text-[15px] font-medium text-[#1DA851]">WhatsApp message</span>
              <span className="text-[13px] text-ios-label-3">Send to the group</span>
            </a>
          </li>
        </ul>
      </Sheet>

      <TripMenuSheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        isAdmin={isAdmin}
        closed={trip.closedAt !== null}
        pending={pending}
        onEdit={() => {
          setMenuOpen(false);
          setEditOpen(true);
        }}
        onToggleClosed={() => {
          setMenuOpen(false);
          toggleClosed();
        }}
        onDelete={removeTrip}
      />

      <FilterSheet
        open={openFilter === "friend"}
        onClose={() => setOpenFilter(null)}
        label="Filter by friend"
        options={friendFilterOptions}
        value={friendFilter}
        onChange={setFriendFilter}
      />

      <FilterSheet
        open={openFilter === "category"}
        onClose={() => setOpenFilter(null)}
        label="Filter by category"
        options={categoryFilterOptions}
        value={categoryFilter}
        onChange={setCategoryFilter}
      />

      <EditTripSheet open={editOpen} trip={trip} onClose={() => setEditOpen(false)} />

      <SettleTripSheet
        tripId={trip.id}
        transfer={settling}
        pending={pending}
        onClose={() => setSettling(null)}
        onSettle={(amount) => {
          const transfer = settling;
          if (!transfer) return;
          startTransition(async () => {
            const result = await settleTrip({
              tripId: trip.id,
              fromPersonId: transfer.fromPersonId,
              toPersonId: transfer.toPersonId,
              amount,
            });
            if (!result.ok) {
              setError(result.error);
              return;
            }
            setSettling(null);
            router.refresh();
          });
        }}
      />
    </div>
  );
}

/**
 * Everything about the trip itself, rather than its expenses: editing it,
 * closing or deleting it, plus the app-wide dark mode and admin controls —
 * one burger button instead of a header full of icons.
 */
function TripMenuSheet({
  open,
  onClose,
  isAdmin,
  closed,
  pending,
  onEdit,
  onToggleClosed,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  isAdmin: boolean;
  closed: boolean;
  pending: boolean;
  onEdit: () => void;
  onToggleClosed: () => void;
  onDelete: () => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="Trip options">
      <div className="space-y-4 pb-3">
        <ul className="divide-y divide-ios-separator overflow-hidden rounded-ios bg-ios-surface-2">
          <li>
            <button
              type="button"
              onClick={onEdit}
              className="flex h-12 w-full items-center px-4 text-left text-[15px] font-medium text-ios-blue active:bg-ios-surface"
            >
              Edit trip
            </button>
          </li>
          <li>
            <button
              type="button"
              onClick={onToggleClosed}
              disabled={pending}
              className="flex h-12 w-full items-center px-4 text-left text-[15px] font-medium text-ios-blue active:bg-ios-surface disabled:opacity-50"
            >
              {closed ? "Reopen trip" : "Close trip"}
            </button>
          </li>
          {isAdmin ? (
            <li>
              <button
                type="button"
                onClick={onDelete}
                disabled={pending}
                className="flex h-12 w-full items-center px-4 text-left text-[15px] font-medium text-ios-red active:bg-ios-surface disabled:opacity-50"
              >
                Delete trip
              </button>
            </li>
          ) : null}
        </ul>

        <ul className="divide-y divide-ios-separator overflow-hidden rounded-ios bg-ios-surface-2">
          <li className="flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="text-[15px] font-medium">Dark mode</span>
            <ThemeToggle />
          </li>
          <li className="flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="text-[15px] font-medium">Admin</span>
            <AdminLoginButton />
          </li>
        </ul>
      </div>
    </Sheet>
  );
}

/** The tappable name (or "X pending to Y") on a balance row — unfolds that person's own entries. */
function NameToggle({
  name,
  expanded,
  onClick,
}: {
  name: string;
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      className="flex min-w-0 flex-1 items-center gap-1 text-left active:opacity-60"
    >
      <span className="min-w-0 truncate text-[16px] font-medium">{name}</span>
      <svg
        viewBox="0 0 24 24"
        className={`h-3.5 w-3.5 flex-none text-ios-label-3 transition-transform ${expanded ? "rotate-180" : ""}`}
        aria-hidden
      >
        <path
          d="M6 9l6 6 6-6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/** What a balance row unfolds into — the entries that person paid for on this trip. */
function PersonEntries({ entries }: { entries: ExpenseDTO[] }) {
  if (entries.length === 0) {
    return (
      <p className="px-4 pb-3 text-[13px] text-ios-label-3">Didn&apos;t pay for anything on this trip.</p>
    );
  }
  return (
    <ul className="space-y-1 px-4 pb-3">
      {entries.map((entry) => (
        <li key={entry.id} className="flex items-center justify-between gap-3 text-[13px] text-ios-label-2">
          <span className="min-w-0 truncate">{entry.note?.trim() || entry.categoryNameEn}</span>
          <span className="flex-none tabular-nums">{formatPrice(entry.amount)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A By person row's second list — every expense this person was part of, at
 * their own share of it. An unsplit entry is wholly its payer's, the same rule
 * tripPersonTotals uses, so these add up to the row's spent figure.
 */
function PersonShares({ entries, personId }: { entries: ExpenseDTO[]; personId: number }) {
  const rows = entries.flatMap((entry) => {
    const share = entry.shares.find((candidate) => candidate.personId === personId);
    if (share) return [{ entry, amount: share.amount }];
    if (entry.shares.length === 0 && entry.paidById === personId) return [{ entry, amount: entry.amount }];
    return [];
  });
  if (rows.length === 0) {
    return <p className="px-4 pb-3 text-[13px] text-ios-label-3">No share in any expense on this trip.</p>;
  }
  return (
    <ul className="space-y-1 px-4 pb-3">
      {rows.map(({ entry, amount }) => (
        <li key={entry.id} className="flex items-center justify-between gap-3 text-[13px] text-ios-label-2">
          <span className="min-w-0 truncate">{entry.note?.trim() || entry.categoryNameEn}</span>
          <span className="flex-none tabular-nums">{formatPrice(amount)}</span>
        </li>
      ))}
    </ul>
  );
}

/** What a category row unfolds into — the entries filed under it on this trip. */
function CategoryEntries({ entries }: { entries: ExpenseDTO[] }) {
  if (entries.length === 0) {
    return <p className="px-4 pb-3 text-[13px] text-ios-label-3">No expenses in this category yet.</p>;
  }
  return (
    <ul className="space-y-1 px-4 pb-3">
      {entries.map((entry) => (
        <li key={entry.id} className="flex items-center justify-between gap-3 text-[13px] text-ios-label-2">
          <span className="min-w-0 truncate">
            {entry.note?.trim() || entry.categoryNameEn}
            {entry.paidByName ? ` · ${entry.paidByName} paid` : ""}
          </span>
          <span className="flex-none tabular-nums">{formatPrice(entry.amount)}</span>
        </li>
      ))}
    </ul>
  );
}

function EditTripSheet({
  open,
  trip,
  onClose,
}: {
  open: boolean;
  trip: TripDetailDTO;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(trip.name);
  const [participantIds, setParticipantIds] = useState<number[]>(
    trip.participants.map((person) => person.id),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Friends hidden from the list don't come back as trip options — unless
  // they are already on this trip, so they can still be taken off it.
  const pickable = trip.people.filter(
    (person) => person.isActive || trip.participants.some((participant) => participant.id === person.id),
  );

  const save = () => {
    startTransition(async () => {
      const result = await updateTrip({ id: trip.id, name, participantIds });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Edit trip"
      footer={
        <button
          type="button"
          onClick={save}
          disabled={pending || !name.trim() || participantIds.length === 0}
          className="flex h-12 w-full items-center justify-center rounded-ios bg-ios-blue text-[17px] font-semibold text-white active:scale-[0.98] disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save changes"}
        </button>
      }
    >
      <div className="space-y-4 pb-3">
        {error ? <p className="text-[14px] text-ios-red">{error}</p> : null}
        <div>
          <span className="block pb-1.5 text-[13px] font-medium text-ios-label-2">Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="Trip name"
            className="h-12 w-full rounded-ios bg-ios-surface-2 px-4 text-[16px] outline-none ring-1 ring-inset ring-ios-separator focus:ring-2 focus:ring-ios-blue"
          />
        </div>
        <div>
          <span className="block pb-1.5 text-[13px] font-medium text-ios-label-2">Who&apos;s on it</span>
          <div className="flex flex-wrap gap-2">
            {pickable.map((person) => {
              const active = participantIds.includes(person.id);
              return (
                <button
                  key={person.id}
                  type="button"
                  onClick={() =>
                    setParticipantIds((current) =>
                      current.includes(person.id)
                        ? current.filter((id) => id !== person.id)
                        : [...current, person.id],
                    )
                  }
                  className={`h-9 rounded-full px-3.5 text-[14px] font-medium transition active:scale-95 ${
                    active
                      ? "bg-ios-blue text-white"
                      : "bg-ios-surface-2 text-ios-label-2 ring-1 ring-inset ring-ios-separator"
                  }`}
                >
                  {person.name}
                </button>
              );
            })}
          </div>
          <p className="pt-1.5 text-[12px] text-ios-label-3">
            Removing someone who already has a share on this trip is refused — fix that expense first.
          </p>
        </div>
      </div>
    </Sheet>
  );
}

function SettleTripSheet({
  tripId,
  transfer,
  pending,
  onClose,
  onSettle,
}: {
  tripId: number;
  transfer: TransferDTO | null;
  pending: boolean;
  onClose: () => void;
  onSettle: (amount: number) => void;
}) {
  const [amount, setAmount] = useState("");
  const value = Number.parseFloat(amount || String(transfer?.amount ?? 0));

  return (
    <Sheet
      open={transfer !== null}
      onClose={onClose}
      title="Settle up"
      subtitle={transfer ? `${transfer.fromName} pays ${transfer.toName}, for this trip` : undefined}
      footer={
        <button
          type="button"
          disabled={pending || !Number.isFinite(value) || value <= 0}
          onClick={() => onSettle(value)}
          className="flex h-12 w-full items-center justify-center rounded-ios bg-ios-blue text-[17px] font-semibold text-white active:scale-[0.98] disabled:opacity-50"
        >
          {pending ? "Saving…" : "Record payment"}
        </button>
      }
    >
      <div className="space-y-3 pb-3">
        <div className="flex items-center rounded-ios bg-ios-surface-2 px-3 ring-1 ring-inset ring-ios-separator focus-within:ring-2 focus-within:ring-ios-blue">
          <span className="text-[20px] font-semibold text-ios-label-2">₹</span>
          <input
            autoFocus
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder={transfer ? String(transfer.amount) : "0.00"}
            aria-label="Amount settled"
            className="h-12 w-full bg-transparent px-2 text-[20px] font-semibold tabular-nums outline-none"
          />
        </div>
      </div>
    </Sheet>
  );
}
