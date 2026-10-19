import { PricingTiers, PricingTiersPlans, Throughtputs } from '../enums';

export type TPricingResourceTierPlanThroughput = {
  id: Throughtputs;
  label: string;
  value: string;
  units: number;
};

export type TPricingResourceTierPlan = {
  id: PricingTiersPlans;
  name: string;
  description: string;
  cost: {
    fixed: number;
    fixedLabel?: string;
    usageBased: number;
    usageBasedLabel?: string;
  };
  throughputs: TPricingResourceTierPlanThroughput[];
};

export type TPricingResourceTier = {
  id: PricingTiers;
  plans: Partial<Record<PricingTiersPlans, TPricingResourceTierPlan>>;
};

export type TPricingResource = {
  tiers: Record<PricingTiers, TPricingResourceTier>;
};

export type TPricing = Record<string, TPricingResource>;

/**
 * Namespace with types and interfaces related to the Pricing UI.
 * */
export namespace NPricingUI {
  export interface IGridRowCell {
    id: string;
    className?: string;
    value: string;
  }

  export interface IGridRow {
    id: string;
    cells: IGridRowCell[];
  }

  export interface IGridRowReducerUtilitiesParams {
    plan: TPricingResourceTierPlan;
    tier: TPricingResourceTier;
  }
}
