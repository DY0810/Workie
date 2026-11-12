/**
 * Deterministic extraction — no model, no network, no cost.
 *
 * Precedence is the whole design:
 *
 *   structured field from the source  >  the posting's own text  >  null
 *
 * and within the text the TITLE outranks the body, because a title states what the role is
 * while a body merely mentions things ("internships count" sits in the requirements of a
 * full-time posting). `track` is the one field that reads title -> department/team -> body
 * rather than putting the structured field first: a title is a stronger signal of the role
 * than the org chart it hangs off, and "Platform Engineer" in a Sales department is still an
 * engineer. Each extractor names its own order where it differs.
 *
 * Never guess past that. NULL means "the posting did not say", which is a real answer the UI
 * knows how to render (finding G); a guessed value is indistinguishable from a stated one
 * and is worse than nothing.
 *
 * The reason this is viable at all is `SourceFields`: Ashby returns `employmentType`,
 * `workplaceType` and a postal address, Lever returns `categories.commitment` and an
 * already-structured `lists[]`, Greenhouse returns `departments[]` and `offices[]`. Parsing
 * that back out of prose when the API handed it to us as a field is absurd, so the
 * connectors preserve it and this module reads it first (see `ConnectorPosting`).
 *
 * Extraction is free and deterministic, so there is no cache: re-running is correct and
 * cheap, and a cache would only mean that changing a rule here silently serves the old
 * answer forever.
 */

import { decodeHtmlEntities, normalizeDescription, withoutNegatedRemote } from './normalize.ts';
import { isVoiceRole, VOICE_BADGE } from './voice.ts';

export type Track = 'design' | 'engineering';
export type Seniority = 'entry' | 'junior' | 'mid' | 'senior+';
export type EmploymentType = 'full-time' | 'part-time' | 'contract' | 'freelance' | 'internship';
export type WorkMode = 'remote' | 'hybrid' | 'onsite';
export type Season = 'summer' | 'fall' | 'winter' | 'spring';
export type PayPeriod = 'hour' | 'week' | 'month' | 'year';
export type CurrencySymbol = '$' | '€' | '£';

/** A heading plus its bullets, as the source itself structured them. */
export interface Section {
  heading: string;
  items: string[];
}

/**
 * What a connector preserved from its API response. Every field is optional: aggregators and
 * RSS feeds mostly cannot fill these, which is fine — extraction falls back to the text.
 */
export interface SourceFields {
  employmentType?: EmploymentType;
  workMode?: WorkMode;
  /** Display string, assembled from the source's own location parts. */
  location?: string;
  department?: string;
  team?: string;
  sections?: Section[];
}

export interface ExtractInput {
  title: string;
  /** Already through `normalizeDescription`: tags stripped, entities decoded, space collapsed. */
  description: string | null | undefined;
  /** What the connector preserved from the source API. Read before the prose, always. */
  sourceFields?: SourceFields | null;
}

export interface PayRate {
  min: number | null;
  max: number | null;
  period: PayPeriod | null;
  /** Omitted for dollars so existing stored/test shapes remain backward-compatible. */
  currencySymbol?: CurrencySymbol;
}

export interface Extraction {
  /** `other` is not a tab. `toStored` drops it rather than storing it. */
  track: Track | 'other';
  seniority: Seniority;
  employment_type: EmploymentType | null;
  internship_season: Season | null;
  paid: boolean | null;
  work_mode: WorkMode | null;
  location: string | null;
  pay_rate: PayRate | null;
  expected_grad: string | null;
  /** Engineering only — the Design tab has no summary column. */
  summary: string | null;
  responsibilities: string[];
  skills: string[];
  education: string[];
  badges: string[];
}

/**
 * What actually reaches `postings`. `track` is narrowed — `other` is still dropped — but
 * `seniority` is NOT, because Design now stores `senior+`. See `toStored`.
 */
export interface StoredExtraction extends Omit<Extraction, 'track'> {
  track: Track;
}

/** Badges are filter chips, not free text. */
export const ALLOWED_BADGES: readonly string[] = [
  'new-grad',
  'internship',
  'visa-sponsorship',
  'no-degree-required',
  'portfolio-required',
  'security-clearance',
];

/**
 * Regex safety valve. A pathological 200KB posting decides nothing that the first 40k chars
 * did not, and an unbounded body is how a backtracking pattern turns into a hung run.
 */
export const MAX_DESCRIPTION_CHARS = 40_000;

const MAX_BULLETS = 6;
const MAX_BULLET_CHARS = 240;

// ---------------------------------------------------------------------------------------
// Sections — parsed once, in the connector, where the markup still exists
// ---------------------------------------------------------------------------------------

/**
 * `normalizeDescription` collapses every newline and strips every bullet marker, so by the
 * time a body reaches the database its list structure is gone. Sections therefore have to be
 * parsed at the connector boundary, from the HTML or markdown the source actually returned,
 * and carried alongside the normalized text.
 *
 * Handles both shapes because the Tier-1 families disagree: Greenhouse returns escaped HTML,
 * Workable and Ashby return HTML, Ashby's "plain" text is really markdown.
 */
export function parseSections(raw: string | null | undefined, defaultHeading = ''): Section[] {
  const text = decodeHtmlEntities(raw ?? '').slice(0, MAX_DESCRIPTION_CHARS);
  if (!text.trim()) return [];
  return /<(?:li|h[1-6]|p|ul|div)\b/i.test(text)
    ? parseHtmlSections(text, defaultHeading)
    : parseMarkdownSections(text, defaultHeading);
}

/** `<h3>Heading</h3> … <li>item</li>`, plus the `<p><strong>Heading</strong></p>` variant. */
const HTML_TOKEN =
  /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>|<li[^>]*>([\s\S]*?)<\/li>|<p[^>]*>\s*<(strong|b)[^>]*>([\s\S]*?)<\/\4>\s*<\/p>/gi;

function parseHtmlSections(html: string, defaultHeading: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const match of html.matchAll(HTML_TOKEN)) {
    const item = match[3];
    if (item !== undefined) {
      const value = plain(item);
      if (!value) continue;
      // Bullets before any heading are the section, not noise. Lever puts the heading in
      // `list.text` and the bullets alone in `list.content`, and SmartRecruiters hands over a
      // bare `<ul>`; requiring a heading token first returned [] for both, so every Lever and
      // SmartRecruiters posting stored `sections: []` and had empty responsibilities/skills.
      if (!current) {
        current = { heading: defaultHeading, items: [] };
        sections.push(current);
      }
      current.items.push(value);
      continue;
    }
    const heading = plain(match[2] ?? match[5] ?? '');
    if (!heading || heading.length > 120) continue;
    current = { heading, items: [] };
    sections.push(current);
  }
  return sections.filter((section) => section.items.length > 0);
}

/** `## Heading` / `**Heading**` followed by `- item` lines. */
function parseMarkdownSections(markdown: string, defaultHeading: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      const value = plain(bullet[1]);
      if (!value) continue;
      // Same rule as the HTML parser: a list that opens without a heading is still a list.
      if (!current) {
        current = { heading: defaultHeading, items: [] };
        sections.push(current);
      }
      current.items.push(value);
      continue;
    }
    const heading = /^\s*(?:#{1,6}\s*(.+?)|\*\*(.+?)\*\*|(.{3,80}?):)\s*$/.exec(line);
    const value = heading ? plain(heading[1] ?? heading[2] ?? heading[3] ?? '') : '';
    if (value) {
      current = { heading: value, items: [] };
      sections.push(current);
    }
  }
  return sections.filter((section) => section.items.length > 0);
}

