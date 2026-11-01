import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { driver, type ReadDb } from '../db/index.ts';
import { postings, postingSources } from '../db/schema.ts';
import type { PrivateDb } from '../private-db/index.ts';
import { applications, applicationArtifacts, applicationRuns, discoveryManifests, discoveryTargets, documents, questions, questionAnswers } from '../private-db/schema.ts';
import { ApplicationContextSchema, ApplicationContextRequestSchema, disclosureAnswerKey, type ApplicationContext } from './application-context-protocol.ts';
import { withWorker, type WorkerOptions, WorkerError, type WorkerTx, type WorkerRow } from './worker-store.ts';
import { checkedLease } from './leases.ts';
import { getPolicy, getProfile } from './stores.ts';
import { hashValue } from './stores.ts';
import { getDiscoveryCorpus } from './discovery-corpus.ts';
import { resolveApplicationIdentity } from './application-identity.ts';
import { officialContentHash } from './discovery-source.ts';
import { parseOfficialRequirements } from './official-requirements.ts';
import { ApplicationArtifactManifestSchema, artifactManifestHash } from './artifact-protocol.ts';
import { savedLetter } from './materials.ts';
import { attemptIds, equivalentAnswer } from './questions.ts';

type Fact = { state: string; value: unknown };
const factValue = <T>(fact: Fact | undefined): T | null => fact?.state === 'confirmed' ? fact.value as T : null;
const listFact = (fact: Fact | undefined) => {
  const values = factValue<unknown[]>(fact);
  return { state: fact?.state === 'declined' ? 'declined' as const : values?.length ? 'confirmed' as const : 'unknown' as const,
    values: values?.filter((value): value is string => typeof value === 'string') ?? [] };
};
const label = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
export type ApplicationContextOptions = WorkerOptions & { corpus?: () => ReadDb | Promise<ReadDb> };

function profileFacts(profile: Awaited<ReturnType<typeof getProfile>>['profile']) {
  const schools = profile.education.schools;
  const countries = listFact(profile.preferences.countries);
  const authorization = profile.authorization.countries.flatMap((item) => {
    const right = factValue<boolean>(item.rightToWork);
    return right === true ? ['authorized'] : right === false ? ['not_authorized'] : [];
  });
  const authorizationState = authorization.length && profile.authorization.countries.every((item) => item.rightToWork.state === 'confirmed')
    ? 'confirmed' as const : 'unknown' as const;
  const pay = factValue<{ amount: number; currency: string; period: string }>(profile.preferences.payFloor);
  const payPeriod = pay?.period === 'hour' || pay?.period === 'year' ? pay.period : null;
  const graduations = schools.flatMap(school => {
    const date = factValue<{ precision: string; value: string }>(school.expectedGraduation);
    return date && date.precision === 'month' ? [date.value] : [];
  });
  return {
    countries,
    degreeLevels: listFact({ state: schools.some((school) => school.level.state === 'declined') ? 'declined' : 'confirmed',
      value: schools.flatMap((school) => factValue<string>(school.level) ? [factValue<string>(school.level)!] : []) }),
    majors: listFact({ state: schools.some((school) => school.major.state === 'declined') ? 'declined' : 'confirmed',
      value: schools.flatMap((school) => factValue<string>(school.major) ? [factValue<string>(school.major)!] : []) }),
    availableTerms: listFact({ state: profile.availability.windows.length ? 'confirmed' : 'unknown',
      value: profile.availability.windows.flatMap((window) => factValue<string>(window.term) ? [factValue<string>(window.term)!] : []) }),
    expectedGraduation: { state: graduations.length === 1 ? 'confirmed' as const : 'unknown' as const, month: graduations.length === 1 ? graduations[0] : null },
    workAuthorization: { state: authorizationState, values: authorization },
    pay: { state: pay ? 'confirmed' as const : 'unknown' as const, currency: pay?.currency ?? null,
      amount: pay?.amount ?? null, period: payPeriod },
  };
}

