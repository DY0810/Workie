import { z } from 'zod';
import { getPrivateDb } from '@/lib/private-db';
import { commandOutreach } from '@/lib/applications/outreach';
import { OutreachCommandSchema } from '@/lib/applications/outreach-protocol';
import { PrivateInputError, privateEndpoint, readPrivateJson } from '@/lib/applications/private-http';

/** Save, approve, skip or reopen one queued recruiter message. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return privateEndpoint(request, async (ownerId) => {
    if (!z.uuid().safeParse(id).success) throw new PrivateInputError(404, 'Message not found.');
    return commandOutreach(getPrivateDb(), ownerId, id, await readPrivateJson(request, OutreachCommandSchema));
  });
}
