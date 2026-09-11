import type { BotListing } from '@ih3t/shared'
import { expect, test } from '@playwright/experimental-ct-react'

import BotRosterScreen from './BotRosterScreen'

test.use({
    viewport: {
        width: 1280,
        height: 960,
    },
})

const onlineBot: BotListing = {
    profileId: 'bot-online',
    displayName: 'Strix',
    elo: 1_500,
    owner: 'owner-1',
    online: true,
    openForChallenges: false,
}

const offlineBot: BotListing = {
    profileId: 'bot-offline',
    displayName: 'Dormant',
    elo: 900,
    owner: 'owner-2',
    online: false,
    openForChallenges: false,
}

test('lists bots and only offers play against a connected one', async ({ mount }) => {
    const played: string[] = []

    const component = await mount(
        <BotRosterScreen
            account={null}
            bots={[onlineBot, offlineBot]}
            onPlay={(bot) => {
                played.push(bot.profileId)
            }}
        />
    )

    await expect(component.getByText('Strix')).toBeVisible()
    await expect(component.getByText('Dormant')).toBeVisible()

    const playButtons = component.getByRole('button', { name: 'Play' })
    await expect(playButtons).toHaveCount(2)
    await expect(playButtons.nth(0)).toBeEnabled()
    await expect(playButtons.nth(1)).toBeDisabled()

    await playButtons.nth(0).click()
    expect(played).toEqual(['bot-online'])
})

test('shows the empty state when no bot is registered', async ({ mount }) => {
    const component = await mount(
        <BotRosterScreen
            account={null}
            bots={[]}
            onPlay={() => { }}
        />
    )

    await expect(component.getByText('No bots are registered yet.')).toBeVisible()
})
