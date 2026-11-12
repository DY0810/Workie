/**
 * Extraction tests. Deterministic by construction — no stub client, no network, no key,
 * because there is no model. Every assertion is a hand-authored expectation from
 * `extract.fixtures.ts`, never a recording of what the implementation happens to return.
 */

import { describe, expect, it } from 'vitest';

import {
  extract,
  extractSummary,
  isSeniorByRegex,
  parseSections,
  toStored,
  type ExtractInput,
} from './extract.ts';
import { GRADED_FIELDS, POSTING_FIXTURES, SENIOR_FIXTURES } from './extract.fixtures.ts';
import { normalizeDescription } from './normalize.ts';
import { VOICE_BADGE } from './voice.ts';

describe('technical roles attached to design teams', () => {
  it.each([
    ['DC Design Manager for Region (AMER), Data Center Engineering', 'engineering'],
    ['DC Design & Portfolio Management, Data Center Engineer', 'engineering'],
    ['Principal TPM, AWS UX Design Team', 'other'],
    ['Product Designer, Data Center Management', 'design'],
    ['UX Designer, TPM Tools', 'design'],
    ['TPM Firmware Engineer', 'engineering'],
  ])('classifies %s as %s', (title, track) => {
    expect(extract({ title, description: '' }).track).toBe(track);
  });
});

function run(fixture: { title: string; description: string }, sourceFields?: ExtractInput['sourceFields']) {
  return extract({
    title: fixture.title,
    description: normalizeDescription(fixture.description),
    sourceFields,
  });
}

// ---------------------------------------------------------------------------------------
// Seniority — the acceptance criterion, with no model behind it any more
// ---------------------------------------------------------------------------------------

describe('seniority', () => {
  it('covers every senior fixture with zero leaks', () => {
    for (const fixture of SENIOR_FIXTURES) {
      const seniority = run(fixture).seniority;
      expect(seniority, `${fixture.title} — ${fixture.company}`).toBe('senior+');
    }
    expect(SENIOR_FIXTURES.length).toBeGreaterThanOrEqual(15);
  });

  it('keeps every listed posting — no false positives on the fixture set', () => {
    for (const fixture of POSTING_FIXTURES) {
      expect(run(fixture).seniority, fixture.title).not.toBe('senior+');
    }
  });

  /**
   * THE REGRESSION. A years range has to be read from its START: "2-5 years" is the standard
   * way to write a mid-level ask. Reading the tail instead — which a bare `\b[5-9]` does,
   * since a hyphen is a word boundary — silently drops most mid roles. Found and fixed once.
   */
  it('reads a years range from its start, so the mid band survives', () => {
    expect(isSeniorByRegex('Software Engineer', 'We want 2-5 years of experience.')).toBe(false);
    expect(isSeniorByRegex('Software Engineer', 'We want 5-7 years of experience.')).toBe(true);
    expect(isSeniorByRegex('Software Engineer', 'We want 3 to 6 years of experience.')).toBe(false);
    expect(isSeniorByRegex('Software Engineer', 'We want 2–4 yrs of experience.')).toBe(false);
  });

  it('matches years of experience in the body, not just the title', () => {
    expect(isSeniorByRegex('Backend Engineer', 'You have 7 years of professional experience.')).toBe(true);
    expect(isSeniorByRegex('Backend Engineer', 'You have 10+ years shipping services.')).toBe(true);
  });

  it('does not fire on a seniority word inside another word', () => {
    expect(isSeniorByRegex('Leadership Development Designer', '')).toBe(false);
    expect(isSeniorByRegex('Usr Interface Engineer', '')).toBe(false);
  });

  it('lets "Member of Technical Staff" through — it is an IC title, and a voice-AI one', () => {
    expect(isSeniorByRegex('Member of Technical Staff', '')).toBe(false);
    expect(isSeniorByRegex('Senior Member of Technical Staff', '')).toBe(true);
  });

  it('catches the prose phrasings a title-only filter misses', () => {
    expect(isSeniorByRegex('Engineer', 'You will set the technical direction for the group.')).toBe(true);
    expect(isSeniorByRegex('Engineer', "You'll own the roadmap for our platform.")).toBe(true);
    expect(isSeniorByRegex('Engineer', 'Deep expertise is expected in distributed systems.')).toBe(true);
    expect(isSeniorByRegex('Engineer', 'You will mentor junior engineers on the team.')).toBe(true);
    expect(isSeniorByRegex('Engineer', 'You will manage a team of five engineers.')).toBe(true);
  });

  it('does not fire on a verb that merely starts another word', () => {
    // `lead` inside "leadership development" once dropped the whole posting.
    expect(
      isSeniorByRegex('Software Engineer', 'We are hiring and leadership development is offered to everyone.'),
    ).toBe(false);
    expect(isSeniorByRegex('Software Engineer', 'You will hire and mentor the team.')).toBe(true);
  });

  it('does not fire on ordinary junior prose', () => {
    expect(isSeniorByRegex('Software Engineer', 'You will own your projects and ship weekly.')).toBe(false);
    expect(isSeniorByRegex('Product Designer', 'You will make an impact on a growing team.')).toBe(false);
    expect(isSeniorByRegex('Engineer', 'You will work with senior engineers who will mentor you.')).toBe(false);
  });

  it('reads the bands below senior from the title and the years asked for', () => {
    expect(extract({ title: 'Software Engineering Intern', description: '' }).seniority).toBe('entry');
    expect(extract({ title: 'New Grad Software Engineer', description: '' }).seniority).toBe('entry');
    expect(extract({ title: 'Junior Product Designer', description: '' }).seniority).toBe('junior');
    expect(extract({ title: 'Associate UX Designer', description: '' }).seniority).toBe('junior');
    expect(extract({ title: 'Backend Engineer', description: 'You have 1-2 years of experience.' }).seniority).toBe('junior');
    expect(extract({ title: 'Backend Engineer', description: 'You have one to three years of experience.' }).seniority).toBe('junior');
    expect(extract({ title: 'Backend Engineer', description: 'You have 2-5 years of experience.' }).seniority).toBe('mid');
    expect(extract({ title: 'Backend Engineer', description: 'You have 3-4 years of experience.' }).seniority).toBe('mid');
    // Nothing stated at all lands on mid, the least flattering of the three visible bands.
    expect(extract({ title: 'Backend Engineer', description: 'You will write services.' }).seniority).toBe('mid');
  });
});

