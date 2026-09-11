import type { BotAccount, PublicAccountProfile } from '@ih3t/shared'
import { expect, test } from '@playwright/experimental-ct-react'

import ChallengeDialog from './ChallengeDialog'
import { WithQueryClient } from './withQueryClient'

test.use({
    viewport: {
        width: 1280,
        height: 1400,
    },
})

const target: PublicAccountProfile = {
    id: 'bot-2',
    username: 'Rival',
    image: null,
    role: 'user',
    kind: 'bot',
    permissions: [],
    registeredAt: 1_700_000_000_000,
    lastActiveAt: 1_700_000_500_000,
}

const ownBots: BotAccount[] = [
    {
        id: 'bot-1',
        username: 'Strix',
        image: null,
        ownerProfileId: 'owner-1',
        createdAt: 1,
        tokenRotatedAt: null,
    },
]

test('offers the owned bots, the time control and the first player', async ({ mount, page }) => {
    await page.route('**/api/bots/*/challenges', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ challenges: [] }),
        })
    })

    const component = await mount(
        <WithQueryClient>
            <ChallengeDialog
                isOpen
                onClose={() => { }}
                target={target}
                ownBots={ownBots}
            />
        </WithQueryClient>
    )

    await expect(component.getByText('Challenge a Bot')).toBeVisible()
    await expect(component.getByRole('combobox')).toHaveValue('bot-1')

    await expect(component.getByRole('button', { name: 'Challenger Starts' })).toBeVisible()
    await expect(component.getByRole('button', { name: 'Challenged Starts' })).toBeVisible()

    await component.getByRole('button', { name: 'Challenged Starts' }).click()
    await expect(component.getByRole('button', { name: 'Challenge', exact: true })).toBeEnabled()
})

test('lists the pending challenges with watch and cancel', async ({ mount, page }) => {
    const challenge = {
        challengeId: 'c_1',
        challenger: { profileId: 'bot-1', displayName: 'Strix', elo: 1_500 },
        destUser: { profileId: 'bot-2', displayName: 'Rival', elo: 1_400 },
        timeControl: { mode: 'unlimited' },
        status: 'created',
        sessionId: 'sess-1',
    }

    await page.route('**/api/bots/*/challenges', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ challenges: [challenge] }),
        })
    })

    const component = await mount(
        <WithQueryClient>
            <ChallengeDialog
                isOpen
                onClose={() => { }}
                target={target}
                ownBots={ownBots}
            />
        </WithQueryClient>
    )

    await expect(component.getByText('Pending challenges')).toBeVisible()
    await expect(component.getByText('Strix → Rival')).toBeVisible()
    await expect(component.getByRole('button', { name: 'Watch' })).toBeVisible()
    await expect(component.getByRole('button', { name: 'Cancel Challenge' })).toBeVisible()
})
