/** Hosted Studio plans. The plan cards and the comparison table both read from here. */

export interface Plan {
  name: string;
  price: string;
  unit?: string;
  per: string;
  stats: [string, string][];
  who: string;
  tag?: string;
}

export const plans: Plan[] = [
  {
    name: 'Free',
    price: '$0',
    per: 'forever',
    stats: [['Editors', '1'], ['Compute', '10 h'], ['Storage', '5 GB'], ['Largest cluster', 'S'], ['Iara', '50 messages']],
    who: 'Trying Studio and personal projects.',
  },
  {
    name: 'Pro',
    price: '$29',
    unit: '/month',
    per: '1 editor',
    stats: [['Editors', '1'], ['Compute', '50 h'], ['Storage', '100 GB'], ['Largest cluster', 'M'], ['Iara', '500 messages']],
    who: 'Analysts and consultants with scheduled jobs.',
  },
  {
    name: 'Team',
    price: '$69',
    unit: '/editor/month',
    per: 'minimum 3 editors',
    tag: 'Most popular',
    stats: [['Viewers', '25 included'], ['Compute', '60 h/editor'], ['Storage', '1 TB'], ['Largest cluster', 'L'], ['Iara', '2,000/editor']],
    who: 'Data teams sharing dashboards and permissions.',
  },
  {
    name: 'Business',
    price: '$129',
    unit: '/editor/month',
    per: 'minimum 5 editors',
    stats: [['Viewers', 'unlimited'], ['Compute', '150 h/editor'], ['Storage', '10 TB'], ['Largest cluster', 'XL'], ['Iara', '5,000/editor']],
    who: 'Companies that need SSO, audit logs and an SLA.',
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    per: 'annual contract',
    stats: [['Hosting', 'your cloud'], ['Compute', 'custom'], ['Storage', 'your bucket'], ['Cluster', 'custom'], ['Support', 'dedicated']],
    who: 'Compliance, DPA and network isolation.',
  },
];

/** Comparison table: a group title, or a row with one cell per plan (true/false render as a check or a dash). */
export type Row = string | [string, ...(string | boolean)[]];

export const comparison: Row[] = [
  'Usage',
  ['Editors', '1', '1', 'per seat, min. 3', 'per seat, min. 5', 'per seat'],
  ['Dashboard viewers', '3', '10', '25, then $5 each', 'unlimited', 'unlimited'],
  ['Compute hours per month', '10', '50', '60 per editor, pooled', '150 per editor, pooled', 'custom'],
  ['Largest cluster', 'S', 'M', 'L', 'XL', 'custom'],
  ['Storage', '5 GB', '100 GB', '1 TB, pooled', '10 TB or your bucket', 'your bucket or VPC'],
  ['Scheduled jobs', '2', '10', '100', 'unlimited', 'unlimited'],
  ['Dashboards', '3', '10', 'unlimited', 'unlimited', 'unlimited'],
  ['Iara messages per month', '50', '500', '2,000 per editor', '5,000 per editor', 'custom'],
  'Governance',
  ['Table-level grants', false, false, true, true, true],
  ['MCP tokens', false, false, true, true, true],
  ['SSO (SAML)', false, false, false, true, true],
  ['Audit log', false, false, false, true, true],
  'Retention and support',
  ['Table and run history', '7 days', '30 days', '90 days', '1 year', 'custom'],
  ['Support', 'community', 'email', 'email, 2 business days', 'priority, 99.9% SLA', 'dedicated, DPA'],
];

/** Usage beyond the plan, in US dollars, for Pro, Team and Business. */
export const addOns: [string, string, string, string][] = [
  ['Extra compute hour', '0.40', '0.35', '0.30'],
  ['Extra storage, per GB per month', '0.05', '0.04', '0.03'],
  ['1,000 extra Iara messages', '15', '12', '10'],
];