// ---------------------------------------------------------------------------------------
// Track
// ---------------------------------------------------------------------------------------

describe('track', () => {
  it('reads the title first', () => {
    expect(extract({ title: 'Product Designer', description: '' }).track).toBe('design');
    expect(extract({ title: 'Backend Engineer, Payments', description: '' }).track).toBe('engineering');
    expect(extract({ title: 'Member of Technical Staff', description: '' }).track).toBe('engineering');
  });

  it('keeps a design/engineer hybrid title on the engineering side', () => {
    expect(extract({ title: 'Design Engineer', description: '' }).track).toBe('engineering');
    expect(extract({ title: 'Designer/Engineer', description: '' }).track).toBe('engineering');
    expect(extract({ title: 'Product Designer', description: '' }).track).toBe('design');
  });

  it.each([
    ['Associate Creative Director, Growth Marketing', 'design'],
    ['Designer, Brand and Marketing (Part-Time)', 'design'],
    ['Design Engineer, Growth & Marketing', 'engineering'],
  ] as const)('lets the role before a qualifier decide %s', (title, track) => {
    expect(extract({ title, description: '' }).track).toBe(track);
  });

  /**
   * Titles taken verbatim off the live Design tab, where they were all wrong. `DESIGN_TITLE`
   * was tested before `ENGINEERING_TITLE`, so any title carrying "design", "visual", "brand"
   * or "creative" claimed the Design tab first — and four NVIDIA silicon internships led the
   * board because "Hardware ASIC Design Intern" reads as a design title.
   */
  it.each([
    'Hardware ASIC Design Intern - Hardware',
    'Hardware Design for Test Intern - DFT',
    'Hardware Physical Design / VLSI Intern',
    'Mixed Signal Design Intern',
    'Analog Design Intern',
    'Mechanical Design Engineer, Data Centre Engineering',
    'Software Engineer, Silicon Design Methodology',
    'Machine Learning Engineer Intern - Brand Ads',
    'Visual Generation & Multimodal Evaluation Machine Learning Engineer Intern - AML-ARK',
    'Machine Learning Engineer Intern - Data Search - Visual Search',
    'Software Engineer Intern - Creative Intelligence and Brand Innovation',
  ])('sends the engineering role %s to engineering, not design', (title) => {
    expect(extract({ title, description: '' }).track).toBe('engineering');
  });

  /**
   * The other half of the same rule, and the reason it is scoped to silicon terms and role
   * nouns rather than to the bare words `hardware` or `developer`. Each of these is a real
   * design role that a blunter fix would have moved to the wrong tab.
   */
  it.each([
    'Hardware Product Designer', // industrial design, not silicon
    'Product Designer, Developer Tools', // a trailing qualifier must not decide the track
    'Designer, Developer Experience',
    'Design Systems Designer', // `systems` is an ENGINEERING_TITLE word
    'UX Researcher', // `researcher` is deliberately not a role noun here
    'Design Researcher',
    'AI Agent Experience Designer',
    'Intern - Product Design', // head decides nothing; the full title still does
    'Graphic Design Assistant',
  ])('keeps the design role %s on design', (title) => {
    expect(extract({ title, description: '' }).track).toBe('design');
  });

  /** A spaced dash separates a qualifier; a bare hyphen is part of the word. */
  it('splits the title head on a spaced dash only', () => {
    expect(extract({ title: 'Full-Stack Engineer', description: '' }).track).toBe('engineering');
    expect(extract({ title: 'Front-End Engineer - Growth', description: '' }).track).toBe('engineering');
  });

  it('vetoes an administrative role naming both tracks', () => {
    expect(
      extract({ title: 'Administrative Business Partner I - Engineering, Product and Design', description: '' }).track,
    ).toBe('other');
  });

  /**
   * A second round of leaks, found on the live Design tab after Amazon and Workday started
   * feeding it. Same class as the NVIDIA silicon internships above — engineering and marketing
   * roles whose titles carry a design word — but none of them was caught by the first fix.
   */
  it.each([
    ['NVIDIA 2027 Internships: Digital Circuit Design', 'engineering'], // silicon, no ASIC/VLSI in the title
    ['Electrical BIM Designer, DC Design Engineering', 'engineering'], // datacenter electrical
    ['Audio Visual Technical Producer', 'other'], // matched on "Visual"
    ['Student Brand Ambassador - Michigan State University', 'other'], // matched on "Brand"
    ['Solutions Design Analyst', 'other'],
    ['Safeguards Enforcement Analyst, Age-Appropriate Design', 'other'],
  ])('keeps %s off the Design tab', (title, track) => {
    expect(extract({ title, description: '' }).track).toBe(track);
  });

  /**
   * The department path needed the same precedence the title has. "Industrial Compute" reads as
   * neither track from its title, and its team is "Datacenter Design" — which reached
   * DESIGN_DEPARTMENT on the bare word `design` and put an infrastructure role on the Design tab.
   */
  it('does not let a hardware team name claim the Design tab', () => {
    const sourceFields = { department: 'Scaling', team: 'Datacenter Design' };
    expect(extract({ title: 'Industrial Compute', description: '', sourceFields }).track).toBe('engineering');
    // A genuine design department still wins.
    expect(
      extract({ title: 'Product Designer', description: '', sourceFields: { department: 'Design', team: 'Design Systems' } }).track,
    ).toBe('design');
  });

  it('uses the role evidence for ambiguous Waymo titles instead of broad design words', () => {
    expect(
      extract({
        title: 'Technical Lead Manager, Route & Motion Generation',
        description:
          'Software Engineering builds the brains of the autonomous driver. Lead onboard motion planning systems and write robust C++.',
        sourceFields: { department: 'Planner' },
      }).track,
    ).toBe('engineering');
    expect(
      extract({
        title: 'Brand Media Strategy & Analytics Manager',
        description: 'Lead paid media strategy, media buying, audience targeting, and growth marketing analytics.',
        sourceFields: { department: 'O-Marketing-Corp' },
      }).track,
    ).toBe('other');
    expect(
      extract({
        title: 'Design Studio Process Manager',
        description:
          'Own facility layout optimization using industrial engineering, operational modeling, and manufacturing workflows.',
        sourceFields: { department: 'GPS Offices/Labs/Mfg' },
      }).track,
    ).toBe('other');
  });

  /** The vetoes added above are narrow on purpose; these are the near misses they must not take. */
  it.each([
    'Production Designer', // `producer` must not match `production`
    'Quantitative UX Researcher, Applied AI Solutions',
    'Brand Designer,  Product Launches', // `ambassador` was the veto, not `brand`
    'Presentation Designer',
    'UI Designer for Motion & Animation',
  ])('keeps the design role %s on design', (title) => {
    expect(extract({ title, description: '' }).track).toBe('design');
  });

  /** `analyst` was deliberately NOT vetoed wholesale — data analysts are engineering. */
  it('leaves a data analyst on engineering', () => {
    expect(extract({ title: 'Data Analyst', description: '' }).track).toBe('engineering');
  });

  /**
   * Design disciplines out of scope for this tool. Not misclassification — these are real design
   * jobs — but the Design tab means product, visual and brand work, and these were 8 of 48
   * visible rows, mostly one staffing agency reposting architecture briefs.
   */
  it.each([
    'Remote Interior Designer - Revit & Design-Focused',
    'Remote Landscape Designer with LandFX experience',
    'High-End Hotel Interior Design Specialist (Revit Documentation)',
    'Remote Archicad expert for Interior Design & Documentation',
    'Industrial Designer',
    'Senior Industrial Design Lead',
    'Landscape Architect',
    'CAD Designer (AutoCAD)',
    'Mechanical Designer, SolidWorks',
  ])('keeps the out-of-scope design role %s off both tabs', (title) => {
    expect(extract({ title, description: '' }).track).toBe('other');
  });

  /**
   * The line that veto must not cross. `packaging` and `exhibition` are physical design and stay,
   * because they sit closer to graphic and brand work than to the built environment — and the
   * first four here are seed fixtures, so moving them would silently re-aim the query suite.
   */
  it.each([
    'Packaging Designer',
    'Exhibition Designer',
    'Communication Designer',
    'Editorial Designer',
    'Product Designer',
    'Presentation Designer',
    'Production Designer',
    'Creative Designer',
  ])('keeps %s on the Design tab', (title) => {
    expect(extract({ title, description: '' }).track).toBe('design');
  });

  it('vetoes a GTM or PM role that happens to contain a track word', () => {
    expect(extract({ title: 'Sales Engineer', description: '' }).track).toBe('other');
    expect(extract({ title: 'Customer Engineer (Pre-Sales)', description: '' }).track).toBe('other');
    expect(extract({ title: 'Brand Development Associate (Account Manager)', description: '' }).track).toBe('other');
    expect(extract({ title: 'Brand Manager Global Originals, Marketing', description: '' }).track).toBe('other');
    expect(extract({ title: 'Design Program Manager', description: '' }).track).toBe('other');
    expect(extract({ title: 'Product Manager, Growth', description: '' }).track).toBe('other');
    expect(extract({ title: 'Technical Support Engineer', description: '' }).track).toBe('other');
    expect(extract({ title: 'Marketing Associate', description: '' }).track).toBe('other');
  });

  it('falls back to the department the ATS returned when the title says nothing', () => {
    expect(
      extract({ title: 'Member of Staff', description: '', sourceFields: { department: 'Design' } }).track,
    ).toBe('design');
    expect(
      extract({
        title: 'Analyst, Special Projects',
        description: '',
        sourceFields: { department: 'Sales', team: 'Enterprise' },
      }).track,
    ).toBe('other');
  });

  it('falls back to the body only with a clear margin', () => {
    const design =
      'You will run user research, build wireframes in Figma, own the design system, and lead design critique on prototyping work.';
    expect(extract({ title: 'Consultant', description: design }).track).toBe('design');
    // One stray mention of an API decides nothing.
    expect(extract({ title: 'Consultant', description: 'You will talk to customers about our API.' }).track).toBe('other');
  });
});

