// Auto-triage for newly imported users.
//
// Every imported user gets a training category from the configurable
// profile -> category map (Settings -> Onboarding Triage Rules). Users whose
// profile maps to "full_onboarding" (administrator-type profiles) also get a
// follow-up deadline so the training team can track a 60-day check-in.

const CATEGORY = {
  FULL_ONBOARDING: 'full_onboarding', // administrator-type profile: full onboarding + follow-up timer
  STANDARD:        'standard',        // regular user: standard welcome, no timer
  NEEDS_REVIEW:    'needs_review',    // profile not in the map: a human decides
};

const DEFAULT_FOLLOW_UP_DAYS = 60;

function followUpDays() {
  const n = parseInt(process.env.FOLLOW_UP_DEADLINE_DAYS, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FOLLOW_UP_DAYS;
}

// Profiles that are not in the map but clearly administrative still get full onboarding.
function looksAdministrative(profileName) {
  return /\badmin(istrator)?\b/i.test(String(profileName || ''));
}

// 'YYYY-MM-DD HH:MM:SS' + N days -> same format (UTC).
function addDays(sqliteDateTime, days) {
  const s = String(sqliteDateTime).trim();
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z');
  const d = new Date(iso);
  if (isNaN(d)) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Decide the training category and follow-up deadline for one imported user.
 * @param {object} args
 * @param {string|null} args.profileName      user profile name from the CSV
 * @param {string|null} args.dateEntered      SQLite datetime the user was added
 * @param {(name: string) => string|undefined} args.lookupCategory  reads profile_training_map
 * @param {number} [args.days]                follow-up window, defaults to FOLLOW_UP_DEADLINE_DAYS
 */
function triageNewUser({ profileName, dateEntered, lookupCategory, days = followUpDays() }) {
  let category = profileName ? lookupCategory(profileName) : undefined;
  if (!category && looksAdministrative(profileName)) category = CATEGORY.FULL_ONBOARDING;
  if (!category) category = CATEGORY.NEEDS_REVIEW;

  const needsFullOnboarding = category === CATEGORY.FULL_ONBOARDING;
  return {
    training_category: category,
    follow_up_due_at: needsFullOnboarding && dateEntered ? addDays(dateEntered, days) : null,
    needs_full_onboarding: needsFullOnboarding,
  };
}

module.exports = { CATEGORY, DEFAULT_FOLLOW_UP_DAYS, followUpDays, triageNewUser, looksAdministrative, addDays };
