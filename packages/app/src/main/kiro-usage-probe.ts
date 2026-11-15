/**
 * Whether the Kiro plan usage reader may run. Reading it starts `kiro-cli acp` (about every 20 minutes: the usage
 * service polls every 5 and the reader spaces its reads 15 minutes apart),
 * and each start refreshes the Kiro sign-in token, so development and test runs leave it off
 * unless `WORKHUB_KIRO_USAGE=1` asks for it. A packaged app always reads it.
 */
export function kiroUsageProbeEnabled(isPackaged: boolean, env: Record<string, string | undefined>): boolean {
  return isPackaged || env['WORKHUB_KIRO_USAGE'] === '1'
}