// ---------------------------------------------------------------------------------------
// Structured fields beat the prose
// ---------------------------------------------------------------------------------------

describe('precedence', () => {
  it('prefers the source field over anything the description says', () => {
    const description = 'This hybrid contract role is based in our Berlin office.';
    const result = extract({
      title: 'Software Engineer',
      description,
      sourceFields: { employmentType: 'full-time', workMode: 'remote', location: 'Austin, Texas' },
    });
    expect(result.employment_type).toBe('full-time');
    expect(result.work_mode).toBe('remote');
    expect(result.location).toBe('Austin, Texas');
  });

  it('reads a full-time source field under an intern title as an internship', () => {
    const fields = { employmentType: 'full-time' as const };
    expect(extract({ title: 'Software Engineer Intern', description: '', sourceFields: fields }).employment_type).toBe('internship');
    expect(extract({ title: 'Internal Tools Engineer', description: '', sourceFields: fields }).employment_type).toBe('full-time');
  });

  it('falls back to the text when the source said nothing', () => {
    const result = extract({
      title: 'Software Engineer',
      description: 'This hybrid contract role runs for six months.',
    });
    expect(result.employment_type).toBe('contract');
    expect(result.work_mode).toBe('hybrid');
    expect(result.location).toBeNull();
  });

  it('does not treat another worker type as the posting type', () => {
    expect(
      extract({
        title: 'Creative Director',
        description:
          'Collaborate with external agency and freelance partners. Full-time employees are eligible for equity.',
      }).employment_type,
    ).toBe('full-time');
    expect(
      extract({
        title: 'Creative Director',
        description:
          'Experience managing or directing external agency, freelance, or vendor creative partners. Full-time employees are eligible for equity.',
      }).employment_type,
    ).toBe('full-time');
    expect(
      extract({
        title: 'Visual Designer',
        description: 'For part time roles, compensation will be adjusted appropriately.',
      }).employment_type,
    ).toBeNull();
  });

  it('uses freelance for a freelance project that also has part-time hours', () => {
    expect(
      extract({
        title: 'Mobile Designer',
        description: 'This is a part-time freelance project of 20-30 hours per week.',
      }).employment_type,
    ).toBe('freelance');
  });

  it('still recognizes explicit employment declarations', () => {
    expect(extract({ title: 'Designer', description: 'This is a part-time role.' }).employment_type).toBe('part-time');
    expect(extract({ title: 'Engineer', description: 'This is a full-time position.' }).employment_type).toBe('full-time');
  });

  it('takes responsibilities and skills from the sections the source structured', () => {
    const result = extract({
      title: 'Software Engineer',
      description: 'We build things.',
      sourceFields: {
        sections: [
          { heading: 'Responsibilities', items: ['Ship production services', 'Review pull requests'] },
          { heading: 'Requirements', items: ["Bachelor's degree in computer science", 'Fluent in Go'] },
        ],
      },
    });
    expect(result.responsibilities).toEqual(['Ship production services', 'Review pull requests']);
    expect(result.skills).toEqual(["Bachelor's degree in computer science", 'Fluent in Go']);
    expect(result.education).toEqual(["Bachelor's degree in computer science"]);
  });

  it('drops marketing copy from the bullets', () => {
    const result = extract({
      title: 'Software Engineer',
      description: '',
      sourceFields: {
        sections: [
          {
            heading: 'What you will do',
            items: ['Thrive in a fast-paced environment', 'Ship the payments API'],
          },
        ],
      },
    });
    expect(result.responsibilities).toEqual(['Ship the payments API']);
  });
});

