import type { ContactTypeSlug } from './contact'
import { links } from './links'

/** Landing pricing tier cards — copy transcribed verbatim from the redesign. */
export interface PlanTier {
  id: string
  tag: string
  tone: 'light' | 'popular' | 'dark'
  price: string
  priceUnit: string
  note: string
  blurb: string
  features: string[]
  cta: {
    label: string
    variant: 'card-outline' | 'primary' | 'bright'
    /** External or placeholder target. */
    href?: string
    external?: boolean
    /** Internal router target. */
    to?: '/contact'
    search?: { type: ContactTypeSlug }
  }
}

export const planTiers: PlanTier[] = [
  {
    id: 'flexible',
    tag: 'FLEXIBLE',
    tone: 'light',
    price: '$0.30',
    priceUnit: 'per 100k requests',
    note: 'No minimum fee. Idle costs $0',
    blurb: 'Pure pay-as-you-go. Metered usage, nothing to pay when traffic stops.',
    features: [
      'All APIs, one rate',
      '20 req/s · ~1.7M/day',
      '5 concurrent connections',
      'Multi-region, 99.9% SLA',
      'Email support',
    ],
    cta: { label: 'Sign up', href: links.signUp, variant: 'card-outline' },
  },
  {
    id: 'pro-1',
    tag: 'PRO I',
    tone: 'popular',
    price: '$0.26',
    priceUnit: 'per 100k requests',
    note: 'Minimum fee $50 once you reserve throughput',
    blurb: 'Reserved throughput for apps carrying real production traffic.',
    features: [
      'All APIs, one rate',
      '100 req/s · ~8.6M/day',
      '50 concurrent connections',
      'Multi-region, 99.9% SLA',
      'Email support',
    ],
    cta: { label: 'Sign up', href: links.signUp, variant: 'primary' },
  },
  {
    id: 'pro-2',
    tag: 'PRO II',
    tone: 'light',
    price: '$0.23',
    priceUnit: 'per 100k requests',
    note: 'Minimum fee $150 once you reserve throughput',
    blurb: "Highest reserved throughput, for workloads that can't queue.",
    features: [
      'All APIs, one rate',
      '300 req/s · ~26M/day',
      '150 concurrent connections',
      'Multi-region, 99.9% SLA',
      'Priority support channel',
    ],
    cta: { label: 'Sign up', href: links.signUp, variant: 'card-outline' },
  },
  {
    id: 'custom',
    tag: 'CUSTOM',
    tone: 'dark',
    price: 'Talk',
    priceUnit: 'volume pricing',
    note: 'Committed usage, invoiced monthly',
    blurb: 'For workloads past Pro II, or teams that need contractual guarantees.',
    features: [
      'All APIs, negotiated rate',
      'Reserved throughput',
      'Dedicated instances per region',
      'Custom SLA · contractual',
      'Shared channel with on-call',
    ],
    cta: { label: 'Contact us', to: '/contact', search: { type: 'sales' }, variant: 'bright' },
  },
]

export const pricingFootnote =
  'Indicative rate per 100k requests · minimum fees apply only with reserved throughput'
