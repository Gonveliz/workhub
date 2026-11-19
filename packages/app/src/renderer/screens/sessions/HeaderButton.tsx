import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '../../lib/cn'

const TONE = {
  neutral: 'border-border-strong text-text hover:bg-surface-hover',
  danger: 'border-danger text-danger hover:bg-danger-soft'
} as const

/** The session header's button: outlined, never filled (the header has no primary action). */
export const HeaderButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { icon?: ReactNode; tone?: keyof typeof TONE }>(function HeaderButton(
  { icon, tone = 'neutral', className, children, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn('inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md border bg-transparent px-2.5 text-sm font-medium whitespace-nowrap transition-colors duration-150 select-none disabled:pointer-events-none disabled:opacity-45', TONE[tone], className)}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
})
