/**
 * Handles requests from content scripts. Kept free of Chrome APIs so it can be tested
 * end-to-end against a real (fake-indexeddb backed) repository.
 */
import type {
  BackgroundRequest,
  SessionBatchResponse,
  SessionBeginResponse,
  SessionEndResponse,
} from '../shared/protocol';
import { EXTRACTOR_VERSION, emptyCounters, type SessionRecord } from '../shared/types';
import type { ArchiveRepository } from '../storage/repository';

export interface RouterDeps {
  getRepository: () => Promise<ArchiveRepository>;
  now: () => Date;
  newId: () => string;
  staleSessionMs: number;
}

export interface RequestContext {
  /** Tab the request came from (null for extension pages). */
  tabId: number | null;
}

const MAX_SESSION_WARNINGS = 50;

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid request: ${name} is required`);
  return value;
}

function requireArray<T>(value: unknown, name: string): T[] {
  if (!Array.isArray(value)) throw new Error(`Invalid request: ${name} must be an array`);
  return value as T[];
}

export async function handleBackgroundRequest(
  request: BackgroundRequest,
  context: RequestContext,
  deps: RouterDeps,
): Promise<SessionBeginResponse | SessionBatchResponse | SessionEndResponse | { recorded: boolean }> {
  const repository = await deps.getRepository();
  const now = deps.now();
  const nowIso = now.toISOString();

  switch (request.type) {
    case 'session/begin': {
      const conversationKey = requireString(request.conversation?.conversationKey, 'conversation.conversationKey');
      await repository.markStaleSessions(now.getTime(), deps.staleSessionMs);
      // A new session from a tab means any earlier session of that tab is no longer running.
      if (context.tabId !== null) await repository.markStaleSessions(now.getTime(), 0, context.tabId);
      const conversation = (await repository.getConversation(conversationKey)) ?? null;
      const session: SessionRecord = {
        sessionId: deps.newId(),
        conversationKey,
        conversationTitle: request.conversation.title,
        mode: request.mode,
        rescan: Boolean(request.rescan),
        status: 'running',
        stopReason: null,
        error: null,
        resumeOf: request.resumeOf ?? null,
        tabId: context.tabId,
        startedAt: nowIso,
        updatedAt: nowIso,
        endedAt: null,
        counters: emptyCounters(),
        warnings: [],
        extractorVersion: EXTRACTOR_VERSION,
      };
      await repository.createSession(session);
      return { sessionId: session.sessionId, coverage: conversation?.coverage ?? [], conversation };
    }

    case 'session/batch': {
      const sessionId = requireString(request.sessionId, 'sessionId');
      const messages = requireArray(request.messages, 'messages');
      const session = await repository.getSession(sessionId);
      if (!session) throw new Error(`Unknown session ${sessionId}`);
      if (session.conversationKey !== request.conversation?.conversationKey) {
        throw new Error('Batch conversation does not match the session conversation');
      }
      const result = await repository.upsertObservations({
        conversation: request.conversation,
        messages: messages as never,
        sessionId,
        segments: requireArray(request.segments ?? [], 'segments'),
        now,
      });
      // A session wrongly marked as interrupted (e.g. after the computer slept) is revived here;
      // one that its tab already reported as ended keeps its final status.
      await repository.updateSession(
        sessionId,
        {
          status: 'running',
          stopReason: null,
          endedAt: null,
          updatedAt: nowIso,
          counters: request.counters,
          warnings: (request.warnings ?? []).slice(0, MAX_SESSION_WARNINGS),
        },
        { skipIfEnded: true },
      );
      return { statuses: result.statuses };
    }

    case 'session/heartbeat': {
      const sessionId = requireString(request.sessionId, 'sessionId');
      // A heartbeat still in flight when the session ended must not reopen it.
      const updated = await repository.updateSession(
        sessionId,
        {
          status: request.status === 'paused' ? 'paused' : 'running',
          stopReason: null,
          endedAt: null,
          updatedAt: nowIso,
          counters: request.counters,
        },
        { skipIfEnded: true },
      );
      return { recorded: updated !== null };
    }

    case 'session/end': {
      const sessionId = requireString(request.sessionId, 'sessionId');
      const conversationKey = requireString(request.conversationKey, 'conversationKey');
      const segments = requireArray(request.segments ?? [], 'segments');
      if (segments.length > 0) await repository.mergeCoverage(conversationKey, segments as never);
      const replies = await repository.resolveReplies(conversationKey);
      await repository.updateSession(sessionId, {
        status: request.status,
        stopReason: request.stopReason,
        error: request.error,
        counters: request.counters,
        warnings: (request.warnings ?? []).slice(0, MAX_SESSION_WARNINGS),
        updatedAt: nowIso,
        endedAt: nowIso,
      });
      return { replies };
    }

    default:
      throw new Error(`Unknown request type ${(request as { type?: string }).type}`);
  }
}
