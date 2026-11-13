import { getPrivateDb } from '@/lib/private-db';
import { listOutreach, saveOutreachSettings } from '@/lib/applications/outreach';
import { OutreachSettingsSchema } from '@/lib/applications/outreach-protocol';
import { privateEndpoint, readPrivateJson } from '@/lib/applications/private-http';

export const dynamic = 'force-dynamic';
/** The recruiter messages queued for the applicant's submitted applications, and their template. */
export async function GET(request: Request) {
  return privateEndpoint(request, (ownerId) => listOutreach(getPrivateDb(), ownerId));
}
export async function PATCH(request: Request) {
  return privateEndpoint(request, async (ownerId) =>
    saveOutreachSettings(getPrivateDb(), ownerId, await readPrivateJson(request, OutreachSettingsSchema)));
}
