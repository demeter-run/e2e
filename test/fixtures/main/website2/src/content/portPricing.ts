import { links } from './links'

/**
 * Detailed pricing page data — from the redesign's DCLogic `ports` and
 * `plans` arrays. Rates and minimum fees are the published rate card;
 * throughput limits are transcribed from the redesign.
 */
export interface PlanColumn {
  tag: string
  name: string
  blurb: string
}

export interface PortMetric {
  label: string
  flex: string
  pro1: string
  pro2: string
}

export interface Port {
  name: string
  transport: string
  billing: string
  docs: string
  metrics: PortMetric[]
}

/** The page's heading block and meta description. */
export const pricingIntro = {
  eyebrow: 'DETAILED PRICING',
  heading: 'Every port, every plan,',
  headingMuted: 'side by side.',
  body: 'Usage is metered per port. Idle usage costs $0. The only fixed amount is the minimum fee on plans with reserved throughput. Switching plan or port never changes your endpoints.',
  description:
    'Every Demeter port and plan side by side. Usage is metered per port, idle usage costs $0, and switching plan or port never changes your endpoints.',
}

export const planColumns: PlanColumn[] = [
  { tag: 'PLAN 01', name: 'Flexible', blurb: 'Pay-as-you-go, no minimum' },
  { tag: 'PLAN 02', name: 'Pro I', blurb: 'Reserved throughput' },
  { tag: 'PLAN 03', name: 'Pro II', blurb: 'Highest reserved throughput' },
]

export const ports: Port[] = [
  {
    name: 'Ogmios',
    transport: 'WebSocket · JSON-RPC',
    billing:
      'Usage is measured per 100,000 messages; service is limited by concurrent open connections.',
    docs: 'https://ogmios.dev/api/',
    metrics: [
      { label: 'MINIMUM FEE', flex: '$0', pro1: '$50', pro2: '$150' },
      { label: 'PER 100K MESSAGES', flex: '$0.30', pro1: '$0.26', pro2: '$0.23' },
      { label: 'MAX CONCURRENT CONNECTIONS', flex: '5', pro1: '50', pro2: '150' },
    ],
  },
  {
    name: 'Kupo',
    transport: 'HTTP · REST',
    billing:
      'Usage is measured per 100,000 requests; service is limited by requests per second.',
    docs: 'https://docs.txpipe.io/dolos/apis/minikupo',
    metrics: [
      { label: 'MINIMUM FEE', flex: '$0', pro1: '$50', pro2: '$150' },
      { label: 'PER 100K REQUESTS', flex: '$0.30', pro1: '$0.26', pro2: '$0.23' },
      { label: 'MAX REQUESTS / SECOND', flex: '20', pro1: '100', pro2: '300' },
      {
        label: 'APPROX. DAILY REQUESTS',
        flex: '1,700,000',
        pro1: '8,600,000',
        pro2: '26,000,000',
      },
    ],
  },
  {
    name: 'Blockfrost',
    transport: 'HTTP · REST',
    billing:
      'Usage is measured per 100,000 requests; service is limited by requests per second.',
    docs: 'https://docs.txpipe.io/dolos/apis/minibf',
    metrics: [
      { label: 'MINIMUM FEE', flex: '$0', pro1: '$50', pro2: '$150' },
      { label: 'PER 100K REQUESTS', flex: '$0.30', pro1: '$0.26', pro2: '$0.23' },
      { label: 'MAX REQUESTS / SECOND', flex: '20', pro1: '100', pro2: '300' },
    ],
  },
  {
    name: 'UTxO RPC',
    transport: 'gRPC · protobuf',
    billing:
      'Usage is measured per 100,000 requests; service is limited by requests per second.',
    docs: 'https://utxorpc.org/introduction/',
    metrics: [
      { label: 'MINIMUM FEE', flex: '$0', pro1: '$50', pro2: '$150' },
      { label: 'PER 100K REQUESTS', flex: '$0.30', pro1: '$0.26', pro2: '$0.23' },
      { label: 'MAX REQUESTS / SECOND', flex: '20', pro1: '100', pro2: '300' },
    ],
  },
]

export const tableFootnotes = {
  left: 'RATES CONFIRMED IN THE CONSOLE BEFORE YOU ENABLE A PORT',
  right: 'ALL PORTS ON MAINNET · PREPROD · PREVIEW',
}

export const freeTierCard = {
  eyebrow: 'FREE TIER PROGRAM',
  heading: 'Start on the free tier',
  body: 'Every port has a free tier you can start on right away, on mainnet and testnets. No credit card. To keep it past 30 days, enroll your project in the free-tier program, or enroll before you start.',
  cta: { label: 'Start free', href: links.signUp },
  secondary: { label: 'Enroll', to: '/contact', search: { type: 'free-tier' } },
  about: { label: 'About the free tier', to: '/free-tier' },
} as const

export const customCard = {
  eyebrow: 'SCALE · CUSTOM PLAN',
  heading: "Past Pro II? Let's talk",
  body: 'Reserved throughput beyond the published tiers, dedicated instances per region, a custom SLA and support channel, with invoicing and volume pricing.',
  ctas: {
    contact: { label: 'Contact us', to: '/contact', search: { type: 'sales' } },
    support: { label: 'Talk to support', to: '/contact', search: { type: 'support' } },
  },
} as const
