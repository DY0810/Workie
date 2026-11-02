import { browserWorkerEndpoint } from '@/lib/applications/worker-http';

export const POST = async (request: Request, context: { params: Promise<{ id: string }> }) =>
  browserWorkerEndpoint(request, 'review-edits', (await context.params).id);
