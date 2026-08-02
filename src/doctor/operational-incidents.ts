import { readIncidentLedger } from '@/operations'

import type { DoctorCheck } from './types'

export function buildOperationalIncidentChecks(): DoctorCheck[] {
  return [
    {
      name: 'operations.incidents',
      category: 'operations',
      description: 'deterministic operational incidents are resolved',
      applies: (ctx) => ctx.hasAgentFolder,
      async run(ctx) {
        const ledger = await readIncidentLedger(ctx.cwd)
        const unresolved = ledger.incidents.filter((incident) => incident.status === 'unresolved')
        if (unresolved.length === 0) return { status: 'ok', message: 'no unresolved operational incidents' }
        const recurrent = unresolved.filter((incident) => incident.recurrent)
        return {
          status: recurrent.length > 0 ? 'error' : 'warning',
          message:
            recurrent.length > 0
              ? `${recurrent.length} recurrent TypeClaw environment issue(s) require operator repair`
              : `${unresolved.length} unresolved operational incident(s)`,
          details: unresolved.map(
            (incident) =>
              `${incident.fingerprint} count=${incident.count} first=${incident.firstSeenAt} last=${incident.lastSeenAt}`,
          ),
          fix: { description: 'Repair the TypeClaw environment defect, then retry the failed operation.' },
        }
      },
    },
  ]
}
