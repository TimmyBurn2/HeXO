import type { BotListing, CreateBotSessionRequest, CreateOwnerBotChallengeRequest, CreateSessionResponse, OwnerBotChallenge, OwnerBotChallengesResponse } from '@ih3t/shared';
import { useQuery } from '@tanstack/react-query';

import { fetchJson, fetchOptionalJson } from './apiClient';
import { queryKeys } from './queryDefinitions';

/** The public roster; null while BOT_API_ENABLED is off, because the route is not mounted. */
async function fetchBots() {
    return await fetchOptionalJson<BotListing[]>(`/api/bots`);
}

export function useQueryBots() {
    return useQuery({
        queryKey: queryKeys.bots,
        queryFn: fetchBots,
        staleTime: 15 * 1000,
    });
}

/** Starts a private, reserved-seat session against a bot; the caller joins it. */
export async function createBotSession(botProfileId: string, request: CreateBotSessionRequest) {
    const response = await fetchJson<CreateSessionResponse>(`/api/bots/${encodeURIComponent(botProfileId)}/session`, {
        method: `POST`,
        headers: {
            'Content-Type': `application/json`,
        },
        body: JSON.stringify(request),
    });

    return response.sessionId;
}

/** The owner's pending challenges against one bot; null while the flag is off. */
export function useQueryBotChallenges(botProfileId: string, options?: { enabled?: boolean }) {
    return useQuery({
        queryKey: queryKeys.botChallenges(botProfileId),
        queryFn: () => fetchOptionalJson<OwnerBotChallengesResponse>(`/api/bots/${encodeURIComponent(botProfileId)}/challenges`),
        enabled: options?.enabled,
        /* A pending challenge ends on the bots' schedule, not the dialog's. */
        refetchInterval: 5_000,
    });
}

/** Makes an owned bot challenge another bot; the session id is for spectating. */
export async function createBotChallenge(botProfileId: string, request: CreateOwnerBotChallengeRequest): Promise<OwnerBotChallenge> {
    return await fetchJson<OwnerBotChallenge>(`/api/bots/${encodeURIComponent(botProfileId)}/challenge`, {
        method: `POST`,
        headers: {
            'Content-Type': `application/json`,
        },
        body: JSON.stringify(request),
    });
}

/** Withdraws one of the owner's pending challenges. */
export async function cancelBotChallenge(botProfileId: string, challengeId: string) {
    await fetchJson<{ ok: boolean }>(`/api/bots/${encodeURIComponent(botProfileId)}/challenge/${encodeURIComponent(challengeId)}/cancel`, {
        method: `POST`,
    });
}
