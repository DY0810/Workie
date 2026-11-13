import { workerEndpoint } from '@/lib/applications/worker-http';
/** The worker's report on a recruiter message it was handed: sent, not sent (and why), or unconfirmed. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return workerEndpoint(request, 'outreach-result', (await params).id);
}
