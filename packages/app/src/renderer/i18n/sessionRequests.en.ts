/** English copy of what agents ask of other sessions (a new session, a first message), waiting for the user. */
export const sessionRequestsEn = {
  'sessionRequests.title': 'Requests from this session’s agent',
  'sessionRequests.start': 'The agent proposes a new {agent} session in {folder}.',
  'sessionRequests.startNamed': 'The agent proposes a new {agent} session, “{name}”, in {folder}.',
  'sessionRequests.startHint': 'Approve starts it with this first prompt, in a mode that asks before acting.',
  'sessionRequests.message': 'The agent wants to send a message to {to}.',
  'sessionRequests.messageHint': 'Allowing it also lets later messages from this session to {to} through until Workhub quits. They arrive marked as coming from this session.',
  'sessionRequests.prompt': 'First prompt',
  'sessionRequests.text': 'Message',
  'sessionRequests.approveStart': 'Start session',
  'sessionRequests.approveMessage': 'Allow and send',
  'sessionRequests.dismiss': 'Dismiss',
  'sessionRequests.badge.one': '{count} request waits for you',
  'sessionRequests.badge.other': '{count} requests wait for you',
  'sessionRequests.notify.start': '{name} proposes a new session',
  'sessionRequests.notify.message': '{name} wants to message {to}',
  'sessionRequests.error.gone': 'That request is no longer waiting, or the session it names is gone.',
  'sessionRequests.error.agent': 'This profile no longer offers that agent.',
  'sessionRequests.error.folder': 'That folder is no longer one of this profile’s folders.',
  'sessionRequests.error.unattended': 'That agent starts without permission prompts and has no mode that asks: start the session from New session.',
  'sessionRequests.error.failed': 'The session did not start: {detail}'
} as const
