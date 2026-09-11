import type { BotListing, CreateBotSessionRequest, CreateSessionResponse } from '@ih3t/shared';
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