export function applicationAnswers(profile: Awaited<ReturnType<typeof getProfile>>['profile'], authorized: string[], company: string,
  postingCountry: string | null = null, disclosure: 'confirmed_only' | 'ask_each_sensitive' = 'ask_each_sensitive') {
  const answers: Record<string, string | boolean | string[]> = {};
  const first = factValue<string>(profile.identity.legalFirstName) ?? factValue<string>(profile.identity.preferredName);
  const last = factValue<string>(profile.identity.legalLastName);
  const email = factValue<string>(profile.identity.personalEmail) ?? factValue<string>(profile.identity.schoolEmail);
  if (first) answers.first_name = first;
  if (last) answers.last_name = last;
  if (email) answers.email = email;
  const phone = profile.identity.phones.find(item => factValue<string>(item.number));
  if (phone) {
    answers.phone = factValue<string>(phone.number)!;
    const phoneCountry = factValue<string>(phone.country);
    if (phoneCountry) answers.phone_country = phoneCountry;
  }
  const currentLocation = factValue<string>(profile.identity.currentLocation);
  if (currentLocation) answers.current_location = currentLocation;
  const linkedin = factValue<string>(profile.identity.linkedin);
  if (linkedin) answers.linkedin = linkedin;
  const portfolio = factValue<string>(profile.identity.portfolio);
  if (portfolio) answers.portfolio = portfolio;
  const github = factValue<string>(profile.identity.github);
  if (github) answers.github = github;
  // Any confirmed voluntary answer goes to the form, but only when the policy allows sensitive disclosure without asking;
  // under ask_each_sensitive each form asks. One the form does not offer is asked with its options.
  if (disclosure === 'confirmed_only') {
    const pronouns = factValue<string>(profile.voluntary.pronouns);
    if (pronouns) answers.voluntary_pronouns = pronouns;
    const gender = factValue<string>(profile.voluntary.gender);
    if (gender) answers.voluntary_gender = ({ man: 'Male', woman: 'Female' } as Record<string, string>)[label(gender)] ?? gender;
    const race = factValue<string[]>(profile.voluntary.raceEthnicity);
    if (race?.includes('Not Hispanic or Latino')) answers.voluntary_hispanic = 'No';
    else if (race?.includes('Hispanic or Latino')) answers.voluntary_hispanic = 'Yes';
    const veteran = factValue<string>(profile.voluntary.veteran);
    if (veteran) answers.voluntary_veteran = /^(never|not) a veteran$/.test(label(veteran)) ? 'I am not a protected veteran' : veteran;
    const disability = factValue<string>(profile.voluntary.disability);
    if (disability) answers.voluntary_disability = disability;
  }
  const school = profile.education.schools.find(item => factValue<string>(item.school));
  if (school) {
    const name = factValue<string>(school.school);
    const level = factValue<string>(school.level);
    const major = factValue<string>(school.major);
    const start = factValue<{ value: string }>(school.enrollmentStart);
    const graduation = factValue<{ precision: string; value: string }>(school.expectedGraduation);
    const gpa = factValue<{ value: number; scale: number }>(school.gpa);
    if (name) answers['school--0'] = name;
    if (level) answers['degree--0'] = level;
    if (major) answers['discipline--0'] = major;
    if (start) answers['start-year--0'] = start.value.slice(0, 4);
    if (start && start.value.length >= 7) answers.start_month = start.value.slice(0, 7);
    if (graduation) answers['end-year--0'] = graduation.value.slice(0, 4);
    if (factValue<string>(school.status) === 'in_progress' && graduation?.precision === 'month') {
      answers.expected_graduation_month = graduation.value;
    }
    if (gpa) answers.gpa = String(gpa.value);
  }
  const usAuthorization = profile.authorization.countries.find(item => factValue<string>(item.country) === 'US');
  if (usAuthorization) {
    const sponsorship = factValue<boolean>(usAuthorization.sponsorshipNow);
    if (sponsorship !== null) answers.sponsorship_now = sponsorship ? 'Yes' : 'No';
  }
  // Per-country work rights for the US and for the posting's own country, so differently worded
  // Greenhouse questions resolve from confirmed facts instead of reaching the inbox again.
  const yesNo = (value: boolean | null) => value === null ? null : value ? 'Yes' : 'No';
  for (const [prefix, code] of [['us', 'US'], ['posting', postingCountry]] as const) {
    const item = code ? profile.authorization.countries.find(entry => factValue<string>(entry.country) === code) : undefined;
    if (!item) continue;
    const now = factValue<boolean>(item.sponsorshipNow), future = factValue<boolean>(item.sponsorshipFuture);
    const rights = {
      authorized: yesNo(factValue<boolean>(item.rightToWork)), sponsorship_now: yesNo(now),
      // "Now or in the future": Yes if either is true, No only when both are confirmed false.
      sponsorship_ever: now === true || future === true ? 'Yes' : now === false && future === false ? 'No' : null,
    };
    for (const [key, value] of Object.entries(rights)) if (value) answers[`${prefix}_${key}`] = value;
  }
  if (authorized.includes('authorized')) {
    answers.authorized = 'Yes'; answers.work_authorization = 'Yes';
  } else if (authorized.includes('not_authorized')) {
    answers.authorized = 'No'; answers.work_authorization = 'No';
  }
  for (const item of profile.disclosures.answers) {
    const employer = factValue<string>(item.employer);
    const question = factValue<string>(item.exactQuestion);
    const answer = factValue<boolean>(item.answer);
    if (employer && question && answer !== null && label(employer) === label(company) &&
        item.meaning.state === 'confirmed' && item.timeframe.state === 'confirmed' &&
        item.includesSubsidiaries.state === 'confirmed' && item.answer.scope.kind === 'employer' &&
        label(item.answer.scope.employer ?? '') === label(company) && !item.answer.scope.includesSubsidiaries &&
        item.answer.scope.timeframe === item.timeframe.value) {
      answers[disclosureAnswerKey(question)] = answer ? 'Yes' : 'No';
    }
  }
  return answers;
}

