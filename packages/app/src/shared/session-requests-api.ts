// Requests agents make to other sessions through the control endpoint, waiting for the user:
// types of the preload bridge (window.hub.sessionRequests). Never offered to paired devices.

/** A session an agent proposed: it starts only when the user approves it. */
export interface SessionStartRequest {
  id: string
  kind: 'start'
  /** The session that proposed it. */
  fromSessionId: string
  fromName: string
  profileId: string | null
  agentKey: string
  agentName: string
  cwd: string
  /** The first prompt, sent once the new session is ready. */
  prompt: string
  name?: string
  createdAt: number
}

/** The first message from one session to another in this app run: approving it lets the rest of that pair through. */
export interface SessionMessageRequest {
  id: string
  kind: 'message'
  fromSessionId: string
  fromName: string
  toSessionId: string
  toName: string
  text: string
  createdAt: number
}

export type SessionRequest = SessionStartRequest | SessionMessageRequest

/**
 * The user's answer, carried out. Failures: `gone` (the request or a session it names is gone),
 * `agent` or `folder` (the profile no longer offers them), `unattended` (the agent has no mode that
 * asks for permissions), `failed` (the session did not start; `detail` says why).
 */
export type SessionRequestAnswer = { ok: true; sessionId?: string } | { ok: false; error: 'gone' | 'agent' | 'folder' | 'unattended' | 'failed'; detail?: string }

export interface SessionRequestsApi {
  /** The requests waiting for the user, oldest first. */
  list(): Promise<SessionRequest[]>
  /** Starts the proposed session, or lets the pair's messages through. */
  approve(id: string): Promise<SessionRequestAnswer>
  dismiss(id: string): Promise<void>
  onChanged(cb: (requests: SessionRequest[]) => void): () => void
}