function plain(fragment: string): string {
  return normalizeDescription(fragment).slice(0, MAX_BULLET_CHARS * 2);
}

// ---------------------------------------------------------------------------------------
// Seniority
// ---------------------------------------------------------------------------------------

/**
 * Seniority words matched against the TITLE only. "you will lead the redesign" and "reports
 * to the design manager" are ordinary body prose; in a title the same words are decisive.
 * `\b` keeps "lead" out of "leadership" and "sr" out of "usr".
 */
const SENIOR_TITLE =
  /\b(?:senior|sr|snr|staff|principals?|lead(?:er)?s?|directors?|managers?|head\s+of|chief|vp|vice\s+president|architects?|distinguished|fellows?)\b/i;

/**
 * "Member of Technical Staff" is a mid-level individual-contributor title, not a staff
 * engineer — and it is precisely the shape voice-AI roles come in, which is why the plan
 * names it twice. Strip the phrase before matching — from the BODY as well as the title,
 * because "We're looking for a Member of Technical Staff" otherwise trips the "looking for a
 * staff engineer" prose rule. "Senior Member of Technical Staff" still trips `senior`, so
 * nothing leaks.
 */
const TITLE_FALSE_FRIENDS = /\bmembers?\s+of\s+(?:the\s+)?technical\s+staff\b/gi;

/**
 * Years of experience, matched against title AND body, where the phrase actually appears.
 *
 * The capture is the LOW end of the requirement, because a range has to be read from its
 * start: "2-5 years" is the standard way to write a mid-level ask and must be kept, while
 * "5+ years" and "10 years" are senior. Matching the tail of the range instead — which a
 * bare `\b[5-9]` does, since a hyphen is a word boundary — silently drops most mid roles.
 *
 * DO NOT "fix" this to read the end of the range. It was found and fixed once already, and
 * `extract.test.ts` pins "2-5 years" to mid and "5-7 years" to senior for that reason.
 *
 * A years figure only counts when an experience cue sits next to it. Measured on the real
 * corpus, the bare pattern read "Before founding Sierra, Clay spent 18 years at Google" and
 * "8 years ago, Jeremy was frustrated with..." as senior requirements — company boilerplate
 * that repeats on every posting those companies publish. `EXPERIENCE_CUE` is the fix the
 * earlier version's comment promised: require the word, do not loosen the number.
 */
const YEARS_OF_EXPERIENCE = /\b(\d{1,2})(?:\s*(?:-|–|—|to|or)\s*(\d{1,2}))?\s*\+?\s*(?:years|yrs)\b/gi;

/** What turns "8 years" into "8 years of experience" rather than "8 years ago". */
const EXPERIENCE_CUE =
  /\b(?:experience|expertise|background|qualification|requirement|minimum|at\s+least|professional|industry|hands[\s-]on|track\s+record)\b/i;

/**
 * A gerund only means experience when it sits DIRECTLY after the figure — "5 years building
 * distributed systems". Allowed anywhere in the window, gerunds match ordinary company
 * boilerplate: "Founded 8 years ago, we are building the future" and "spent 18 years at
 * Google leading search" both read as senior asks. Because `toStored` drops `senior+`
 * entirely, that does not mislabel a posting — it DELETES every junior and mid role those
 * companies publish, from both tabs, silently.
 */
const EXPERIENCE_GERUND =
  /^\s*(?:of\s+)?(?:experience\s+)?(?:working|building|shipping|developing|designing|engineering|leading|managing|writing|coding|programming)\b/i;
const CUE_WINDOW = 60;

/**
 * "One to three years" is as common as "1-3 years" and a digits-only pattern is blind to it.
 * Substituting the words for digits before the scan makes every years rule — including the
 * senior gate — see both spellings, for one line instead of a parallel set of patterns.
 */
