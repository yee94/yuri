import { Icon } from '@/components/icon/Icon'

export function ContactCardModelLine({ value }: { value: string }) {
  return <p data-contact-card-model="" className="flex min-w-0 flex-1 items-center gap-1.5 text-[0.75em] leading-4 text-muted-foreground" title={value}>
    <Icon name="brain" weight="medium" className="size-3.5 shrink-0" />
    <span className="min-w-0 truncate">{value}</span>
  </p>
}
