/** Fills the applicant's recruiter-message template. Shared by the Outreach tab (preview) and the server (the approve check). */
export type OutreachSlots = {
  recruiter: string | null; company: string; roles: { role: string; submittedAt: number }[]; overlap: string | null;
  now: number; timeZone?: string;
};

const list = (items: string[]) => items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
const day = (at: number, timeZone?: string) => new Date(at).toLocaleDateString('en-CA', { timeZone });

/**
 * {Name} {Company} {Role} {Roles} {When} {Overlap} are filled here; a slot with no value, and any other slot
 * ({City}, {Team}), stays in braces for the applicant to fill, and `unfilledSlots` blocks the send until it is.
 */
export function renderOutreach(template: string, slots: OutreachSlots) {
  const names = slots.roles.map((item) => item.role);
  const latest = Math.max(...slots.roles.map((item) => item.submittedAt));
  // "today" only when every application went out on the reader's current day.
  const today = slots.roles.every((item) => day(item.submittedAt, slots.timeZone) === day(slots.now, slots.timeZone));
  const values: Record<string, string | null> = {
    Name: slots.recruiter?.trim().split(/\s+/)[0] || null, Company: slots.company,
    Role: names.length ? list(names) : null,
    Roles: names.length ? `the ${list(names)} ${names.length > 1 ? 'roles' : 'role'}` : null,
    When: !names.length ? null : today ? 'today'
      : `on ${new Date(latest).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: slots.timeZone })}`,
    Overlap: slots.overlap?.trim() || null,
  };
  return template.replace(/\{(\w+)\}/g, (slot, name: string) => values[name] ?? slot);
}

/** Anything still in braces, such as "{City}" or a pasted instruction, and any stray brace: none of it may reach a recruiter. */
export const unfilledSlots = (text: string) =>
  [...new Set((text.match(/\{[^{}]*\}|[{}]/g) ?? []).map((slot) => slot.length > 40 ? `${slot.slice(0, 39)}...}` : slot))];
