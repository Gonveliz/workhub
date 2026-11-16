/**
 * What the person wants Workhub for, asked once and kept in the app options (`setupGoal`): talk
 * with an AI about their files, work on code (repositories, pull requests, tickets), or both.
 * It decides which setup rows are needed; until it is chosen Workhub behaves as `both`.
 */
export const SETUP_GOALS = ['files', 'code', 'both'] as const
export type SetupGoal = (typeof SETUP_GOALS)[number]
export const DEFAULT_SETUP_GOAL: SetupGoal = 'both'

/** Whether the goal includes working on code (repositories, pull requests, tickets). */
export const goalIncludesCode = (goal: SetupGoal): boolean => goal !== 'files'
