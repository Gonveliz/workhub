import type { Person } from '@workhub/core'
import { cn } from '../../lib/cn'

/** Toggle chips for the people an item involves. */
export function PeoplePicker({ people, value, onChange }: { people: Person[]; value: string[]; onChange: (ids: string[]) => void }) {
  if (people.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {people.map((p) => {
        const on = value.includes(p.id)
        return (
          <button key={p.id} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== p.id) : [...value, p.id])} className={cn('rounded-full border px-2 py-0.5 text-xs', on ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted hover:bg-surface-hover')}>
            {p.name}
          </button>
        )
      })}
    </div>
  )
}
