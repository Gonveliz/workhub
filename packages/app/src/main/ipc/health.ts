import type { FlowTraceSort, HealthDetailRequest } from '@workhub/core'
import type { HealthService } from '../health-service'
import type { IpcRegistrar } from '../ipc-guard'

/** Health, its flow maps and traces, and connection tests (`health:*`). */
export function registerHealthIpc(ipc: IpcRegistrar, health: HealthService): void {
  ipc.handle('health:get', (_e, profileId: string | null, force?: boolean) => health.get(profileId, force === true))
  ipc.handle('health:details', (_e, profileId: string | null, environmentId: string, request: HealthDetailRequest, force?: boolean) => health.details(profileId, environmentId, request, force === true))
  ipc.handle('health:flowMaps', (_e, profileId: string | null) => health.flowMaps(profileId))
  ipc.handle('health:flowMapStates', (_e, profileId: string | null, environmentId: unknown) => (typeof environmentId === 'string' ? health.flowMapStates(profileId, environmentId) : {}))
  ipc.handle('health:flowMap', (_e, profileId: string | null, environmentId: string, mapId: string, hours: number, force?: boolean, storedOnly?: boolean) => health.flowMap(profileId, environmentId, mapId, hours, force === true, storedOnly === true))
  ipc.handle('health:flowTraces', (_e, profileId: string | null, environmentId: string, mapId: string, hours: number, sort: FlowTraceSort) => health.flowTraces(profileId, environmentId, mapId, hours, sort))
  ipc.handle('health:flowTrace', (_e, profileId: string | null, environmentId: string, mapId: string, traceId: string) => health.flowTrace(profileId, environmentId, mapId, traceId))
  ipc.handle('health:flowTraceLogs', (_e, profileId: string | null, environmentId: string, mapId: string, traceId: string) => health.flowTraceLogs(profileId, environmentId, mapId, traceId))
  ipc.handle('health:test', (_e, connection, secret, indexToProbe?: string) => health.test(connection, secret, indexToProbe))
}
