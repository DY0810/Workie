import { describe, expect, it } from 'vitest';
import { parseOfficialRequirements } from './official-requirements.ts';

const base = {
  sourceUrl: 'https://job-boards.greenhouse.io/acme/jobs/123', company: 'Acme', title: 'Software Engineer Intern',
  country: 'US', location: 'Remote, United States', sourceFields: null, paid: null,
};

describe('parseOfficialRequirements', () => {
  it('extracts only explicit official requirements and preserves the exact body', () => {
    const description = `Join us for a Summer 2027 internship. Candidates must be authorized to work in the US without sponsorship.\n\nRequirements\n- Pursuing a bachelor's degree in computer science.\n- Paid at USD 45/hour.`;
    expect(parseOfficialRequirements({ ...base, description })).toMatchObject({
      officialDescription: description, countries: ['US'], degreeLevels: ['bachelor'], majors: ['computer science'],
      terms: ['summer 2027'], authorizationRequired: true, paid: true,
      payFloor: { currency: 'USD', amount: 45, period: 'hour' },
    });
  });

  it('does not invent degree, major, term, authorization, or pay-floor facts', () => {
    expect(parseOfficialRequirements({ ...base, description: 'You will work with a small product team.' })).toMatchObject({
      degreeLevels: [], majors: [], terms: [], authorizationRequired: false, paid: null, payFloor: null,
    });
  });

  it('does not turn product and data work into required academic majors', () => {
    const description = `Figma makes design accessible to all. Build product or business data pipelines and help design datasets. We welcome students curious about data engineering.`;
    expect(parseOfficialRequirements({ ...base, title: 'Data Engineer Intern (2027)', description })).toMatchObject({
      degreeLevels: [], majors: [], graduationWindow: null,
    });
  });

  it('reads abbreviated degrees as degree levels, not only the Ph.D.', () => {
    const description = `WHAT WE'RE LOOKING FOR\n - Currently pursuing a B.S., M.S. or Ph.D. in CS, AI/ML, data science or a related field.`;
    expect(parseOfficialRequirements({ ...base, description }).degreeLevels.sort()).toEqual(['bachelor', 'doctorate', 'master']);
  });

  it('does not read the verb "master" as a master\'s degree', () => {
    const description = `You love to master new technologies and concepts.\nCompleted at least your 2nd year of a Computer Science, Engineering, or related technical degree.`;
    expect(parseOfficialRequirements({ ...base, description }).degreeLevels).toEqual([]);
    expect(parseOfficialRequirements({ ...base, description: 'Pursuing a Master of Science or masters degree.' }).degreeLevels).toEqual(['master']);
  });

  it('does not turn flattened job duties into required majors', () => {
    const description = `WHAT YOU'LL DO Build systems from design through launch Solve problems in payments, risk, finance, data, and AI Work with product and business teams WHAT YOU'LL NEED Currently pursuing a B.S. or higher in Computer Science or a related technical field, graduating December 2027 or later Strong programming fundamentals Track record of shipping products Ability to turn business problems into engineering solutions.`;
    expect(parseOfficialRequirements({ ...base, description })).toMatchObject({
      majors: ['computer science'], graduationWindow: { earliest: '2027-12', latest: '2099-12' },
    });
  });

  it('recognizes an explicit unpaid condition over a generic internship title', () => {
    expect(parseOfficialRequirements({ ...base, description: 'Fall internship for course credit only. This is unpaid.' })).toMatchObject({
      terms: ['fall'], paid: false,
    });
  });

  it('keeps a graduation window separate from the internship term', () => {
    expect(parseOfficialRequirements({ ...base, description: 'Summer 2028 internship. Candidates graduating between Winter 2027 and Summer 2028 are eligible.' })).toMatchObject({
      terms: ['summer 2028'], graduationWindow: { earliest: '2026-12', latest: '2028-08' },
    });
    expect(parseOfficialRequirements({ ...base, description: 'Graduating in December 2028.' })).toMatchObject({
      terms: [], graduationWindow: { earliest: '2028-12', latest: '2028-12' },
    });
    expect(parseOfficialRequirements({ ...base, description: 'Summer 2028 internship for students graduating between Winter 2027 and Summer 2028.' })).toMatchObject({
      terms: ['summer 2028'], graduationWindow: { earliest: '2026-12', latest: '2028-08' },
    });
    expect(parseOfficialRequirements({ ...base, description: 'Summer 2027 internship. Applicants graduating in Fall 2027 or later are eligible.' })).toMatchObject({
      terms: ['summer 2027'], graduationWindow: { earliest: '2027-09', latest: '2099-12' },
    });
  });
});
