import type { BotListing, CreateOwnerBotChallengeRequest, OwnerBotChallenge, OwnerBotChallengesResponse } from '@ih3t/shared';
import { useQuery } from '@tanstack/react-query';

import { fetchJson, fetchOptionalJson } from './apiClient';
import { queryKeys } from './queryDefinitions';

/** The public roster; null while BOT_API_ENABLED is off, because the route is not mounted. */
async function fetchBots(onlineOnly: boolean) {
    return await fetchOptionalJson<BotListing[]>(onlineOnly ? `/api/bots?online=1` : `/api/bots`);
}

export function useQueryBots(options: { onlineOnly?: boolean } = {}) {
    const onlineOnly = options.onlineOnly ?? false;
    return useQuery({
        queryKey: onlineOnly ? queryKeys.onlineBots : queryKeys.bots,
        queryFn: () => fetchBots(onlineOnly),
        staleTime: 15 * 1000,
    });
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