// ---------------------------------------------------------------------------------------
// Sections, parsed where the markup still exists
// ---------------------------------------------------------------------------------------

describe('parseSections', () => {
  it('reads headings and bullets out of HTML', () => {
    expect(parseSections('<h3>Responsibilities</h3><ul><li>Ship code</li><li>Write tests</li></ul>')).toEqual([
      { heading: 'Responsibilities', items: ['Ship code', 'Write tests'] },
    ]);
  });

  it('reads Greenhouse double-escaped HTML', () => {
    const escaped = '&lt;h3&gt;Requirements&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Fluent in Python&lt;/li&gt;&lt;/ul&gt;';
    expect(parseSections(escaped)).toEqual([{ heading: 'Requirements', items: ['Fluent in Python'] }]);
  });

  it('reads Ashby markdown', () => {
    expect(parseSections('## Requirements\n\n- Fluent in Python\n- Ships weekly')).toEqual([
      { heading: 'Requirements', items: ['Fluent in Python', 'Ships weekly'] },
    ]);
  });

  it('returns nothing for a body with no list structure', () => {
    expect(parseSections('We are hiring an engineer to work on billing.')).toEqual([]);
    expect(parseSections(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// Pay
// ---------------------------------------------------------------------------------------

describe('pay rate', () => {
  const pay = (description: string) => extract({ title: 'Engineer', description }).pay_rate;

  it('reads an annual range', () => {
    expect(pay('The salary range is $120,000 - $160,000 per year.')).toEqual({
      min: 120_000,
      max: 160_000,
      period: 'year',
    });
  });

  it('reads an hourly rate', () => {
    expect(pay('Interns are paid $55/hr.')).toEqual({ min: 55, max: null, period: 'hour' });
    expect(pay('This role pays $45 per hour.')).toEqual({ min: 45, max: null, period: 'hour' });
  });

  it('preserves explicit EUR and GBP symbols', () => {
    expect(pay('We will pay €2,100 monthly.')).toEqual({
      min: 2_100,
      max: null,
      period: 'month',
      currencySymbol: '€',
    });
    expect(pay('We pay our interns £592.00 per week.')).toEqual({
      min: 592,
      max: null,
      period: 'week',
      currencySymbol: '£',
    });
  });

  it('reads a k-suffixed range', () => {
    expect(pay('Compensation is $120k-$160k.')).toEqual({ min: 120_000, max: 160_000, period: 'year' });
  });

  it('applies a range\'s single k suffix to both ends', () => {
    // "$120-160k" writes the multiplier once and means it twice. Reading the low end as
    // $120 turned a stated salary band into an hourly rate, or into no pay at all.
    expect(pay('Compensation: $120-160k, plus equity.')).toEqual({ min: 120_000, max: 160_000, period: 'year' });
    expect(pay('Salary: $120-160k per year.')).toEqual({ min: 120_000, max: 160_000, period: 'year' });
    expect(pay('Base is $120.5k annually.')).toEqual({ min: 120_500, max: null, period: 'year' });
  });

  it('reads a range written as "and up to"', () => {
    expect(pay('Base salary will begin at $145,000 and up to $200,000.')).toEqual({
      min: 145_000,
      max: 200_000,
      period: 'year',
    });
  });

  it('infers the period from magnitude when the posting states none', () => {
    expect(pay('Base compensation of $185,000.')).toEqual({ min: 185_000, max: null, period: 'year' });
  });

  it('is not fooled by a 401(k) or a headcount', () => {
    expect(pay('We offer a 401k match and have 10k users.')).toBeNull();
  });

  it.each([
    'We provide a monthly employee wellness benefits package via Juno of $105 per month.',
    'We provide a monthly employee wellness benefits package via Juno of £75 per month.',
    'We deploy a monthly ‘employee wellness’ benefits package via Juno of £75 per month.',
    'You receive €50 each month on your Givve card.',
    'Client Book Revenue per Employee (RPE): $15,000.',
    'Fertility HRA reimbursement up to $10,000 per year.',
    "We're shaping the future of a $10T industry.",
    'Compensation is $11 one-time for completing the assessment.',
    'A one time $100 USD work from home stipend is added to your first paycheck.',
  ])('does not present non-wage money as compensation: %s', (description) => {
    expect(pay(description)).toBeNull();
  });

  it('skips a benefit amount and continues to the actual salary', () => {
    expect(
      pay('Remote employees receive a $125/week meal stipend. The base salary range is $90,000 - $115,000 annually.'),
    ).toEqual({ min: 90_000, max: 115_000, period: 'year' });
  });

  it('keeps a role stipend when it is the stated compensation', () => {
    expect(pay('The intern stipend is $1,500 per month.')).toEqual({
      min: 1_500,
      max: null,
      period: 'month',
    });
  });

  it('reads paid / unpaid, and leaves unknown as null', () => {
    const paid = (description: string) => extract({ title: 'Engineer', description }).paid;
    expect(paid('This is a paid internship at $30/hour.')).toBe(true);
    expect(paid('This internship is unpaid.')).toBe(false);
    expect(paid('This internship is for course credit only.')).toBe(false);
    expect(paid('You will build our billing service.')).toBeNull();
    // "unpaid leave" is benefits boilerplate, not this role's pay.
    expect(paid('Benefits include unpaid leave for family reasons.')).toBeNull();
  });

  it.each([
    ['UX Design Intern (Unpaid)', false],
    ['Unpaid Software Engineering Intern', false],
    ['Design - Paid Internship', true],
    ['Designer, Paid Media', null],
  ] as const)('reads compensation evidence from a title-only listing: %s', (title, paid) => {
    expect(extract({ title, description: '' }).paid).toBe(paid);
  });
});

// ---------------------------------------------------------------------------------------
// Summary — extractive, never generated
// ---------------------------------------------------------------------------------------

describe('summary', () => {
  it('takes the first sentence after the role marker', () => {
    const body = normalizeDescription(
      'About Anthropic Anthropic builds AI systems. About the role You will build evaluation tooling for frontier models. You will also write tests.',
    );
    expect(extractSummary(body)).toBe('You will build evaluation tooling for frontier models.');
  });

  it('strips a leading company preamble when there is no role marker', () => {
    const body = normalizeDescription(
      'Who we are Northwind is a logistics company serving the midwest. We move freight.',
    );
    expect(extractSummary(body)).toBe('Northwind is a logistics company serving the midwest.');
  });

  it('skips a metadata line masquerading as a sentence', () => {
    const body = normalizeDescription(
      'Location: Onsite — Austin, TX. Employment Type: Direct Hire, Full-Time. We build autonomous drone perception systems for defense.',
    );
    expect(extractSummary(body)).toBe('We build autonomous drone perception systems for defense.');
  });

  it('is copied text, never generated', () => {
    const body = 'We are building a payments platform for small businesses. It is hard work.';
    expect(body).toContain(extractSummary(body)!);
  });

  it('returns null for an empty body', () => {
    expect(extractSummary('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// Season, graduation, badges
// ---------------------------------------------------------------------------------------

describe('the smaller fields', () => {
  it('reads an internship season', () => {
    expect(extract({ title: 'SWE Intern - Summer 2027', description: '' }).internship_season).toBe('summer');
    expect(extract({ title: 'Design Co-op', description: 'This is our fall internship cohort.' }).internship_season).toBe('fall');
    expect(extract({ title: 'Backend Engineer', description: 'We ship in the spring.' }).internship_season).toBeNull();
  });

  it('reads an expected graduation window', () => {
    expect(extract({ title: 'Intern', description: 'For students graduating in May 2027.' }).expected_grad).toBe('May 2027');
    expect(extract({ title: 'Intern', description: 'Class of 2028 preferred.' }).expected_grad).toBe('2028');
    expect(extract({ title: 'Intern', description: 'You will write Go.' }).expected_grad).toBeNull();
  });

  it('derives badges from the text, and inverts a sponsorship denial', () => {
    const badges = (description: string, title = 'Engineer') =>
      extract({ title, description }).badges;
    expect(badges('We offer visa sponsorship for this role.')).toContain('visa-sponsorship');
    expect(badges('We cannot provide visa sponsorship for this role.')).not.toContain('visa-sponsorship');
    expect(badges('Requires an active security clearance.')).toContain('security-clearance');
    expect(badges('Please submit a portfolio with your application.')).toContain('portfolio-required');
    expect(badges('This is a summer internship.', 'Design Intern')).toContain('internship');
  });

  it('does not mistake non-academic uses of degree for education', () => {
    const result = extract({
      title: 'Product Designer',
      description: 'You will operate with a high degree of autonomy.',
      sourceFields: {
        sections: [
          {
            heading: 'Requirements',
            items: [
              'Operate with a high degree of autonomy',
              "Bachelor's degree in design or equivalent experience",
            ],
          },
        ],
      },
    });
    expect(result.education).toEqual(["Bachelor's degree in design or equivalent experience"]);
  });
});

// ---------------------------------------------------------------------------------------
// The drop gate
// ---------------------------------------------------------------------------------------

describe('toStored', () => {
  it('drops a track other than design or engineering', () => {
    expect(toStored(extract({ title: 'Marketing Associate', description: '' }), '')).toBeNull();
  });

  it('drops senior+', () => {
    expect(toStored(extract({ title: 'Staff Engineer', description: '' }), '')).toBeNull();
  });

  it('drops the summary for design — the Design tab has no summary column', () => {
    const body = 'You will design our onboarding flow end to end for new customers.';
    expect(toStored(extract({ title: 'Product Designer', description: body }), body)!.summary).toBeNull();
    expect(toStored(extract({ title: 'Software Engineer', description: body }), body)!.summary).not.toBeNull();
  });

  it('badges exactly the voice-AI roles, all of them engineering', () => {
    for (const fixture of POSTING_FIXTURES) {
      const body = normalizeDescription(fixture.description);
      const stored = toStored(extract({ title: fixture.title, description: body }), body);
      if (!stored) continue;
      const badged = stored.badges.includes(VOICE_BADGE);
      if (badged) expect(stored.track, fixture.title).toBe('engineering');
      // A design posting never carries the badge, whatever its body says.
      if (stored.track === 'design') expect(badged, fixture.title).toBe(false);
    }
  });

  it('discards badges outside the allowed vocabulary', () => {
    const extraction = extract({ title: 'Software Engineer', description: 'We ship code.' });
    const stored = toStored({ ...extraction, badges: ['internship', 'not-a-badge'] }, '');
    expect(stored!.badges).toEqual(['internship']);
  });
});

// ---------------------------------------------------------------------------------------
// The hand-labeled set, graded field by field
// ---------------------------------------------------------------------------------------

describe('the hand-labeled fixture set', () => {
  it.each(POSTING_FIXTURES.map((fixture) => [fixture.title, fixture] as const))(
    'extracts %s as labeled',
    (_title, fixture) => {
      const actual = run(fixture);
      for (const field of GRADED_FIELDS) {
        expect(actual[field], `${fixture.title} · ${field}`).toEqual(fixture.expected[field]);
      }
    },
  );
});

// ---------------------------------------------------------------------------------------
// Regressions from the Phase 10 review. Each one shipped in 1917e6e and each one is silent:
// no crash, no type error, no failing test — just wrong or missing data in the tab.
// ---------------------------------------------------------------------------------------

describe('a list that opens without a heading is still a list', () => {
  // Lever puts the heading in `list.text` and the bullets alone in `list.content`;
  // SmartRecruiters hands over a bare `<ul>`. Requiring a heading token first returned []
  // for both, so EVERY Lever and SmartRecruiters posting stored `sections: []` and had
  // permanently empty responsibilities / skills / education.
  it('keeps a bare <li> run', () => {
    expect(parseSections('<li>Build and ship product features</li>')).toEqual([
      { heading: '', items: ['Build and ship product features'] },
    ]);
  });

  it('keeps a bare <ul> — the SmartRecruiters shape', () => {
    expect(parseSections('<ul><li>alpha</li><li>beta</li></ul>')).toEqual([
      { heading: '', items: ['alpha', 'beta'] },
    ]);
  });

  it('takes a heading from the caller — the Lever shape', () => {
    expect(parseSections('<li>alpha</li>', 'Responsibilities')).toEqual([
      { heading: 'Responsibilities', items: ['alpha'] },
    ]);
  });

  it('keeps a bare markdown list', () => {
    expect(parseSections('- alpha\n- beta')).toEqual([{ heading: '', items: ['alpha', 'beta'] }]);
  });

  it('still prefers a heading in the markup over the fallback', () => {
    expect(parseSections('<h3>Requirements</h3><ul><li>alpha</li></ul>', 'Ignored')).toEqual([
      { heading: 'Requirements', items: ['alpha'] },
    ]);
  });
});

describe('pay amounts written without a thousands separator', () => {
  const pay = (description: string) => extract({ title: 'Design Intern', description }).pay_rate;

  // The grouped branch `\d{1,3}(?:[,.]\d{3})*` matched `150` of `1500` and everything after it
  // was optional, so the regex never backtracked to the bare `\d+` branch.
  it('reads $1500 per month as 1500 a month, not 150 an hour', () => {
    expect(pay('The stipend is $1500 per month.')).toEqual({
      min: 1500,
      max: null,
      period: 'month',
    });
  });

  it('does not silently drop $85000', () => {
    expect(pay('Salary $85000 annually.')).toEqual({ min: 85000, max: null, period: 'year' });
  });

  it.each([
    ['Salary $85,000 annually.', 85000, 'year'],
    ['We pay $55/hr.', 55, 'hour'],
    ['Up to $120k.', 120000, 'year'],
  ])('still parses %s', (description, min, period) => {
    expect(pay(description)).toMatchObject({ min, period });
  });

  it('still reads a separated range', () => {
    expect(pay('Range $120,000 - $160,000 per year.')).toMatchObject({ min: 120000, max: 160000 });
  });
});

describe('company boilerplate is not an experience requirement', () => {
  const seniority = (description: string) =>
    extract({ title: 'Software Engineer', description }).seniority;

  // These do not mislabel a posting — `toStored` drops `senior+`, so a junior or mid role at
  // any company with this boilerplate was invisible in BOTH tabs.
  it.each([
    'Founded 8 years ago, we are building the future of AI.',
    'Our CEO spent 18 years at Google leading search.',
    '10 years ago, Jeremy was frustrated with how slow deploys were.',
  ])('does not read %s as senior', (description) => {
    expect(seniority(description)).not.toBe('senior+');
  });

  it.each([
    ['We want 2-5 years of experience.', 'mid'],
    ['We want 5+ years of experience.', 'senior+'],
    ['Minimum 6 years in the field.', 'senior+'],
    // A gerund DIRECTLY after the figure is a real ask, and must keep working.
    ['You have 5 years building distributed systems.', 'senior+'],
  ])('still grades %s as %s', (description, expected) => {
    expect(seniority(description)).toBe(expected);
  });
});

describe('an explicit remote statement outranks a passing mention of hybrid', () => {
  const mode = (description: string) => extract({ title: 'Software Engineer', description }).work_mode;

  it('reads a fully remote role as remote even when hybrid appears later', () => {
    expect(mode('This is a fully remote role. Some of our teams are hybrid.')).toBe('remote');
  });

  it.each([
    'This is a hybrid role based in Austin.',
    'We follow a hybrid work model.',
    'Hybrid schedule, three days in the office.',
  ])('still reads %s as hybrid', (description) => {
    expect(mode(description)).toBe('hybrid');
  });
});

describe('an explicit in-person requirement outranks incidental remote days', () => {
  const mode = (description: string) => extract({ title: 'Product Designer', description }).work_mode;

  it('reads Koto-style studio work as onsite', () => {
    expect(
      mode(
        'You have a willingness to work in person in our London studio. We work in person, with an optional WFH day on Friday and an additional 20 remote days per year.',
      ),
    ).toBe('onsite');
    expect(
      mode(
        'You are comfortable working in person from our Culver City studio. We work in person with an optional WFH day and two weeks of remote work per year.',
      ),
    ).toBe('onsite');
  });

  it('still keeps explicit remote and hybrid roles', () => {
    expect(mode('This is a fully remote role with two in-person team events per year.')).toBe('remote');
    expect(mode('This is a hybrid role, and you will work in person three days per week.')).toBe('hybrid');
  });

  it('does not treat a negated remote phrase as remote', () => {
    expect(mode('This role is based in person in San Francisco, CA (not remote).')).toBe('onsite');
    expect(mode('This position is not a remote role and will be located in a fulfillment center.')).toBeNull();
  });
});