async function ownedContext(tx: WorkerTx, worker: WorkerRow, lease: { applicationId: string; fence: number; expectedRevision: number }, now: number, options: ApplicationContextOptions): Promise<ApplicationContext> {
  const [owned] = await tx.select().from(applications).where(and(eq(applications.ownerId, worker.ownerId), eq(applications.id, lease.applicationId)));
  if (!owned || owned.workerId !== worker.id) throw new WorkerError(404, 'NOT_FOUND', 'Application not found.');
  const checked = await checkedLease(tx, worker, { applicationId: lease.applicationId, fence: lease.fence, expectedRevision: lease.expectedRevision }, now);
  if (checked instanceof WorkerError) throw checked;
  const [run] = await tx.select().from(applicationRuns).where(and(eq(applicationRuns.ownerId, worker.ownerId), eq(applicationRuns.id, checked.runId), eq(applicationRuns.workerId, worker.id)));
  if (!run) throw new WorkerError(409, 'LEASE_LOST', 'Application run is unavailable.');
  const policy = await getPolicy(tx, worker.ownerId, now);
  if (!policy.enabled || policy.revision !== run.policyRevision || policy.policyVersion !== run.policyVersion || policy.policyHash !== run.policyHash) {
    throw new WorkerError(403, 'POLICY_CHANGED', 'Application policy is no longer active.');
  }
  if (!checked.snapshotManifestId || !checked.snapshotTargetKey) throw new WorkerError(409, 'CONTEXT_UNAVAILABLE', 'Application snapshot is unavailable.');
  const [target] = await tx.select().from(discoveryTargets).where(and(
    eq(discoveryTargets.ownerId, worker.ownerId), eq(discoveryTargets.runId, checked.runId),
    eq(discoveryTargets.manifestId, checked.snapshotManifestId), eq(discoveryTargets.targetKey, checked.snapshotTargetKey),
  ));
  const [manifest] = await tx.select().from(discoveryManifests).where(and(
    eq(discoveryManifests.ownerId, worker.ownerId), eq(discoveryManifests.id, checked.snapshotManifestId),
  ));
  if (!target || !manifest || manifest.state !== 'ready' || hashValue(manifest.artifact) !== manifest.hash) {
    throw new WorkerError(409, 'CONTEXT_UNAVAILABLE', 'Application snapshot is not ready.');
  }
  const candidate = manifest.artifact.candidates[target.candidateIndex];
  if (!candidate || manifest.artifact.schemaVersion !== 2 || hashValue(candidate) !== target.candidateHash || candidate.disposition !== 'candidate' ||
      !candidate.identity || candidate.identity.ats !== checked.ats || candidate.identity.tenant !== checked.tenant ||
      candidate.identity.requisition !== checked.requisition || !candidate.officialUrl || !candidate.postings.length ||
      !candidate.officialPostingId || !candidate.officialContentHash) {
    throw new WorkerError(409, 'IDENTITY_MISMATCH', 'Application context does not match the frozen role.');
  }
  const corpus = await (options.corpus?.() ?? getDiscoveryCorpus());
  const [official] = await driver(corpus).select({
    postingId: postings.id, canonicalUrl: postings.canonicalUrl, company: postings.company, title: postings.title,
    country: postings.country, location: postings.location, description: postings.description, sourceFields: postings.sourceFields,
    paid: postings.paid,
  }).from(postings).where(eq(postings.id, candidate.officialPostingId)).limit(1).all();
  const officialSources = official ? await driver(corpus).select({
    source: postingSources.source, sourceUrl: postingSources.sourceUrl, publisherId: postingSources.publisherId,
  }).from(postingSources).where(eq(postingSources.postingId, candidate.officialPostingId)).all() : [];
  const officialResolution = official ? resolveApplicationIdentity(official.canonicalUrl, officialSources) : null;
  if (!official || !official.description?.trim() || official.description.length > 100_000 ||
      officialResolution?.identity?.ats !== candidate.identity.ats ||
      officialResolution?.identity?.tenant !== candidate.identity.tenant ||
      officialResolution?.identity?.requisition !== candidate.identity.requisition ||
      officialResolution?.officialUrl !== candidate.officialUrl) {
    throw new WorkerError(409, 'IDENTITY_MISMATCH', 'Official posting identity changed.');
  }
  if (officialContentHash({
    canonicalUrl: official.canonicalUrl, company: official.company, title: official.title,
    country: official.country, location: official.location, description: official.description,
    sourceFields: official.sourceFields,
  }) !== candidate.officialContentHash) {
    throw new WorkerError(409, 'CONTEXT_UNAVAILABLE', 'Official posting content changed.');
  }
  const profileResponse = await getProfile(tx, worker.ownerId);
  const profile = profileResponse.profile;
  const facts = profileFacts(profile);
  const parsedRequirements = parseOfficialRequirements({
    sourceUrl: candidate.officialUrl, company: official.company, title: official.title,
    country: official.country, location: official.location, description: official.description,
    sourceFields: official.sourceFields, paid: official.paid,
  });
  const requirements = { ...parsedRequirements, excerpts: [...new Set([...parsedRequirements.excerpts, ...candidate.reasons])].slice(0, 32) };
  const answers = applicationAnswers(profile, facts.workAuthorization.values, official.company,
    requirements.countries.length === 1 ? requirements.countries[0] : null, policy.policy.disclosure);
  const screeningAnswers = await tx.select({ question: questions, answer: questionAnswers }).from(questions)
    .innerJoin(questionAnswers, and(eq(questionAnswers.ownerId, questions.ownerId), eq(questionAnswers.id, questions.answerId)))
    .where(and(eq(questions.ownerId, worker.ownerId), eq(questions.applicationId, checked.id), eq(questions.active, true)));
  // A retry reuses answers given to earlier attempts of the same role; another role lends only an equivalent form answer
  // (questions.ts reusableAnswer).
  const attempts = await attemptIds(tx, checked);
  for (const { question, answer } of screeningAnswers) {
    if (!question.resolvedAt || question.policyRevision !== policy.revision || question.descriptor.scope.applicationId !== checked.id ||
        (!attempts.includes(answer.applicationId) && !equivalentAnswer(question.descriptor, answer))) continue;
    // A form question passes its answer through in the shape its field takes: options for a multi-select, yes/no for a checkbox.
    if (question.key.startsWith('form-') && (answer.value.type === 'choices' || answer.value.type === 'boolean')) {
      if (answer.value.type === 'boolean' || answer.value.value.length) answers[question.key] = answer.value.value;
      continue;
    }
    if (answer.value.type !== 'text' && answer.value.type !== 'choice') continue;
    const value = answer.value.value.trim();
    if (!value) continue;
    if (question.key === 'screening-country' && /^[A-Z]{2}$/.test(value)) facts.countries = { state: 'confirmed', values: [value] };
    if (question.key === 'screening-degree') facts.degreeLevels = { state: 'confirmed', values: [value] };
    if (question.key === 'screening-major') facts.majors = { state: 'confirmed', values: [value] };
    if (question.key === 'screening-term') facts.availableTerms = { state: 'confirmed', values: [value] };
    if (question.key === 'screening-graduation' && /^20\d{2}-(0[1-9]|1[0-2])$/.test(value)) facts.expectedGraduation = { state: 'confirmed', month: value };
    if (question.key === 'screening-authorization' && ['authorized', 'not_authorized'].includes(value)) {
      facts.workAuthorization = { state: 'confirmed', values: [value] };
      answers.authorized = value === 'authorized' ? 'Yes' : 'No';
      answers.work_authorization = answers.authorized;
    }
    if (question.key === 'screening-employer-pay' && value === 'accept') {
      facts.pay = { state: 'unknown', currency: null, amount: null, period: null };
    }
    if (question.key.startsWith('form-')) answers[question.key] = value;
  }
  const masters = profile.documentsProvider.masters
    .map((master) => ({ master, role: factValue<string>(master.role), ref: factValue<{ documentId: string; version: number }>(master.document) }))
    .filter((item): item is { master: typeof item.master; role: string | null; ref: { documentId: string; version: number } } => item.ref !== null);
  masters.sort((a, b) => Number(label(official.title).includes(label(b.role ?? ''))) - Number(label(official.title).includes(label(a.role ?? ''))));
  const documentsByKey: Record<string, ApplicationContext['documents'][string]> = {};
  // The applicant's confirmed transcript, only when the policy lets Workie send one.
  const transcriptRef = policy.policy.documentKinds.includes('transcript') ? profile.education.schools
    .map((item) => factValue<{ documentId: string; version: number }>(item.transcript)).find((ref) => ref !== null) : undefined;
  if (transcriptRef) {
    const [transcript] = await tx.select().from(documents).where(and(
      eq(documents.ownerId, worker.ownerId), eq(documents.id, transcriptRef.documentId), eq(documents.version, transcriptRef.version),
      eq(documents.state, 'available'), eq(documents.safetyCheck, 'passed'),
    ));
    if (transcript?.sha256) documentsByKey.transcript = {
      documentId: transcript.id, version: transcript.version, sha256: transcript.sha256, size: transcript.size,
      mime: transcript.mime as 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      path: `/api/worker/applications/${checked.id}/documents/${transcript.id}`,
    };
  }
  const selected = masters[0];
  let selectedDocument: typeof documents.$inferSelect | undefined;
  if (selected) {
    const [document] = await tx.select().from(documents).where(and(
      eq(documents.ownerId, worker.ownerId), eq(documents.id, selected.ref.documentId), eq(documents.version, selected.ref.version),
      eq(documents.state, 'available'), eq(documents.safetyCheck, 'passed'),
    ));
    selectedDocument = document;
    if (document?.sha256) documentsByKey.resumeMaster = {
      documentId: document.id, version: document.version, sha256: document.sha256, size: document.size, mime: document.mime as 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      path: `/api/worker/applications/${checked.id}/documents/${document.id}`,
    };
  }
  if (selectedDocument?.sha256) {
    const [saved] = await tx.select({ artifact: applicationArtifacts, document: documents }).from(applicationArtifacts)
      .innerJoin(documents, and(eq(documents.ownerId, applicationArtifacts.ownerId), eq(documents.id, applicationArtifacts.documentId)))
      .where(and(eq(applicationArtifacts.ownerId, worker.ownerId), eq(applicationArtifacts.applicationId, checked.id),
        eq(applicationArtifacts.sourceDocumentId, selectedDocument.id), eq(applicationArtifacts.sourceVersion, selectedDocument.version),
        eq(applicationArtifacts.sourceHash, selectedDocument.sha256), eq(documents.state, 'available'), eq(documents.safetyCheck, 'passed')))
      .orderBy(desc(applicationArtifacts.createdAt)).limit(1);
    if (saved) {
      let manifest: ReturnType<typeof ApplicationArtifactManifestSchema.parse>;
      try { manifest = ApplicationArtifactManifestSchema.parse(saved.artifact.manifest); }
      catch { throw new WorkerError(409, 'ARTIFACT_INVALID', 'Stored application artifact manifest is invalid.'); }
      if (saved.artifact.manifestHash !== artifactManifestHash(manifest) || manifest.applicationId !== checked.id ||
          manifest.source.documentId !== selectedDocument.id || manifest.source.version !== selectedDocument.version ||
          manifest.source.sha256 !== selectedDocument.sha256 || manifest.output.sha256 !== saved.document.sha256 ||
          manifest.output.size !== saved.document.size || manifest.output.mime !== saved.document.mime ||
          saved.artifact.outputHash !== saved.document.sha256) {
        throw new WorkerError(409, 'ARTIFACT_INVALID', 'Stored application artifact does not match its document.');
      }
      documentsByKey.resume = {
        documentId: saved.document.id, version: saved.document.version, sha256: saved.document.sha256,
        size: saved.document.size, mime: saved.document.mime as 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        path: `/api/worker/applications/${checked.id}/documents/${saved.document.id}`,
      };
      documentsByKey.resumeMaster ??= {
        documentId: selectedDocument.id, version: selectedDocument.version, sha256: selectedDocument.sha256,
        size: selectedDocument.size, mime: selectedDocument.mime as 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        path: `/api/worker/applications/${checked.id}/documents/${selectedDocument.id}`,
      };
      return ApplicationContextSchema.parse({
        protocolVersion: 1, applicationId: checked.id, runId: checked.runId, ownerId: worker.ownerId,
        policyRevision: run.policyRevision, profileRevision: profileResponse.revision, identity: candidate.identity, company: official.company, role: official.title,
        coverLetterAllowed: policy.policy.documentKinds.includes('cover_letter'), letter: await savedLetter(tx, worker.ownerId, checked.id),
        track: policy.policy.filters.tab,
        applicationUrl: candidate.officialUrl, facts, requirements, answers, documents: documentsByKey,
        tailoredArtifact: { documentId: saved.document.id, version: saved.document.version, sourceDocumentId: selectedDocument.id,
          sourceVersion: selectedDocument.version, sourceHash: selectedDocument.sha256, verificationManifestHash: saved.artifact.manifestHash,
          outputHash: saved.document.sha256 }, manifestHash: saved.artifact.manifestHash, artifactHashes: [saved.document.sha256], createdAt: now,
      });
    }
    documentsByKey.resume = documentsByKey.resumeMaster;
  }
  return ApplicationContextSchema.parse({
    protocolVersion: 1, applicationId: checked.id, runId: checked.runId, ownerId: worker.ownerId,
    policyRevision: run.policyRevision, profileRevision: profileResponse.revision, identity: candidate.identity, company: official.company, role: official.title,
    coverLetterAllowed: policy.policy.documentKinds.includes('cover_letter'), letter: await savedLetter(tx, worker.ownerId, checked.id),
    track: policy.policy.filters.tab,
    applicationUrl: candidate.officialUrl, facts, requirements, answers, documents: documentsByKey,
    tailoredArtifact: null, manifestHash: null, artifactHashes: [], createdAt: now,
  });
}

