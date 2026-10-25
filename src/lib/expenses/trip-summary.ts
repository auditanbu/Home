import { toPaise, toRupees } from "./balances";
import type { TripDetailDTO } from "./types";

/** One person's side of a trip: what they handed over, and what was theirs. */
export type PersonTotal = {
  personId: number;
  name: string;
  /** Money this person fronted for the group. */
  paid: number;
  /** Their own part of the trip's cost — what the trip actually cost them. */
  spent: number;
  /** Positive: owed to them. Negative: they owe. Zero once settled. */
  net: number;
};

/**
 * What each person on the trip spent and paid, roster order first.
 *
 * "Spent" is the sum of a person's shares; an entry with no shares belongs
 * wholly to whoever paid it — the same reading the balance takes. Worked in
 * paise so the per-person figures add back up to the trip total exactly.
 */
export function tripPersonTotals(trip: TripDetailDTO): PersonTotal[] {
  const rows = new Map<number, { name: string; paid: number; spent: number }>();
  const row = (personId: number, name: string | null) => {
    let current = rows.get(personId);
    if (!current) {
      current = { name: name ?? "Someone", paid: 0, spent: 0 };
      rows.set(personId, current);
    }
    return current;
  };

  for (const person of trip.participants) row(person.id, person.name);

  for (const entry of trip.entries) {
    const amount = toPaise(entry.amount);
    if (entry.paidById !== null) row(entry.paidById, entry.paidByName).paid += amount;
    if (entry.shares.length > 0) {
      for (const share of entry.shares) row(share.personId, share.personName).spent += toPaise(share.amount);
    } else if (entry.paidById !== null) {
      row(entry.paidById, entry.paidByName).spent += amount;
    }
  }

  const net = new Map(trip.balances.map((balance) => [balance.personId, balance.net]));
  return [...rows.entries()].map(([personId, { name, paid, spent }]) => ({
    personId,
    name,
    paid: toRupees(paid),
    spent: toRupees(spent),
    net: net.get(personId) ?? 0,
  }));
}

/** "20 Oct 2026" — how the trip statement (PDF and Excel) prints a date. */
export function formatTripDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

/**
 * "20 Oct 2026 to 22 Oct 2026 (3 days)" — the first and last expense dates,
 * which is when the trip actually ran; closing it can come days later.
 */
export function tripDatesLabel(trip: TripDetailDTO): string {
  if (trip.entries.length === 0) return "";
  const times = trip.entries.map((entry) => Date.parse(entry.spentAt));
  const first = new Date(Math.min(...times));
  const last = new Date(Math.max(...times));
  const dayOf = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((dayOf(last) - dayOf(first)) / 86_400_000) + 1;
  const range =
    days === 1
      ? formatTripDate(first.toISOString())
      : `${formatTripDate(first.toISOString())} to ${formatTripDate(last.toISOString())}`;
  return `${range} (${days} day${days === 1 ? "" : "s"})`;
}
