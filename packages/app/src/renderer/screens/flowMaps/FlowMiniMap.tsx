import { edgeId, layoutFlowMap, routeFlowEdge, type FlowMap } from '@workhub/core'
import { cn } from '../../lib/cn'

/**
 * A small picture of a map for its card: the nodes where the diagram puts them and the hops between
 * them, without labels. A part over its limits (`over`, keyed `nodes:<id>` or `edges:<id>`) is red.
 */
export function FlowMiniMap({ map, over, className }: { map: FlowMap; over?: ReadonlySet<string>; className?: string }) {
  const layout = layoutFlowMap(map)
  const boxes = Object.values(layout.nodes)
  if (boxes.length === 0) return null
  // The picture is cropped to the nodes: lanes and phase headers would only add empty room at this size.
  const pad = 12
  const x0 = Math.min(...boxes.map((b) => b.x)) - pad
  const y0 = Math.min(...boxes.map((b) => b.y)) - pad
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)) + pad
  const y1 = Math.max(...boxes.map((b) => b.y + b.h)) + pad
  return (
    <svg viewBox={`${x0} ${y0} ${x1 - x0} ${y1 - y0}`} preserveAspectRatio="xMinYMid meet" className={cn('h-11 w-full', className)} aria-hidden data-testid="flow-mini-map">
      {map.edges.map((e, i) => {
        const a = layout.nodes[e.from]
        const b = layout.nodes[e.to]
        if (!a || !b) return null
        const hot = over?.has(`edges:${edgeId(map, i)}`)
        return <path key={i} d={routeFlowEdge(a, b, 0, e.entry)} fill="none" stroke="currentColor" strokeWidth={hot ? 7 : 5} strokeDasharray={e.kind === 'sync' ? undefined : '14 10'} className={hot ? 'text-danger' : 'text-subtle'} opacity={hot ? 1 : 0.7} />
      })}
      {map.nodes.map((n) => {
        const b = layout.nodes[n.id]
        if (!b) return null
        const hot = over?.has(`nodes:${n.id}`)
        return <rect key={n.id} x={b.x} y={b.y} width={b.w} height={b.h} rx={12} strokeWidth={hot ? 7 : 5} stroke="currentColor" className={hot ? 'fill-danger-soft text-danger' : 'fill-bg text-muted'} data-over={hot ? '' : undefined} />
      })}
    </svg>
  )
}