export async function applicationContext(
  db: PrivateDb, token: string, applicationId: string, input: unknown, options: ApplicationContextOptions = {},
) {
  const command = ApplicationContextRequestSchema.parse(input);
  if (command.applicationId !== applicationId) throw new WorkerError(400, 'INVALID_INPUT', 'Application context ID mismatch.');
  return withWorker(db, token, options, async (tx, worker, now) => ownedContext(tx, worker, command, now, options));
}

export async function applicationDocumentOwner(
  db: PrivateDb, token: string, applicationId: string, documentId: string, options: WorkerOptions = {},
) {
  if (!z.uuid().safeParse(applicationId).success || !z.uuid().safeParse(documentId).success) {
    throw new WorkerError(400, 'INVALID_INPUT', 'Invalid document path.');
  }
  return withWorker(db, token, options, async (tx, worker) => {
    const [app] = await tx.select({ id: applications.id }).from(applications).where(and(
      eq(applications.ownerId, worker.ownerId), eq(applications.id, applicationId), eq(applications.workerId, worker.id),
    ));
    const [document] = await tx.select().from(documents).where(and(
      eq(documents.ownerId, worker.ownerId), eq(documents.id, documentId), eq(documents.state, 'available'), eq(documents.safetyCheck, 'passed'),
    ));
    if (!app || !document || !document.sha256) throw new WorkerError(404, 'NOT_FOUND', 'Document not found.');
    return document;
  });
}
