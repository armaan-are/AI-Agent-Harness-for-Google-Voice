import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export const cn = (...values: ClassValue[]) => twMerge(clsx(values))
const buttonVariants = cva('button', {
  variants: { variant: { primary: 'button-primary', secondary: 'button-secondary', ghost: 'button-ghost', danger: 'button-danger' } },
  defaultVariants: { variant: 'secondary' },
})
export function Button({ className, variant, asChild, type = 'button', ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'button'
  return <Component className={cn(buttonVariants({ variant }), className)} {...(!asChild && { type })} {...props} />
}
export function Card({ title, icon, action, children, className }: {
  title?: string; icon?: ReactNode; action?: ReactNode; children: ReactNode; className?: string
}) {
  return <section className={cn('card', className)}>
    {title && <div className="card-header"><h2>{icon}{title}</h2>{action}</div>}
    {children}
  </section>
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>
}
export function Check({ value, onChange, children, disabled }: { value: boolean; onChange(value: boolean): void; children: ReactNode; disabled?: boolean }) {
  return <label className="check"><input type="checkbox" checked={value} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span>{children}</span></label>
}
export function Status({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'warn' | 'bad'; children: ReactNode }) {
  return <span className={cn('status', 'status-' + tone)}><span />{children}</span>
}
export function Notice({ danger = false, children }: { danger?: boolean; children: ReactNode }) {
  return <div role={danger ? 'alert' : 'status'} className={cn('notice', danger && 'notice-danger')}>{children}</div>
}
export function Wave({ data = [], height = 116 }: { data?: number[]; height?: number }) {
  const values = data.length ? data : Array.from({ length: 72 }, () => 0)
  return <div className="wave" style={{ height }} aria-hidden="true">
    <svg viewBox="0 0 720 110" preserveAspectRatio="none">
      <path className="wave-grid" d="M0 18H720 M0 36H720 M0 55H720 M0 74H720 M0 92H720 M80 0V110 M160 0V110 M240 0V110 M320 0V110 M400 0V110 M480 0V110 M560 0V110 M640 0V110" />
      {values.map((value, index) => {
        const amplitude = Math.max(1, Math.min(52, Math.abs(value) * 148))
        return <line className="wave-bar" key={index} x1={5 + index * 10} x2={5 + index * 10} y1={55 - amplitude} y2={55 + amplitude} />
      })}
    </svg>
  </div>
}
export function Level({ label, value }: { label: string; value: number }) {
  const width = Math.min(100, Math.max(0, (20 * Math.log10(Math.max(value, 0.0001)) + 60) * 100 / 60))
  return <div className="level"><span>{label}</span><div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(width)}><i style={{ width: width + '%' }} /></div><small>{value > 0.001 ? Math.round(20 * Math.log10(value)) + ' dBFS' : 'Silent'}</small></div>
}
