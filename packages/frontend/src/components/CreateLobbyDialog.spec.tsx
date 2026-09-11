import type { AccountProfile, BotAccount, CreateSessionRequest } from '@ih3t/shared'
import { expect, test } from '@playwright/experimental-ct-react'
import CreateLobbyDialog from './CreateLobbyDialog'

test.use({
  viewport: {
    width: 1280,
    height: 960,
  },
})

const authenticatedAccount: AccountProfile = {
  id: 'account-1',
  username: 'Player One',
  email: 'player@example.com',
  image: null,
  role: 'user',
  kind: 'human',
  permissions: [],
  registeredAt: 1_700_000_000_000,
  lastActiveAt: 1_700_000_000_000,
}

test('submits casual match defaults for guests', async ({ mount }) => {
  let createRequest: CreateSessionRequest | null = null
  let closeCount = 0

  const component = await mount(
    <CreateLobbyDialog
      isOpen
      onClose={() => {
        closeCount += 1
      }}
      account={null}
      onCreateLobby={(request) => {
        createRequest = request
      }}
    />
  )

  await expect(component.getByRole('button', { name: /^Customize Match$/i })).toBeVisible()
  await expect(component.getByText('Rated lobbies are for authenticated players only.')).toHaveCount(0)

  await component.getByRole('button', { name: /^Create Lobby$/i }).click()

  await expect.poll(() => createRequest).toEqual({
    lobbyOptions: {
      visibility: 'public',
      timeControl: {
        mode: 'match',
        mainTimeMs: 5 * 60 * 1000,
        incrementMs: 5 * 1000,
      },
      rated: false,
      firstPlayer: 'random',
    },
  })

  await component.getByRole('button', { name: /^Cancel$/i }).click()
  await expect.poll(() => closeCount).toBe(1)
})

test('submits a rated private turn-based lobby for authenticated players', async ({ mount }) => {
  let createRequest: CreateSessionRequest | null = null

  const component = await mount(
    <CreateLobbyDialog
      isOpen
      onClose={() => { }}
      account={authenticatedAccount}
      onCreateLobby={(request) => {
        createRequest = request
      }}
    />
  )

  await expect(component.getByText('Rated lobbies are for authenticated players only.')).toHaveCount(0)
  await component.getByRole('button', { name: /^Customize Match$/i }).click()
  await expect(component.getByRole('button', { name: /with ELO/i })).toBeEnabled()

  await component.getByRole('button', { name: /Private Lobby/i }).click()
  await component.getByRole('button', { name: /Guest Starts/i }).click()
  await component.getByRole('button', { name: /Turn Based/i }).click()

  await expect(component.getByText('turn time')).toBeVisible()
  await component.locator('input[type="range"]').fill("2");

  await component.getByRole('button', { name: /^Create Lobby$/i }).click()

  expect(createRequest).toEqual({
    lobbyOptions: {
      visibility: 'private',
      timeControl: {
        mode: 'turn',
        turnTimeMs: 15 * 1000,
      },
      rated: true,
      firstPlayer: 'guest',
    },
  })
})

const ownBot: BotAccount = {
  id: 'bot-1',
  username: 'Strix',
  image: null,
  ownerProfileId: 'account-1',
  createdAt: 1_700_000_000_000,
  tokenRotatedAt: null,
}

test('submits an unrated lobby when the opponent is one of your bots', async ({ mount }) => {
  let createRequest: CreateSessionRequest | null = null
  let botProfileId: string | undefined

  const component = await mount(
    <CreateLobbyDialog
      isOpen
      onClose={() => { }}
      account={authenticatedAccount}
      ownBots={[ownBot]}
      onCreateLobby={(request, botId) => {
        createRequest = request
        botProfileId = botId
      }}
    />
  )

  /* The locale files do not load in the component-test harness on every machine,
   * so the selectors below work with the inline fallbacks too. */
  await component.getByRole('button', { name: /Customize Match|Advanced Settings/i }).click()
  await component.getByRole('button', { name: /Strix/i }).click()

  /* The mode picker is gone: a bot seat is never rated, so it is not offered. */
  await expect(component.getByText(/Rated game with ELO/i)).toHaveCount(0)
  await expect(component.getByText(/Casual unrated game/i)).toHaveCount(0)

  await component.getByRole('button', { name: /Create Lobby/i }).click()

  expect(createRequest).toEqual({
    lobbyOptions: {
      visibility: 'public',
      timeControl: {
        mode: 'match',
        mainTimeMs: 5 * 60 * 1000,
        incrementMs: 5 * 1000,
      },
      rated: false,
      firstPlayer: 'random',
    },
  })
  expect(botProfileId).toBe('bot-1')
})

test('matches the authenticated lobby dialog screenshot', async ({ mount }) => {
  const component = await mount(
    <CreateLobbyDialog
      isOpen
      onClose={() => { }}
      account={authenticatedAccount}
      onCreateLobby={() => { }}
    />
  )

  await expect(component).toHaveScreenshot('create-lobby-dialog-authenticated.png', {
    animations: 'disabled',
    scale: 'css',
  })
})
