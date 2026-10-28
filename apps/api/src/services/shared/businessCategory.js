// The business categories a tenant picks in the onboarding wizard. Used to
// (a) tailor which knowledge the wizard and Documents page ask for, and
// (b) give the bots a light, category-appropriate tone hint
// (domains/tenantProfile.js). Deliberately a small, closed set; anything else
// normalizes to 'other'. The values are stored on Tenant.businessCategory.

const BUSINESS_CATEGORIES = Object.freeze({
  ecommerce: {
    label: 'E-commerce / Retail',
    // What the wizard and Documents page nudge this tenant to add.
    asksFor: 'a product catalog or inventory sheet (CSV), plus returns and shipping policies',
    toneHint: 'This is a retail/e-commerce business: be concrete about products, prices, availability, shipping and returns.'
  },
  saas: {
    label: 'SaaS / Tech',
    asksFor: 'product and API documentation, feature guides, and pricing tiers',
    toneHint: 'This is a SaaS/technology business: be precise about features, plans, limits, integrations and setup steps.'
  },
  healthcare: {
    label: 'Healthcare',
    asksFor: 'services offered, patient FAQs, and policies (insurance, privacy, appointments)',
    toneHint: 'This is a healthcare business: be careful, clear and reassuring, and never give medical advice beyond the provided material.'
  },
  real_estate: {
    label: 'Real Estate',
    asksFor: 'listings, pricing, and process/policy documents',
    toneHint: 'This is a real-estate business: be concrete about properties, pricing, availability and the buying/renting process.'
  },
  education: {
    label: 'Education',
    asksFor: 'course outlines and catalogs, pricing, and enrolment FAQs/policies',
    toneHint: 'This is an education business: be clear about courses, curricula, schedules, pricing and enrolment.'
  },
  services: {
    label: 'Services',
    asksFor: 'service descriptions and terms, FAQs, and company policies',
    toneHint: 'This is a services business: be clear about what each service includes, how it works, and the terms.'
  },
  other: {
    label: 'Other',
    asksFor: 'an overview, FAQs, and your key policies',
    toneHint: ''
  }
});

const CATEGORY_KEYS = Object.freeze(Object.keys(BUSINESS_CATEGORIES));
const DEFAULT_BUSINESS_CATEGORY = 'other';

function isValidBusinessCategory(value) {
  return Object.prototype.hasOwnProperty.call(BUSINESS_CATEGORIES, String(value || '').trim().toLowerCase());
}

/**
 * Validates a client-supplied category. undefined/null/'' is allowed (returns
 * null — the tenant simply hasn't chosen one); any non-empty value must be a
 * known key.
 * @returns {{ ok: true, value: string|null } | { ok: false, error: string }}
 */
function parseBusinessCategory(value) {
  if (value === undefined || value === null || String(value).trim() === '') return { ok: true, value: null };
  const key = String(value).trim().toLowerCase();
  if (isValidBusinessCategory(key)) return { ok: true, value: key };
  return { ok: false, error: `businessCategory must be one of: ${CATEGORY_KEYS.join(', ')}` };
}

/** The one-line tone hint for a category, for the system prompt. '' when none/unknown. */
function toneHintFor(value) {
  const key = String(value || '').trim().toLowerCase();
  return BUSINESS_CATEGORIES[key]?.toneHint || '';
}

module.exports = {
  BUSINESS_CATEGORIES,
  CATEGORY_KEYS,
  DEFAULT_BUSINESS_CATEGORY,
  isValidBusinessCategory,
  parseBusinessCategory,
  toneHintFor
};
