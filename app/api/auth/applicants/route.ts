import { listApplicantSessions, selectApplicantSession } from '@/lib/applicant-sessions';
import { privateJson, sameOriginMutation } from '@/lib/applicant-access';
import { readHouseholdConfig } from '@/lib/household-auth';
import { PrivateInputError, readPrivateJson } from '@/lib/applications/private-http';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

export const GET = (request: Request) => listApplicantSessions(request);

export async function POST(request: Request) {
  try {
    // Switching rewrites the session cookie, so another site must not be able to trigger it.
    const denied = sameOriginMutation(request, readHouseholdConfig().origin);
    if (denied) return denied;
    return await selectApplicantSession(request, await readPrivateJson(request, z.unknown()));
  } catch (error) {
    return error instanceof PrivateInputError
      ? privateJson({ error: error.message }, { status: error.status })
      : privateJson({ error: 'Could not switch applicant profile.' }, { status: 503 });
  }
}