const NUMBER_WORDS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
};
const NUMBER_WORD = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join('|')})\\b`, 'gi');

function withNumerals(text: string): string {
  return text.replace(NUMBER_WORD, (word) => NUMBER_WORDS[word.toLowerCase()] ?? word);
}

/** Every years-of-EXPERIENCE ask in the text, as `[low, high]` (high === low when unranged). */
function yearsAsked(text: string): [number, number][] {
  const normalized = withNumerals(text);
  const asks: [number, number][] = [];
  for (const match of normalized.matchAll(YEARS_OF_EXPERIENCE)) {
    const before = normalized.slice(Math.max(0, match.index - CUE_WINDOW), match.index);
    const after = normalized.slice(match.index + match[0].length, match.index + match[0].length + CUE_WINDOW);
    if (!EXPERIENCE_CUE.test(before) && !EXPERIENCE_CUE.test(after) && !EXPERIENCE_GERUND.test(after)) {
      continue;
    }
    const low = Number(match[1]);
    asks.push([low, match[2] === undefined ? low : Math.max(low, Number(match[2]))]);
  }
  return asks;
}

/** 5 or more years asked for, per the plan's `[5-9]+ years` / `\d{2}+ years` rule. */
const SENIOR_YEARS = 5;

/**
 * Body phrasings that mean "senior" without a senior title or a years figure — the recall
 * the two-layer design used to buy from the model. Each one has to be a phrase a junior
 * posting would not write; "ownership" and "impact" appear in every posting ever published
 * and are deliberately absent.
 */
const SENIOR_PROSE = [
  /\bset(?:ting|s)?\s+(?:the\s+)?technical\s+(?:direction|strategy|vision)\b/i,
  /\b(?:deep|extensive|significant|substantial|proven)\s+(?:domain\s+|technical\s+|industry\s+)?(?:expertise|experience)\s+(?:is\s+)?(?:expected|required)\b/i,
  /\byou(?:'| wi)ll\s+own\s+the\s+(?:roadmap|architecture|technical\s+direction|strategy|vision)\b/i,
  /\b(?:own|drive|define|shape)\s+(?:the\s+)?(?:technical|architectural|product|design)\s+(?:direction|strategy|vision|roadmap)\b/i,
  /\b(?:mentor|coach)(?:ing|s)?\s+(?:and\s+\w+\s+)?(?:junior|other|fellow|more\s+junior)\s+\w+/i,
  /\b(?:manage|lead|build)(?:s|ing)?\s+(?:and\s+grow(?:ing)?\s+)?(?:a\s+)?team\s+of\s+\w+/i,
  /\b(?:hire|hiring|grow(?:ing)?)\s+and\s+(?:mentor|develop|manage|lead)\b/i,
  /\breport(?:s|ing)?\s+(?:directly\s+)?to\s+the\s+(?:ceo|cto|founder|vp)\b/i,
  /\b(?:seasoned|highly\s+experienced|battle-tested)\s+(?:engineer|designer|developer|leader)\b/i,
  /\b(?:staff|principal|senior)[- ]level\b/i,
  /\b(?:tech(?:nical)?\s+lead|team\s+lead|engineering\s+lead|design\s+lead)\b/i,
  /\bplayer[- ]coach\b/i,
  // Measured leaks: "Member of Technical Staff" bodies that describe a staff-level IC.
  /\b(?:lead|drive|own)\s+(?:the\s+)?technical\s+design\b/i,
  /\bestablish(?:ing)?\s+(?:the\s+)?best\s+practices\b/i,
  /\bmentor(?:ing|s)?\s+(?:\w+\s+){0,2}(?:engineers?|designers?|developers?|teammates|the\s+team)\b/i,
  // "we're looking for a senior member for the Agent team". The subject has to be the ROLE:
  // "you will work with senior engineers" is what a junior posting says, and must not fire.
  /\b(?:seeking|hiring|looking\s+for|recruiting)\s+(?:an?\s+)?(?:\w+[,\s]+){0,3}(?:senior|staff|principal|experienced|seasoned)\b/i,
  /\bthis\s+is\s+an?\s+(?:\w+\s+){0,2}senior\b/i,
];

function requiresSeniorExperience(text: string): boolean {
  return yearsAsked(text).some(([low]) => low >= SENIOR_YEARS);
}

/**
 * True when a posting is senior and must never reach a tab. Callers pass the NORMALIZED body
 * so the patterns see text, not markup.
 *
 * This is the only gate on the strongest acceptance criterion in the plan — "no senior /
 * staff / principal / lead / director / manager row is visible in either tab" — now that
 * there is no model behind it. It is measured, not asserted: see the leak-rate table in the
 * PR body.
 */
export function isSeniorByRegex(
  title: string | null | undefined,
  normalizedDescription: string | null | undefined,
): boolean {
  const titleText = (title ?? '').replace(TITLE_FALSE_FRIENDS, ' ');
  if (SENIOR_TITLE.test(titleText)) return true;
  const body = (normalizedDescription ?? '')
    .slice(0, MAX_DESCRIPTION_CHARS)
    .replace(TITLE_FALSE_FRIENDS, ' ');
  if (requiresSeniorExperience(`${titleText} ${body}`)) return true;
  return SENIOR_PROSE.some((pattern) => pattern.test(body));
}

/** Entry: no professional experience is being asked for at all. */
/**
 * A structured-programme title. It BEATS a senior word in the same title: "Strategy Product
 * Manager Intern" is an internship, and reading `manager` first drops it as senior.
 */
const INTERNSHIP_TITLE =
  /\b(?:intern(?:ship)?s?|co-?ops?|apprentice(?:ship)?s?|trainees?|werkstudent(?:in)?|praktikant(?:in)?|praktikum|working\s+student)\b/i;
const ENTRY_TITLE = new RegExp(
  `${INTERNSHIP_TITLE.source}|\\b(?:new[\\s-]?(?:college\\s+)?grad(?:uate)?|early[\\s-]career|graduate\\s+(?:program|scheme|engineer|developer|designer|analyst)|entry[\\s-]level|university|campus|student|fellowship)\\b`,
  'i',
);
/**
 * Entry from the BODY has to describe the ROLE, not the audience: "new grads welcome" on an
 * early-career posting is an invitation, and the label for it is junior. A bare "new grad"
 * anywhere still earns the `new-grad` BADGE, which is where that signal belongs.
 */
const ENTRY_BODY =
  /\b(?:no\s+(?:prior\s+)?(?:professional\s+)?experience\s+(?:is\s+)?(?:required|necessary)|new[\s-]grad(?:uate)?s?\s+(?:role|position|program|scheme|rotation|hire)|(?:a|our|this)\s+graduate\s+(?:scheme|program(?:me)?|rotation)|currently\s+(?:enrolled|pursuing)|rising\s+(?:junior|senior)|0\s*(?:-|–|to)\s*1\s*years?|entry[\s-]level)\b/i;

const JUNIOR_TITLE = /\b(?:junior|jr\.?|associate|assistant|apprentice)\b/i;
/** The posting calls the ROLE junior in its body — "we are hiring a junior brand designer". */
const JUNIOR_BODY =
  /\b(?:junior|early[\s-]career|entry[\s-]level)\s+(?:\w+\s+){0,2}(?:designer|engineer|developer|researcher|analyst|scientist|role|position|hire)\b|\bearly[\s-]career\b/i;

/**
 * The junior/mid boundary, read from the START of the range like every other years rule
 * here: "1-3 years" is a junior ask, "2-5 years" is the standard way to write a mid one.
 */
const JUNIOR_YEARS = 1;

function extractSeniority(title: string, body: string): Seniority {
  if (INTERNSHIP_TITLE.test(title)) return 'entry';
  if (isSeniorByRegex(title, body)) return 'senior+';
  if (ENTRY_TITLE.test(title) || ENTRY_BODY.test(body)) return 'entry';
  if (JUNIOR_TITLE.test(title) || JUNIOR_BODY.test(body)) return 'junior';

  // The STRONGEST ask decides — a posting asking "3+ years in QA, 1+ years with game
  // engines" is a mid role, not a junior one — and each ask is still read from the START of
  // its range, so "2-5 years" stays mid. 5+ never reaches here; `isSeniorByRegex` returned.
  const lows = yearsAsked(body).map(([low]) => low);
  if (lows.length > 0) return Math.max(...lows) <= JUNIOR_YEARS ? 'junior' : 'mid';

  // ponytail: unknown lands on `mid`, the least flattering of the three visible bands. A
  // posting that says nothing about experience is far more often mid than entry, and sorting
  // it below the roles that did say "new grad" is the right default for this board.
  return 'mid';
}

// ---------------------------------------------------------------------------------------
// Track
// ---------------------------------------------------------------------------------------

/**
 * The highest-stakes field: anything that lands in neither tab is invisible, so a wrong
 * `other` is a deleted posting. Order is title -> department/team -> description, and the
 * veto runs first because "Sales Engineer" and "Design Program Manager" are GTM and PM roles
 * that happen to contain a track word.
 */
const TRACK_VETO =
  /\b(?:sales|account\s+(?:executive|manager|director)|business\s+development|brand\s+(?:development\s+)?(?:associate|manager)|brand\s+media\s+strategy|design\s+studio\s+process\s+manager|revenue|quota|marketing|brand\s+marketing|communications|public\s+relations|recruit\w*|talent|people\s+(?:ops|operations|partner)|human\s+resources|hr\b|finance|accounting|controller|legal|counsel|paralegal|compliance|policy|lobby\w*|customer\s+(?:success|support|experience)|technical\s+support|support\s+engineer|help\s+desk|solutions?\s+(?:consultant|architect|engineer|analyst|design\w*)|sales\s+engineer|pre-?sales|partnerships?|alliance\w*|procurement|facilities|ambassador|producer|enforcement|administrative|executive\s+assistant|office\s+manager|chief\s+of\s+staff|program\s+manager|project\s+manager|product\s+manager|operations\s+manager|engagement\s+(?:manager|lead)|general\s+manager|store\s+manager|employer\s+brand|(?:sales|partner|revenue|gtm|customer|field|technology)\s+enablement|enablement\s+(?:manager|lead|analyst|specialist)|strategist|buyer|purchaser|patent\w*|community\s+(?:manager|engagement)|product\s+management|product\s+marketing|produktmanage\w*|vertrieb\w*|scrum\s+master|trust\s+(?:and|&)\s+safety|content\s+(?:writer|strategist|marketer)|copywriter|social\s+media|community\s+manager|event\w*|teacher|instructor|nurse|physician|clinician|driver|warehouse|logistics|supply\s+chain)\b/i;

/** These role labels remain vetoes even when a parenthetical or suffix follows a technical head. */
const FULL_TITLE_ROLE_VETO =
  /\b(?:pre-?sales|solutions?\s+(?:consultant|architect|engineer|analyst|design\w*)|sales\s+engineer|technical\s+support|support\s+engineer|help\s+desk)\b/i;

/**
 * A title states its role first and qualifies it afterwards: "Machine Learning Engineer Intern
 * - Brand Ads" is an ML engineer, not a brand designer. So the design/engineering decision is
 * made on the HEAD of the title — everything before the first comma, bracket, pipe or spaced
 * dash — and only falls back to the whole string when the head decides nothing ("Intern -
 * Product Design").
 *
 * The dash must be spaced. Splitting on a bare hyphen would cut "Full-Stack Engineer" down to
 * "Full" and lose the role entirely.
 */
const TITLE_TAIL = /\s+[–—-]\s+|[,(|]/;

function titleHead(title: string): string {
  const head = title.split(TITLE_TAIL)[0]?.trim() ?? '';
  return head.length >= 3 ? head : title;
}

/**
 * Engineering role NOUNS, which outrank a design word in the same head: "Software Engineer,
 * Silicon Design Methodology" is an engineer.
 *
 * Deliberately excludes `scientist`, `researcher` and `architect`, which `ENGINEERING_TITLE`
 * still carries: "UX Researcher" and "Design Researcher" are design roles, and promoting those
 * words here would send every one of them to the wrong tab. This list is only the words that
 * cannot be anything but engineering.
 */
const ENGINEERING_ROLE = /\b(?:engineer(?:ing|s)?|developer|programmer|swe|sde|sdet)\b/i;

/**
 * Engineering that calls itself design. "Design" here means silicon, circuits, electrical work or
 * a datacenter — engineering in every case — and it was the largest source of wrong rows on the
 * Design tab: four NVIDIA hardware internships once led the board because "Hardware ASIC Design
 * Intern" reads as a design title.
 *
 * Grew twice, both times from rows the previous list missed rather than from imagination:
 * "NVIDIA 2027 Internships: Digital Circuit Design" (silicon, no ASIC/VLSI in the title),
 * "Electrical BIM Designer, DC Design Engineering" (datacenter electrical), and a team named
 * "Datacenter Design" on an OpenAI infrastructure role.
 *
 * Still scoped to terms that can only mean hardware, NOT the bare word `hardware`: "Hardware
 * Product Designer" is a real industrial-design role and stays on the Design tab.
 */
const HARDWARE_DESIGN =
  /\b(?:asic|vlsi|dft|rtl|soc|pcb|fpga|silicon|semiconductor|tapeout|verilog|vhdl|wafer|foundry|circuit|electrical|bim|datacent(?:er|re)|data\s+cent(?:er|re)|mixed[\s-]signal|physical\s+design|mechanical\s+design|route\s*(?:&|and)\s*motion\s+generation|design\s+for\s+test|chip\s+design\w*|analog|firmware)\b/i;

/**
 * Design disciplines this tool does not cover. Not a misclassification like the hardware terms
 * above — these really are design jobs — but the Design tab means product, visual and brand
 * design, and an interior designer answering a Revit brief is not competing for the same roles.
 *
 * They were 8 of 48 visible rows, mostly one staffing agency reposting the same architecture
 * briefs: "Remote Interior Designer - Revit & Design-Focused", "Remote Landscape Designer with
 * LandFX experience", "High-End Hotel Interior Design Specialist", "Remote Archicad expert for
 * Interior Design & Documentation".
 *
 * The AEC and mechanical CAD tool names are here because they are the most reliable signal in the
 * title — a posting that names Revit, Archicad or LandFX is never a product-design role, whatever
 * else the title says. `bim` and `electrical` sit in HARDWARE_DESIGN instead, since those titles
 * are engineering rather than out-of-scope design.
 *
 * NOT vetoed, and deliberately: `packaging` and `exhibition` design, which are physical but sit
 * closer to graphic and brand work than to the built environment. Say so before widening this.
 */
const OFF_TRACK_DESIGN =
  /\b(?:interior\s+design\w*|interior\s+architect\w*|landscape\s+(?:design\w*|architect\w*)|industrial\s+design\w*|cad\s+designer\b|mechanical\s+designer\b|revit|archicad|autocad|landfx|sketchup|solidworks)\b/i;

const DESIGN_TITLE =
  /\b(?:design(?:er)?s?\b(?![\s/-]*engineer)|ux|ui\b|user\s+experience|user\s+interface|interaction|visual|graphic|motion|brand(?:ing)?|illustrat\w*|typograph\w*|art\s+direct\w*|creative\s+direct\w*|design\s+research|ux\s+research|user\s+research|design\s+system|product\s+design|(?:3d|vfx|concept|character|environment)\s+artist|animator|vfx)\b/i;

/**
 * NOTE on the `\w*` suffixes: these alternations close with `\b`, so a PREFIX alternative
 * like `scien` can never match "Science" — the boundary lands mid-word and the alternative
 * is dead. Every prefix here is therefore written `prefix\w*`. The same trap silently
 * disabled the section-heading matchers further down until the corpus measurement caught it.
 */
const ENGINEERING_TITLE =
  /\b(?:engineer(?:ing|s)?|developer|programmer|swe\b|sde\b|sdet\b|architect|devops|sre\b|site\s+reliability|infrastructure|platform|backend|back-end|frontend|front-end|full[\s-]?stack|mobile|ios\b|android|embedded|firmware|hardware|robotics|data\s+(?:scien|analy|engineer|platform|infra)\w*|data\s*(?:&|and)\s*ai|\w*entwickl\w*|ingenier\w*|desarrollador|machine\s+learning|ml\b|mlops|deep\s+learning|ai\s+(?:engineer|research)|research\s+(?:engineer|scientist)|researcher|scientist|security|cryptograph\w*|qa\b|quality\s+assurance|test\s+engineer|database|systems?\b|network|cloud|compiler|kernel|blockchain|member\s+of\s+technical\s+staff|technical\s+staff|forward\s+deployed|applied\s+ai|solutions?\s+engineer)\b/i;

/** Department / team strings from the ATS, which are far cleaner than the title. */
const DESIGN_DEPARTMENT = /\b(?:design|ux|ui|user\s+experience|creative|brand)\b/i;
const ENGINEERING_DEPARTMENT =
  /\b(?:engineering|technology|technical|r&d|research|science|data|infrastructure|platform|security|it\b|software|product\s+development)\b/i;

/**
 * The last resort, and the noisiest: every posting at an AI company says "engineers". A hit
 * only counts when it is a first-person statement of what the person will do, and the margin
 * requirement below means a single stray mention decides nothing.
 */
const DESIGN_BODY =
  /\b(?:design\s+system|figma|wireframe|prototyp(?:e|ing)|user\s+research|usability|visual\s+design|interaction\s+design|design\s+critique|portfolio\s+of\s+(?:your\s+)?(?:design|shipped)|typography|design\s+language)\b/gi;
const ENGINEERING_BODY =
  /\b(?:codebase|pull\s+requests?|production\s+code|apis?\b|microservices?|kubernetes|typescript|javascript|python|golang|rust\b|c\+\+|distributed\s+systems?|latency|throughput|unit\s+tests?|ci\/cd|sql\b|data\s+pipelines?|model\s+training|inference)\b/gi;

/** A stray mention decides nothing; the winner has to be clear of the loser by this much. */
const BODY_MARGIN = 3;

function countMatches(text: string, pattern: RegExp): number {
  const seen = new Set<string>();
  for (const match of text.matchAll(pattern)) seen.add(match[0].toLowerCase());
  return seen.size;
}

function trackFromTitle(text: string): Track | null {
  if (ENGINEERING_ROLE.test(text) || HARDWARE_DESIGN.test(text)) return 'engineering';
  if (DESIGN_TITLE.test(text)) return 'design';
  if (ENGINEERING_TITLE.test(text)) return 'engineering';
  return null;
}

function extractTrack(title: string, body: string, source: SourceFields | null | undefined): Track | 'other' {
  // CAD/AEC terms can live in a parenthetical qualifier ("Designer (AutoCAD)") and remain
  // decisive, unlike department qualifiers such as "Growth Marketing".
  if (OFF_TRACK_DESIGN.test(title)) return 'other';
  if (FULL_TITLE_ROLE_VETO.test(title)) return 'other';

  // The head first, then the whole title. Reading the head alone is what stops a trailing
  // qualifier deciding the track — "Product Designer, Developer Tools" is a designer, and
  // testing the whole string for `developer` would have called it engineering. Vetoes obey
  // that same boundary: "Designer, Brand and Marketing" is a designer, while "Marketing
  // Associate" is still off-track. The full-title pass is only the fallback for titles that
  // lead with something uninformative ("Intern - Product Design").
  const head = titleHead(title);
  if (TRACK_VETO.test(head) || /^(?:(?:principal|senior|sr\.?|staff|lead)\s+)*tpm$/i.test(head)) return 'other';
  // DC design management is infrastructure when the title supplies that context.
  // A Product/UX Designer attached to a data-center team still follows its own role.
  if (/^(?:(?:senior|sr\.?|principal)\s+)?dc\s+design\b/i.test(head) && HARDWARE_DESIGN.test(title)) {
    return 'engineering';
  }
  const headTrack = trackFromTitle(head);
  if (headTrack && !/^(?:design|engineering)$/i.test(head.trim())) return headTrack;

  if (head !== title) {
    if (TRACK_VETO.test(title)) return 'other';
    const titleTrack = trackFromTitle(title);
    if (titleTrack) return titleTrack;
  }

  const department = `${source?.department ?? ''} ${source?.team ?? ''}`.trim();
  if (department) {
    if (TRACK_VETO.test(department) || OFF_TRACK_DESIGN.test(department)) return 'other';
    // The same precedence the title gets, and for the same reason: a team named "Datacenter
    // Design" is infrastructure, and `DESIGN_DEPARTMENT` matching the bare word `design` was
    // enough to put an OpenAI compute role ("Industrial Compute", which the title alone reads
    // as neither track) on the Design tab.
    if (ENGINEERING_ROLE.test(department) || HARDWARE_DESIGN.test(department)) return 'engineering';
    if (DESIGN_DEPARTMENT.test(department)) return 'design';
    if (ENGINEERING_DEPARTMENT.test(department)) return 'engineering';
  }

  if (!body) return 'other';
  const design = countMatches(body, DESIGN_BODY);
  const engineering = countMatches(body, ENGINEERING_BODY);
  if (design >= BODY_MARGIN && design > engineering) return 'design';
  if (engineering >= BODY_MARGIN && engineering > design) return 'engineering';
  return 'other';
}

// ---------------------------------------------------------------------------------------
// Employment type, work mode, season
// ---------------------------------------------------------------------------------------

/** Matched against the TITLE, where any mention is the posting naming its own type. */
const EMPLOYMENT_TITLE: readonly [EmploymentType, RegExp][] = [
  ['internship', /\b(?:intern(?:ship)?s?|co-?op|placement\s+year|summer\s+analyst)\b/i],
  ['freelance', /\bfreelance(?:r)?\b/i],
  ['part-time', /\bpart[\s-]?time\b/i],
  ['contract', /\b(?:contract(?:or)?|contract-to-hire|fixed[\s-]term|temporary|temp)\b/i],
  ['full-time', /\bfull[\s-]?time\b/i],
];

/**
 * Matched against the BODY, where a bare mention proves nothing — "internships count" sits
 * in a requirements sentence of a full-time posting. Each pattern here is the posting
 * declaring what the role IS.
 */
const EMPLOYMENT_BODY: readonly [EmploymentType, RegExp][] = [
  [
    'internship',
    /\b(?:(?:this|a|an|our)\s+(?:\w+[\s-]){0,3}intern(?:ship)?\b|intern(?:ship)?\s+(?:program|position|role|cohort|term)\b|\d+[\s-]week\s+intern)/i,
  ],
  ['freelance', /\bfreelance(?:r)?\b/i],
  ['part-time', /\bpart[\s-]?time\b/i],
  [
    'contract',
    /\b(?:(?:this|a|an)\s+(?:\w+[\s-]){0,3}(?:contract|fixed[\s-]term|temporary)\s+(?:role|position|engagement)|contract[\s-]to[\s-]hire|on\s+a\s+contract\s+basis)\b/i,
  ],
  ['full-time', /\bfull[\s-]?time\b/i],
];

/** References to somebody else's working arrangement are not the posting declaring its own. */
const NON_ROLE_EMPLOYMENT =
  /\b(?:external\s+(?:agency|agencies)\s+(?:and|,)\s+)?freelance(?:\s*,?\s*(?:or|and)\s+(?:vendor|agency))?\s+(?:creative\s+)?partners?\b|\bfor\s+part[\s-]?time\s+roles?\b/gi;

function extractEmploymentType(
  title: string,
  body: string,
  source: SourceFields | null | undefined,
): EmploymentType | null {
  // Ashby files many internships as "FullTime" (the hours, not the kind), so an intern title outranks it.
  if (source?.employmentType === 'full-time' && EMPLOYMENT_TITLE[0][1].test(title)) return 'internship';
  if (source?.employmentType) return source.employmentType;
  for (const [type, pattern] of EMPLOYMENT_TITLE) if (pattern.test(title)) return type;
  const roleText = body.replace(NON_ROLE_EMPLOYMENT, ' ');
  for (const [type, pattern] of EMPLOYMENT_BODY) if (pattern.test(roleText)) return type;
  // Not stated is not full-time. Every posting on this board is plausibly full-time and
  // saying so without evidence would make the chip meaningless.
  return null;
}

const HYBRID = /\bhybrid\b/i;

/**
 * An UNAMBIGUOUS remote statement, tested before `HYBRID`.
 *
 * Real postings write hybrid loosely — "Hybrid, three days a week in our New York office",
 * "Hybrid in Chicago", "This hybrid contract role" — so tightening `HYBRID` to demand a role
 * noun loses most true hybrids. The actual defect was precedence: `HYBRID` ran first, so
 * "Some of our teams are hybrid" in a body opening "This is a fully remote role" won. Only a
 * phrase that states the ROLE is remote gets to pre-empt it; a bare `remote` mention still
 * loses to hybrid, which is the ordering the old code got right.
 */
const REMOTE_EXPLICIT =
  /\b(?:fully\s+remote|100%\s+remote|remote[\s-](?:first|based|role|position|work)|work\s+from\s+home|work\s+from\s+anywhere|fully\s+distributed)\b/i;
const REMOTE = /\b(?:fully\s+remote|100%\s+remote|remote[\s-](?:first|friendly|based|role|position|work)|work\s+from\s+home|work\s+from\s+anywhere|distributed\s+team|remote\b)/i;
const LIMITED_REMOTE =
  /\b(?:additional\s+|up\s+to\s+|optional\s+)?(?:\d+|one|two|three|four|five|ten|twenty)\s+(?:remote\s+days?|days?\s+(?:of\s+)?remote(?:\s+work)?|weeks?\s+(?:of\s+)?remote\s+work)\s+(?:per|a|each)\s+year\b/gi;
const ONSITE_EXPLICIT =
  /\b(?:(?:a\s+)?(?:willingness|required|expected|eager|excited)\s+to\s+work\s+in[\s-]person|this\s+is\s+an?\s+in[\s-]person\s+(?:role|position)|we\s+work\s+in[\s-]person(?:\s*,?\s*(?:with|at|in|from))|work\s+in[\s-]person\s+(?:at|in|from)\s+our)\b/i;
const ONSITE = /\b(?:on-?site|in-?office|in[\s-]person|onsite\s+in|based\s+in\s+our\s+\w+\s+office)\b/i;

function extractWorkMode(
  title: string,
  body: string,
  source: SourceFields | null | undefined,
): WorkMode | null {
  if (source?.workMode) return source.workMode;
  const text = withoutNegatedRemote(`${title} ${body}`).replace(LIMITED_REMOTE, ' ');
  if (REMOTE_EXPLICIT.test(text)) return 'remote';
  if (HYBRID.test(text)) return 'hybrid';
  if (ONSITE_EXPLICIT.test(text)) return 'onsite';
  if (REMOTE.test(text)) return 'remote';
  if (ONSITE.test(text)) return 'onsite';
  return null;
}

/** "Summer 2027", "Fall internship", "Winter co-op term". */
const SEASON =
  /\b(summer|fall|autumn|winter|spring)\b(?=[^.]{0,40}?\b(?:intern(?:ship)?s?|co-?ops?|20\d\d|term|cohort|program)\b)|\b(?:intern(?:ship)?s?|co-?ops?)\b[^.]{0,30}?\b(summer|fall|autumn|winter|spring)\b/i;

function extractSeason(title: string, body: string): Season | null {
  for (const text of [title, body]) {
    const match = SEASON.exec(text);
    if (!match) continue;
    const word = (match[1] ?? match[2]).toLowerCase();
    return word === 'autumn' ? 'fall' : (word as Season);
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Pay
// ---------------------------------------------------------------------------------------

const PERIOD_WORDS: readonly [PayPeriod, RegExp][] = [
  ['hour', /^(?:\/|\s*(?:per|an|a|each)\s*)?\s*(?:hour|hr|hourly)\b/i],
  ['week', /^(?:\/|\s*(?:per|a|each)\s*)?\s*(?:week|wk|weekly)\b/i],
  ['month', /^(?:\/|\s*(?:per|a|each)\s*)?\s*(?:month|mo|monthly)\b/i],
  ['year', /^(?:\/|\s*(?:per|a|each)\s*)?\s*(?:year|yr|annum|annually|annual)\b/i],
];

/**
 * `$120,000 - $160,000` · `$55/hr` · `$120k-$160k` · `€45.000` · a bare `$85,000`.
 *
 * The `$`/`€`/`£` anchor is load-bearing: without it `401k` reads as 401,000 and `10k users`
 * reads as a salary. Every figure this returns was written as money by the posting.
 */
const PAY_RANGE =
  /([$€£])\s?(\d{1,3}(?:[,.]\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d+)?)\s*([kK])?\s*(?:(?:-|–|—|to|and(?:\s+up\s+to)?|up\s+to)\s*[$€£]?\s?(\d{1,3}(?:[,.]\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d+)?)\s*([kK])?)?/g;

const PAY_CONTEXT =
  /\b(?:salary|compensation|pay|paid|base|hourly\s+rate|wages?|earnings?|remuneration|stipend)\b/i;
const STRONG_PAY_CONTEXT =
  /\b(?:salary|compensation|base\s+(?:pay|salary|compensation)|pay\s+(?:range|rate)|hourly\s+rate|wages?|earnings?|remuneration|(?:we|role|position|job|interns?)\s+(?:will\s+)?pay(?:s|ing|ed)?)\b[^$€£]{0,80}$/i;
const NON_WAGE_BEFORE =
  /\b(?:client\s+book\s+revenue|revenue\s+per\s+employee|valuation|funding|series\s+[a-z]|payment\s+volume|(?:fertility|medical|dependent\s+care)\s+(?:hra|fsa|reimbursement|benefit)|(?:wellness[\s'‘’"]*|lifestyle|education(?:al)?|learning|home\s+office|work\s+from\s+home|remote\s+work|internet|mobile|cell\s+phone|meal|lunch|food|commuter)\s+(?:benefits?(?:\s+package)?|budget|stipend|allowance|reimbursement|account|wallet|coverage|package)|(?:weekly\s+)?lunch\s+stipend|401\s*\(?k\)?|employer\s+match|matching\s+contribution|years?\s+of\s+service|tenure\s+(?:award|reward)|one[\s-]time|signing\s+bonus|referral\s+bonus)\b/i;
const NON_WAGE_AFTER =
  /\b(?:one[\s-]time|meal\s+stipend|lunch\s+stipend|education(?:al)?\s+budget|wellness\s+(?:benefit|stipend)|lifestyle\s+stipend|remote\s+work\s+reimbursement|fertility\s+hra|medical\s+fsa|givve|juno|sharebite|food\s+stamps?|per\s+working\s+day)\b/i;

function moneyContext(body: string, start: number, end: number): { before: string; after: string } {
  const before = body.slice(Math.max(0, start - 160), start);
  const boundary = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'));
  return {
    before: before.slice(boundary + 1),
    after: body.slice(end, Math.min(body.length, end + 80)),
  };
}

function toAmount(digits: string, thousands: string | undefined): number {
  const value = Number(digits.replace(/[,](?=\d{3}\b)/g, '').replace(/[.](?=\d{3}\b)/g, ''));
  return thousands ? value * 1000 : value;
}

function extractPayRate(body: string): PayRate | null {
  for (const match of body.matchAll(PAY_RANGE)) {
    // "$120-160k" writes the multiplier once, on the high end, and means it for both. Read
    // each side's own suffix first and fall back to the other's, or the low end parses as
    // $120 — which then reads as an hourly rate, or fails the annual sanity floor and
    // discards a stated salary band entirely.
    const thousands = match[3] ?? match[5];
    const min = toAmount(match[2], thousands);
    const max = match[4] === undefined ? null : toAmount(match[4], match[5] ?? match[3]);
    if (!Number.isFinite(min) || min <= 0) continue;

    const trailing = body.slice(match.index + match[0].length, match.index + match[0].length + 24);
    const context = moneyContext(body, match.index, match.index + match[0].length);
    // A magnitude suffix means this is a COMPANY number, not a wage — "$11B valuation",
    // "$150M Series C", "raised $1.5B". Nobody's salary is quoted in billions, but the
    // magnitude fallback below reads a bare "11" as $11 AN HOUR, so ElevenLabs advertised
    // $11/hr and Baseten $1.5/hr on the board. `k` is deliberately NOT here: "$120-160k" is
    // exactly how a real salary band is written.
    if (/^\s*(?:[bmt]\b|bn\b|billion|million|trillion|%)/i.test(trailing)) continue;
    if (/^\s*one[\s-]time\b/i.test(context.after)) continue;
    const stronglyPayRelated = STRONG_PAY_CONTEXT.test(context.before);
    if (
      (!stronglyPayRelated && NON_WAGE_BEFORE.test(context.before)) ||
      (!stronglyPayRelated && NON_WAGE_AFTER.test(context.after))
    ) {
      continue;
    }
    let period: PayPeriod | null = null;
    for (const [candidate, pattern] of PERIOD_WORDS) {
      if (pattern.test(trailing)) {
        period = candidate;
        break;
      }
    }
    // No unit given: magnitude decides. Nobody is paid $150,000 an hour or $60 a year, and
    // a low bare amount is only an hourly rate when the same clause calls it compensation.
    period ??=
      min >= 1000
        ? 'year'
        : min < 200 && (max !== null || PAY_CONTEXT.test(`${context.before} ${context.after}`))
          ? 'hour'
          : null;

    // A figure with no unit and an ambiguous magnitude is more likely a price than a wage.
    if (period === null) continue;
    // Sanity: an hourly rate over $500 or a salary under $10k is a parse, not a wage.
    if (period === 'hour' && min > 500) continue;
    // The missing lower bound, symmetric with the annual one above. No US role pays under the
    // federal minimum, so a sub-$7.25 "hourly rate" is always a company figure the magnitude
    // fallback misread — "$1.0" from Stripe's payment volume, "$2.7" from a funding round.
    if (period === 'hour' && min < 7.25) continue;
    if (period === 'year' && min < 10_000) continue;
    return {
      min,
      max: max !== null && max >= min ? max : null,
      period,
      ...(match[1] === '$' ? {} : { currencySymbol: match[1] as CurrencySymbol }),
    };
  }
  return null;
}

const PAY_STATED =
  /\b(?:paid\s+(?:internship|position|role|co-?op)|stipend|(?:salary|compensation|pay|base)\s+(?:range|band)|hourly\s+rate|competitive\s+(?:salary|compensation|pay))\b/i;
/** "unpaid leave" and "unpaid time off" are benefits boilerplate, not the role's pay. */
const UNPAID =
  /\b(?:unpaid(?!\s+(?:leave|time|pto|parental|sick|holiday))|for\s+(?:course\s+|academic\s+)?credit\s+only|academic\s+credit\s+only|volunteer\s+(?:position|role|basis)|no\s+(?:compensation|salary|pay)\s+(?:is\s+)?(?:offered|provided))\b/i;

function extractPaid(body: string, payRate: PayRate | null): boolean | null {
  if (UNPAID.test(body)) return false;
  if (payRate !== null || PAY_STATED.test(body)) return true;
  // NULL is "unknown" and stays unknown (finding G). Most postings never state pay.
  return null;
}

// ---------------------------------------------------------------------------------------
// Graduation, location, summary
// ---------------------------------------------------------------------------------------

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
const EXPECTED_GRAD = new RegExp(
  String.raw`\b(?:graduat\w*|degree\s+conferred|class\s+of|commencement)\b[^.]{0,60}?\b((?:${MONTH}|spring|summer|fall|autumn|winter)?\s*(?:of\s+)?20\d\d(?:\s*(?:-|–|or|and)\s*20\d\d)?)`,
  'i',
);

function extractExpectedGrad(body: string): string | null {
  const match = EXPECTED_GRAD.exec(body);
  if (!match) return null;
  return match[1].replace(/\s+/g, ' ').trim() || null;
}

/**
 * Preambles, in the order they have to be tried. A role marker anywhere in the body beats
 * stripping a leading "About us", because "About Anthropic Anthropic's mission is to create
 * reliable, interpretable AI" is a true first sentence about the company and a useless one
 * about the job.
 */
const ROLE_MARKER =
  /\b(?:about\s+(?:the|this)\s+(?:role|position|job|opportunity)|the\s+(?:role|opportunity|position)|role\s+(?:overview|description|summary)|job\s+(?:summary|description)|position\s+summary|what\s+you(?:'|’)?ll\s+do|in\s+this\s+role|your\s+(?:impact|role)|about\s+the\s+(?:team|job)|responsibilities)\b[:\s—–-]*/i;
const COMPANY_PREAMBLE =
  /^(?:(?:why\s+\w+|about\s+(?:us|the\s+company|our\s+company|\w+(?:\s+\w+){0,2})|who\s+(?:we\s+are|are\s+we)|our\s+(?:mission|company|story|team)|company\s+(?:description|overview|background)|overview|introduction|hello|hi\b)[\s:?!—–-]*)+/i;
/** A "sentence" that is really a metadata line — location, salary, req id, apply link. */
const METADATA_SENTENCE =
  /^(?:location|employment\s+type|job\s+title|department|salary|compensation|req(?:uisition)?\s*(?:id|#)|headquarters|url|apply|website|start\s+date|reports\s+to|type|team)\b\s*[:—–-]/i;

const MIN_SUMMARY_CHARS = 30;
const MAX_SUMMARY_CHARS = 240;

/**
 * The first real sentence of the description. Extractive and nothing else — this is copied
 * text, never generated, so it can never say something the posting did not.
 */
export function extractSummary(body: string): string | null {
  if (!body) return null;
  const marker = ROLE_MARKER.exec(body);
  const start = marker ? marker.index + marker[0].length : 0;
  const text = body.slice(start).replace(COMPANY_PREAMBLE, '');

  for (const sentence of text.split(/(?<=[.!?])\s+/).slice(0, 6)) {
    const candidate = sentence.trim();
    if (candidate.length < MIN_SUMMARY_CHARS) continue;
    if (METADATA_SENTENCE.test(candidate)) continue;
    return candidate.length > MAX_SUMMARY_CHARS
      ? `${candidate.slice(0, MAX_SUMMARY_CHARS).replace(/\s+\S*$/, '')}…`
      : candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Bullets
// ---------------------------------------------------------------------------------------

/**
 * Heading matchers. Deliberately prefix-anchored and NOT closed with `\b`: the headings in
 * the wild are "Responsibilities" and "Requirements", and a trailing `\b` after
 * `responsibilit` can never match the `i` that follows it.
 */
const RESPONSIBILITY_HEADING =
  /\b(?:responsibilit|what\s+you(?:'|’)?ll\s+(?:do|be\s+doing|own)|what\s+you\s+will\s+do|the\s+(?:role|job)|day[\s-]to[\s-]day|your\s+impact|in\s+this\s+role|duties|scope)/i;
const SKILL_HEADING =
  /\b(?:qualification|requirement|skills?|what\s+you(?:'|’)?ll\s+bring|what\s+we(?:'|’)?re\s+looking\s+for|who\s+you\s+are|about\s+you|you\s+(?:have|are|might)|experience|must\s+have|nice\s+to\s+have|preferred|ideal\s+candidate|tech\s+stack)/i;
const EDUCATION_TERM =
  /\b(?:bachelor|master|b\.?s\.?c?\b|m\.?s\.?c?\b|ph\.?d|doctorate|undergraduate|degree(?!\s+of\b)|major(?:ing)?\s+in|coursework|gpa|university|college|diploma)\b/i;

/** The prompt used to forbid these by instruction; a list does it deterministically. */
const MARKETING_COPY =
  /\b(?:fast[\s-]paced|rock\s?star|ninja|unicorn|world[\s-]class|make\s+an?\s+impact|wear\s+many\s+hats|like\s+a\s+family|work\s+hard,?\s+play\s+hard|self[\s-]starter|think\s+outside\s+the\s+box|hit\s+the\s+ground\s+running|passionate\s+about\s+our\s+mission|dynamic\s+environment)\b/i;

function usableBullet(item: string): boolean {
  return item.length >= 12 && item.length <= MAX_BULLET_CHARS && !MARKETING_COPY.test(item);
}

function bulletsFor(sections: readonly Section[], heading: RegExp, exclude?: RegExp): string[] {
  const items: string[] = [];
  for (const section of sections) {
    if (!heading.test(section.heading)) continue;
    if (exclude?.test(section.heading)) continue;
    for (const item of section.items) {
      if (usableBullet(item) && !items.includes(item)) items.push(item);
      if (items.length >= MAX_BULLETS) return items;
    }
  }
  return items;
}

function educationFrom(sections: readonly Section[], body: string): string[] {
  const items: string[] = [];
  for (const section of sections) {
    for (const item of section.items) {
      if (!EDUCATION_TERM.test(item) || !usableBullet(item) || items.includes(item)) continue;
      items.push(item);
      if (items.length >= MAX_BULLETS) return items;
    }
  }
  if (items.length > 0) return items;

  // No sections (an aggregator, or a body with no lists): the sentence that states the
  // requirement is the next best thing, and it is still copied text.
  for (const sentence of body.split(/(?<=[.!?])\s+/)) {
    const candidate = sentence.trim();
    if (EDUCATION_TERM.test(candidate) && usableBullet(candidate)) return [candidate];
  }
  return [];
}

// ---------------------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------------------

const BADGE_PATTERNS: readonly [string, RegExp][] = [
  [
    'new-grad',
    /\b(?:new\s+grad(?:uate)?s?|recent\s+graduates?|university\s+grad(?:uate)?|early\s+career|entry[\s-]level)\b/i,
  ],
  [
    'visa-sponsorship',
    /\b(?:visa\s+sponsorship|sponsorship\s+(?:is\s+)?(?:available|provided|offered)|will\s+sponsor|h-?1b\s+sponsor\w*|we\s+sponsor\s+visas)\b/i,
  ],
  [
    'no-degree-required',
    /\b(?:no\s+degree\s+(?:is\s+)?(?:required|necessary)|degree\s+(?:is\s+)?not\s+required|in\s+lieu\s+of\s+a\s+degree|or\s+equivalent\s+(?:practical\s+)?experience|equivalent\s+work\s+experience)\b/i,
  ],
  [
    'portfolio-required',
    /\bportfolio\b(?=[^.]{0,80}?\b(?:required|submit|share|include|link|attach|review)\b)|\b(?:submit|share|include|attach)\b[^.]{0,40}?\bportfolio\b/i,
  ],
  [
    'security-clearance',
    /\b(?:security\s+clearance|ts\/sci|top\s+secret|secret\s+clearance|public\s+trust|polygraph)\b/i,
  ],
];

/** Sponsorship denials are more common than offers, and they invert the badge. */
const NO_SPONSORSHIP =
  /\b(?:(?:cannot|can\s?not|unable\s+to|not\s+able\s+to|do\s+not|does\s+not|will\s+not|won'?t)\s+(?:currently\s+)?(?:provide\s+|offer\s+|support\s+)?(?:visa\s+|immigration\s+)?sponsor\w*|no\s+visa\s+sponsorship|without\s+(?:the\s+need\s+for\s+)?sponsorship|sponsorship\s+is\s+not\s+(?:available|offered|provided))\b/i;

function extractBadges(body: string, employmentType: EmploymentType | null): string[] {
  const badges: string[] = [];
  if (employmentType === 'internship') badges.push('internship');
  for (const [badge, pattern] of BADGE_PATTERNS) {
    if (!pattern.test(body)) continue;
    if (badge === 'visa-sponsorship' && NO_SPONSORSHIP.test(body)) continue;
    badges.push(badge);
  }
  return [...new Set(badges)];
}

// ---------------------------------------------------------------------------------------
// The extractor
// ---------------------------------------------------------------------------------------

export function extract({ title, description, sourceFields: source }: ExtractInput): Extraction {
  const body = (description ?? '').slice(0, MAX_DESCRIPTION_CHARS);
  const sections = source?.sections ?? [];

  const employment_type = extractEmploymentType(title, body, source);
  const pay_rate = extractPayRate(body);

  return {
    track: extractTrack(title, body, source),
    seniority: extractSeniority(title, body),
    employment_type,
    internship_season: extractSeason(title, body),
    paid: extractPaid(`${title}. ${body}`, pay_rate),
    work_mode: extractWorkMode(title, body, source),
    location: source?.location?.trim() || null,
    pay_rate,
    expected_grad: extractExpectedGrad(body),
    summary: extractSummary(body),
    responsibilities: bulletsFor(sections, RESPONSIBILITY_HEADING, SKILL_HEADING),
    skills: bulletsFor(sections, SKILL_HEADING),
    education: educationFrom(sections, body),
    badges: extractBadges(body, employment_type),
  };
}

/**
 * The drop gate and the only place a row's stored shape is decided.
 *
 * - a `track` other than design/engineering is dropped, not stored;
 * - `senior+` is dropped on ENGINEERING only — Design keeps it (see below);
 * - `summary` is nulled for design: the Design tab has no summary column;
 * - the `voice-ai` badge is applied here rather than inside `extract`, so `lib/voice.ts`
 *   stays the single owner of that decision.
 */
export function toStored(
  extraction: Extraction,
  normalizedDescription: string | null | undefined,
): StoredExtraction | null {
  if (extraction.track === 'other') return null;
  // Engineering keeps the ceiling; Design does not. The corpus simply does not contain
  // entry-level design in the volume it contains entry-level engineering — 16,729 postings a
  // cycle are dropped as senior, and holding Design to the same bar left it at 221 rows
  // against Engineering's 2,271. Storing them is not the same as showing them at equal
  // weight: `seniorityRank` still sorts senior+ last, and Design's `level` filter offers it
  // as its own option, so it can be excluded in one click.
  if (extraction.seniority === 'senior+' && extraction.track !== 'design') return null;

  const track = extraction.track;
  const badges = extraction.badges.filter((badge) => ALLOWED_BADGES.includes(badge));
  if (track === 'engineering' && isVoiceRole(normalizedDescription)) badges.push(VOICE_BADGE);

  return {
    ...extraction,
    track,
    seniority: extraction.seniority,
    summary: track === 'engineering' ? extraction.summary : null,
    badges: [...new Set(badges)],
  };
}
