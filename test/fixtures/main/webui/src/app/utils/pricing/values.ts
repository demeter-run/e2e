import {
  PricingTiers,
  PricingTiersPlans,
  Throughtputs,
} from '../enums';

import {
  TPricing,
} from './types';

export const pricingTierPlansAssociation = {
  FREE: PricingTiers.FREE,
  FLEXIBLE: PricingTiers.FLEXIBLE,
  PRO_1: PricingTiers.PRO,
  PRO_2: PricingTiers.PRO,
};

export const pricingTierPlansNames = {
  FREE: 'Free',
  FLEXIBLE: 'Flexible',
  PRO_1: 'Pro I',
  PRO_2: 'Pro II',
};

export const PRICING: TPricing = {
  'cardano-node-port': {
    tiers: {
      [PricingTiers.FREE]: {
        id: PricingTiers.FREE,
        plans: {
          [PricingTiersPlans.FREE]: {
            id: PricingTiersPlans.FREE,
            name: pricingTierPlansNames.FREE,
            description: 'Start for free and explore the basics.',
            cost: {
              fixed: 0,
              usageBased: 0,
            },
            throughputs: [
              {
                id: Throughtputs.MAX_CONCURRENT_OPEN_CONNECTIONS,
                label: 'Max concurrent open connections',
                value: '1',
                units: 1,
              },
              {
                id: Throughtputs.MAX_MB_THROUGHPUT_PER_OPEN_CONNECTION,
                label: 'Max throughput per open connection (MB)',
                value: '2',
                units: 2,
              },
            ],
          },
        },
      },
      [PricingTiers.FLEXIBLE]: {
        id: PricingTiers.FLEXIBLE,
        plans: {
          [PricingTiersPlans.FLEXIBLE]: {
            id: PricingTiersPlans.FLEXIBLE,
            name: pricingTierPlansNames.FLEXIBLE,
            description: 'Pay as you go for moderate usage.',
            cost: {
              fixed: 0,
              usageBased: 1.2,
              usageBasedLabel: '24hs of open connection',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_CONCURRENT_OPEN_CONNECTIONS,
                label: 'Max concurrent open connections',
                value: '5',
                units: 5,
              },
              {
                id: Throughtputs.MAX_MB_THROUGHPUT_PER_OPEN_CONNECTION,
                label: 'Max throughput per open connection (MB)',
                value: '2',
                units: 2,
              },
            ],
          },
        },
      },
      [PricingTiers.PRO]: {
        id: PricingTiers.PRO,
        plans: {
          [PricingTiersPlans.PRO_1]: {
            id: PricingTiersPlans.PRO_1,
            name: pricingTierPlansNames.PRO_1,
            description: 'Reserve throughput for growing projects.',
            cost: {
              fixed: 100,
              fixedLabel: 'Minimum ticket',
              usageBased: 0.4,
              usageBasedLabel: '24hs of open connection',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_CONCURRENT_OPEN_CONNECTIONS,
                label: 'Max concurrent open connections',
                value: '25',
                units: 25,
              },
              {
                id: Throughtputs.MAX_MB_THROUGHPUT_PER_OPEN_CONNECTION,
                label: 'Max throughput per open connection (MB)',
                value: '2',
                units: 2,
              },
            ],
          },
          [PricingTiersPlans.PRO_2]: {
            id: PricingTiersPlans.PRO_2,
            name: pricingTierPlansNames.PRO_2,
            description: 'Hassle-free capacity for scaled projects.',
            cost: {
              fixed: 200,
              fixedLabel: 'Minimum ticket',
              usageBased: 0.3,
              usageBasedLabel: '24hs of open connection',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_CONCURRENT_OPEN_CONNECTIONS,
                label: 'Max concurrent open connections',
                value: '75',
                units: 75,
              },
              {
                id: Throughtputs.MAX_MB_THROUGHPUT_PER_OPEN_CONNECTION,
                label: 'Max throughput per open connection (MB)',
                value: '2',
                units: 2,
              },
            ],
          },
        },
      },
    },
  },
  'cardano-dbsync-port': {
    tiers: {
      [PricingTiers.FREE]: {
        id: PricingTiers.FREE,
        plans: {
          [PricingTiersPlans.FREE]: {
            id: PricingTiersPlans.FREE,
            name: pricingTierPlansNames.FREE,
            description: 'Start for free and explore the basics.',
            cost: {
              fixed: 0,
              usageBased: 0,
            },
            throughputs: [
              {
                id: Throughtputs.MAX_CONCURRENT_OPEN_CONNECTIONS,
                label: 'Max concurrent open connections',
                value: '1',
                units: 1,
              },
            ],
          },
        },
      },
      [PricingTiers.FLEXIBLE]: {
        id: PricingTiers.FLEXIBLE,
        plans: {
          [PricingTiersPlans.FLEXIBLE]: {
            id: PricingTiersPlans.FLEXIBLE,
            name: pricingTierPlansNames.FLEXIBLE,
            description: 'Pay as you go for moderate usage.',
            cost: {
              fixed: 0,
              usageBased: 0.64,
              usageBasedLabel: '24hs of open connection',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_CONCURRENT_OPEN_CONNECTIONS,
                label: 'Max concurrent open connections',
                value: '5',
                units: 5,
              },
            ],
          },
        },
      },
      [PricingTiers.PRO]: {
        id: PricingTiers.PRO,
        plans: {
          [PricingTiersPlans.PRO_1]: {
            id: PricingTiersPlans.PRO_1,
            name: pricingTierPlansNames.PRO_1,
            description: 'Reserve throughput for growing projects.',
            cost: {
              fixed: 100,
              fixedLabel: 'Minimum ticket',
              usageBased: 0.58,
              usageBasedLabel: '24hs of open connection',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_CONCURRENT_OPEN_CONNECTIONS,
                label: 'Max concurrent open connections',
                value: '25',
                units: 25,
              },
            ],
          },
          [PricingTiersPlans.PRO_2]: {
            id: PricingTiersPlans.PRO_2,
            name: pricingTierPlansNames.PRO_2,
            description: 'Hassle-free capacity for scaled projects.',
            cost: {
              fixed: 300,
              fixedLabel: 'Minimum ticket',
              usageBased: 0.48,
              usageBasedLabel: '24hs of open connection',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_CONCURRENT_OPEN_CONNECTIONS,
                label: 'Max concurrent open connections',
                value: '75',
                units: 75,
              },
            ],
          },
        },
      },
    },
  },
  'cardano-ogmios-port': {
    tiers: {
      [PricingTiers.FREE]: {
        id: PricingTiers.FREE,
        plans: {
          [PricingTiersPlans.FREE]: {
            id: PricingTiersPlans.FREE,
            name: pricingTierPlansNames.FREE,
            description: 'Start for free and explore the basics.',
            cost: {
              fixed: 0,
              usageBased: 0,
              usageBasedLabel: '100k messages',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_CONCURRENT_OPEN_CONNECTIONS,
                label: 'Max concurrent open connections',
                value: '1',
                units: 1,
              },
            ],
          },
        },
      },
      [PricingTiers.FLEXIBLE]: {
        id: PricingTiers.FLEXIBLE,
        plans: {
          [PricingTiersPlans.FLEXIBLE]: {
            id: PricingTiersPlans.FLEXIBLE,
            name: pricingTierPlansNames.FLEXIBLE,
            description: 'Pay as you go for moderate usage.',
            cost: {
              fixed: 0,
              usageBased: 0.30,
              usageBasedLabel: '100k messages',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_CONCURRENT_OPEN_CONNECTIONS,
                label: 'Max concurrent open connections',
                value: '5',
                units: 5,
              },
            ],
          },
        },
      },
      [PricingTiers.PRO]: {
        id: PricingTiers.PRO,
        plans: {
          [PricingTiersPlans.PRO_1]: {
            id: PricingTiersPlans.PRO_1,
            name: pricingTierPlansNames.PRO_1,
            description: 'Reserve throughput for growing projects.',
            cost: {
              fixed: 50,
              fixedLabel: 'Minimum ticket',
              usageBased: 0.26,
              usageBasedLabel: '100k messages',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_CONCURRENT_OPEN_CONNECTIONS,
                label: 'Max concurrent open connections',
                value: '50',
                units: 50,
              },
            ],
          },
          [PricingTiersPlans.PRO_2]: {
            id: PricingTiersPlans.PRO_2,
            name: pricingTierPlansNames.PRO_2,
            description: 'Hassle-free capacity for scaled projects.',
            cost: {
              fixed: 150,
              fixedLabel: 'Minimum ticket',
              usageBased: 0.23,
              usageBasedLabel: '100k messages',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_CONCURRENT_OPEN_CONNECTIONS,
                label: 'Max concurrent open connections',
                value: '150',
                units: 150,
              },
            ],
          },
        },
      },
    },
  },
  'cardano-submitapi-port': {
    tiers: {
      [PricingTiers.FREE]: {
        id: PricingTiers.FREE,
        plans: {
          [PricingTiersPlans.FREE]: {
            id: PricingTiersPlans.FREE,
            name: pricingTierPlansNames.FREE,
            description: 'Start for free and explore the basics.',
            cost: {
              fixed: 0,
              usageBased: 0,
            },
            throughputs: [
              {
                id: Throughtputs.MAX_SUBMITS_PER_MINUTE,
                label: 'Max submits per minute',
                value: '1',
                units: 1,
              },
              {
                id: Throughtputs.MAX_SUBMITS_PER_DAY,
                label: 'Daily submits limit',
                value: '~80,000',
                units: 80_000,
              },
            ],
          },
        },
      },
      [PricingTiers.FLEXIBLE]: {
        id: PricingTiers.FLEXIBLE,
        plans: {
          [PricingTiersPlans.FLEXIBLE]: {
            id: PricingTiersPlans.FLEXIBLE,
            name: pricingTierPlansNames.FLEXIBLE,
            description: 'Pay as you go for moderate usage.',
            cost: {
              fixed: 0,
              usageBased: 0.09,
              usageBasedLabel: '1000 submits',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_SUBMITS_PER_MINUTE,
                label: 'Max submits per minute',
                value: '5',
                units: 5,
              },
              {
                id: Throughtputs.MAX_SUBMITS_PER_DAY,
                label: 'Daily submits limit',
                value: '~400,000',
                units: 400_000,
              },
            ],
          },
        },
      },
      [PricingTiers.PRO]: {
        id: PricingTiers.PRO,
        plans: {
          [PricingTiersPlans.PRO_1]: {
            id: PricingTiersPlans.PRO_1,
            name: pricingTierPlansNames.PRO_1,
            description: 'Reserve throughput for growing projects.',
            cost: {
              fixed: 25,
              fixedLabel: 'Minimum ticket',
              usageBased: 0.08,
              usageBasedLabel: '1000 submits',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_SUBMITS_PER_MINUTE,
                label: 'Max submits per minute',
                value: '40',
                units: 40,
              },
              {
                id: Throughtputs.MAX_SUBMITS_PER_DAY,
                label: 'Daily submits limit',
                value: '~2,000,000',
                units: 2_000_000,
              },
            ],
          },
          [PricingTiersPlans.PRO_2]: {
            id: PricingTiersPlans.PRO_2,
            name: pricingTierPlansNames.PRO_2,
            description: 'Hassle-free capacity for scaled projects.',
            cost: {
              fixed: 50,
              fixedLabel: 'Minimum ticket',
              usageBased: 0.07,
              usageBasedLabel: '1000 submits',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_SUBMITS_PER_MINUTE,
                label: 'Max submits per minute',
                value: '80',
                units: 80,
              },
              {
                id: Throughtputs.MAX_SUBMITS_PER_DAY,
                label: 'Daily submits limit',
                value: '~4,000,000',
                units: 4_000_000,
              },
            ],
          },
        },
      },
    },
  },
  'cardano-blockfrost-port': {
    tiers: {
      [PricingTiers.FREE]: {
        id: PricingTiers.FREE,
        plans: {
          [PricingTiersPlans.FREE]: {
            id: PricingTiersPlans.FREE,
            name: pricingTierPlansNames.FREE,
            description: 'Start for free and explore the basics.',
            cost: {
              fixed: 0,
              usageBased: 0,
            },
            throughputs: [
              {
                id: Throughtputs.MAX_REQUESTS_PER_SECOND,
                label: 'Max requests per second',
                value: '5',
                units: 5,
              },
              {
                id: Throughtputs.MAX_REQUESTS_PER_DAY,
                label: 'Daily requests limit',
                value: '~430,000',
                units: 430_000,
              },
            ],
          },
        },
      },
      [PricingTiers.FLEXIBLE]: {
        id: PricingTiers.FLEXIBLE,
        plans: {
          [PricingTiersPlans.FLEXIBLE]: {
            id: PricingTiersPlans.FLEXIBLE,
            name: pricingTierPlansNames.FLEXIBLE,
            description: 'Pay as you go for moderate usage.',
            cost: {
              fixed: 0,
              usageBased: 0.30,
              usageBasedLabel: '100k requests',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_REQUESTS_PER_SECOND,
                label: 'Max requests per second',
                value: '20',
                units: 20,
              },
              {
                id: Throughtputs.MAX_REQUESTS_PER_DAY,
                label: 'Daily requests limit',
                value: '~1,700,000',
                units: 1_700_000,
              },
            ],
          },
        },
      },
      [PricingTiers.PRO]: {
        id: PricingTiers.PRO,
        plans: {
          [PricingTiersPlans.PRO_1]: {
            id: PricingTiersPlans.PRO_1,
            name: pricingTierPlansNames.PRO_1,
            description: 'Reserve throughput for growing projects.',
            cost: {
              fixed: 50,
              fixedLabel: 'Minimum ticket',
              usageBased: 0.26,
              usageBasedLabel: '100k requests',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_REQUESTS_PER_SECOND,
                label: 'Max requests per second',
                value: '100',
                units: 100,
              },
              {
                id: Throughtputs.MAX_REQUESTS_PER_DAY,
                label: 'Daily requests limit',
                value: '~8,600,000',
                units: 8_600_000,
              },
            ],
          },
          [PricingTiersPlans.PRO_2]: {
            id: PricingTiersPlans.PRO_2,
            name: pricingTierPlansNames.PRO_2,
            description: 'Hassle-free capacity for scaled projects.',
            cost: {
              fixed: 150,
              fixedLabel: 'Minimum ticket',
              usageBased: 0.23,
              usageBasedLabel: '100k requests',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_REQUESTS_PER_SECOND,
                label: 'Max requests per second',
                value: '300',
                units: 300,
              },
              {
                id: Throughtputs.MAX_REQUESTS_PER_DAY,
                label: 'Daily requests limit',
                value: '~26,000,000',
                units: 26_000_000,
              },
            ],
          },
        },
      },
    },
  },
  'cardano-utxorpc': {
    tiers: {
      [PricingTiers.FREE]: {
        id: PricingTiers.FREE,
        plans: {
          [PricingTiersPlans.FREE]: {
            id: PricingTiersPlans.FREE,
            name: pricingTierPlansNames.FREE,
            description: 'Start for free and explore the basics.',
            cost: {
              fixed: 0,
              usageBased: 0,
            },
            throughputs: [
              {
                id: Throughtputs.MAX_REQUESTS_PER_SECOND,
                label: 'Max requests per second',
                value: '5',
                units: 5,
              },
              {
                id: Throughtputs.MAX_REQUESTS_PER_DAY,
                label: 'Daily requests limit',
                value: '~430,000',
                units: 430_000,
              },
            ],
          },
        },
      },
      [PricingTiers.FLEXIBLE]: {
        id: PricingTiers.FLEXIBLE,
        plans: {
          [PricingTiersPlans.FLEXIBLE]: {
            id: PricingTiersPlans.FLEXIBLE,
            name: pricingTierPlansNames.FLEXIBLE,
            description: 'Pay as you go for moderate usage.',
            cost: {
              fixed: 0,
              usageBased: 0.30,
              usageBasedLabel: '100k requests',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_REQUESTS_PER_SECOND,
                label: 'Max requests per second',
                value: '20',
                units: 20,
              },
              {
                id: Throughtputs.MAX_REQUESTS_PER_DAY,
                label: 'Daily requests limit',
                value: '~1,700,000',
                units: 1_700_000,
              },
            ],
          },
        },
      },
      [PricingTiers.PRO]: {
        id: PricingTiers.PRO,
        plans: {
          [PricingTiersPlans.PRO_1]: {
            id: PricingTiersPlans.PRO_1,
            name: pricingTierPlansNames.PRO_1,
            description: 'Reserve throughput for growing projects.',
            cost: {
              fixed: 50,
              fixedLabel: 'Minimum ticket',
              usageBased: 0.26,
              usageBasedLabel: '100k requests',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_REQUESTS_PER_SECOND,
                label: 'Max requests per second',
                value: '100',
                units: 100,
              },
              {
                id: Throughtputs.MAX_REQUESTS_PER_DAY,
                label: 'Daily requests limit',
                value: '~8,600,000',
                units: 8_600_000,
              },
            ],
          },
          [PricingTiersPlans.PRO_2]: {
            id: PricingTiersPlans.PRO_2,
            name: pricingTierPlansNames.PRO_2,
            description: 'Hassle-free capacity for scaled projects.',
            cost: {
              fixed: 150,
              fixedLabel: 'Minimum ticket',
              usageBased: 0.23,
              usageBasedLabel: '100k requests',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_REQUESTS_PER_SECOND,
                label: 'Max requests per second',
                value: '300',
                units: 300,
              },
              {
                id: Throughtputs.MAX_REQUESTS_PER_DAY,
                label: 'Daily requests limit',
                value: '~26,000,000',
                units: 26_000_000,
              },
            ],
          },
        },
      },
    },
  },
  'cardano-marlowe-port': {
    tiers: {
      [PricingTiers.FREE]: {
        id: PricingTiers.FREE,
        plans: {
          [PricingTiersPlans.FREE]: {
            id: PricingTiersPlans.FREE,
            name: pricingTierPlansNames.FREE,
            description: 'Start for free and explore the basics.',
            cost: {
              fixed: 0,
              usageBased: 0,
            },
            throughputs: [
              {
                id: Throughtputs.MAX_REQUESTS_PER_SECOND,
                label: 'Max requests per second',
                value: '5',
                units: 5,
              },
              {
                id: Throughtputs.MAX_REQUESTS_PER_DAY,
                label: 'Daily requests limit',
                value: '~430,000',
                units: 430_000,
              },
            ],
          },
        },
      },
      [PricingTiers.FLEXIBLE]: {
        id: PricingTiers.FLEXIBLE,
        plans: {
          [PricingTiersPlans.FLEXIBLE]: {
            id: PricingTiersPlans.FLEXIBLE,
            name: pricingTierPlansNames.FLEXIBLE,
            description: 'Pay as you go for moderate usage.',
            cost: {
              fixed: 0,
              usageBased: 0.40,
              usageBasedLabel: '100k requests',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_REQUESTS_PER_SECOND,
                label: 'Max requests per second',
                value: '20',
                units: 20,
              },
              {
                id: Throughtputs.MAX_REQUESTS_PER_DAY,
                label: 'Daily requests limit',
                value: '~1,700,000',
                units: 1_700_000,
              },
            ],
          },
        },
      },
      [PricingTiers.PRO]: {
        id: PricingTiers.PRO,
        plans: {
          [PricingTiersPlans.PRO_1]: {
            id: PricingTiersPlans.PRO_1,
            name: pricingTierPlansNames.PRO_1,
            description: 'Reserve throughput for growing projects.',
            cost: {
              fixed: 200,
              fixedLabel: 'Minimum ticket',
              usageBased: 0.36,
              usageBasedLabel: '100k requests',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_REQUESTS_PER_SECOND,
                label: 'Max requests per second',
                value: '100',
                units: 100,
              },
              {
                id: Throughtputs.MAX_REQUESTS_PER_DAY,
                label: 'Daily requests limit',
                value: '~8,600,000',
                units: 8_600_000,
              },
            ],
          },
          [PricingTiersPlans.PRO_2]: {
            id: PricingTiersPlans.PRO_2,
            name: pricingTierPlansNames.PRO_2,
            description: 'Hassle-free capacity for scaled projects.',
            cost: {
              fixed: 400,
              fixedLabel: 'Minimum ticket',
              usageBased: 0.30,
              usageBasedLabel: '100k requests',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_REQUESTS_PER_SECOND,
                label: 'Max requests per second',
                value: '300',
                units: 300,
              },
              {
                id: Throughtputs.MAX_REQUESTS_PER_DAY,
                label: 'Daily requests limit',
                value: '~26,000,000',
                units: 26_000_000,
              },
            ],
          },
        },
      },
    },
  },
  'cardano-kupo-port': {
    tiers: {
      [PricingTiers.FREE]: {
        id: PricingTiers.FREE,
        plans: {
          [PricingTiersPlans.FREE]: {
            id: PricingTiersPlans.FREE,
            name: pricingTierPlansNames.FREE,
            description: 'Start for free and explore the basics.',
            cost: {
              fixed: 0,
              usageBased: 0,
            },
            throughputs: [
              {
                id: Throughtputs.MAX_REQUESTS_PER_SECOND,
                label: 'Max requests per second',
                value: '5',
                units: 5,
              },
              {
                id: Throughtputs.MAX_REQUESTS_PER_DAY,
                label: 'Daily requests limit',
                value: '~430,000',
                units: 430_000,
              },
            ],
          },
        },
      },
      [PricingTiers.FLEXIBLE]: {
        id: PricingTiers.FLEXIBLE,
        plans: {
          [PricingTiersPlans.FLEXIBLE]: {
            id: PricingTiersPlans.FLEXIBLE,
            name: pricingTierPlansNames.FLEXIBLE,
            description: 'Pay as you go for moderate usage.',
            cost: {
              fixed: 0,
              usageBased: 0.30,
              usageBasedLabel: '100k requests',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_REQUESTS_PER_SECOND,
                label: 'Max requests per second',
                value: '20',
                units: 20,
              },
              {
                id: Throughtputs.MAX_REQUESTS_PER_DAY,
                label: 'Daily requests limit',
                value: '~1,700,000',
                units: 1_700_000,
              },
            ],
          },
        },
      },
      [PricingTiers.PRO]: {
        id: PricingTiers.PRO,
        plans: {
          [PricingTiersPlans.PRO_1]: {
            id: PricingTiersPlans.PRO_1,
            name: pricingTierPlansNames.PRO_1,
            description: 'Reserve throughput for growing projects.',
            cost: {
              fixed: 50,
              fixedLabel: 'Minimum ticket',
              usageBased: 0.26,
              usageBasedLabel: '100k requests',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_REQUESTS_PER_SECOND,
                label: 'Max requests per second',
                value: '100',
                units: 100,
              },
              {
                id: Throughtputs.MAX_REQUESTS_PER_DAY,
                label: 'Daily requests limit',
                value: '~8,600,000',
                units: 8_600_000,
              },
            ],
          },
          [PricingTiersPlans.PRO_2]: {
            id: PricingTiersPlans.PRO_2,
            name: pricingTierPlansNames.PRO_2,
            description: 'Hassle-free capacity for scaled projects.',
            cost: {
              fixed: 150,
              fixedLabel: 'Minimum ticket',
              usageBased: 0.23,
              usageBasedLabel: '100k requests',
            },
            throughputs: [
              {
                id: Throughtputs.MAX_REQUESTS_PER_SECOND,
                label: 'Max requests per second',
                value: '300',
                units: 300,
              },
              {
                id: Throughtputs.MAX_REQUESTS_PER_DAY,
                label: 'Daily requests limit',
                value: '~26,000,000',
                units: 26_000_000,
              },
            ],
          },
        },
      },
    },
  },
};

export const ENTERPRISE_PRICING_DESCRIPTIONS = {
  description: 'For projects with advanced needs.',
  detailsList: [
    'Dedicated support',
    'Custom configurations',
    'Private instances',
    'Advanced security options',
  ],
};
