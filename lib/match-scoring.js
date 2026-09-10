// Shared text/heuristic helpers behind candidate<->job-order matching.
//
// Both match routes need the identical set, and for a long time both carried
// their own byte-for-byte copy of it, so a fix applied to one side silently
// left the other behind. They live here so the two directions of the same
// question - "who fits this job" and "which jobs fit this candidate" - cannot
// answer it differently.
//
// Dependency-free on purpose: the scoring engine built on top of this is pure,
// and keeping Prisma out means it stays testable without a database.

export function toBooleanParam(value, fallback = false) {
	if (value == null) return fallback;
	const normalized = String(value).trim().toLowerCase();
	return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export function toMatchLimit(value, fallback = 10) {
	const parsed = Number.parseInt(String(value ?? ''), 10);
	if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
	return Math.min(parsed, 100);
}

export function normalizeText(value) {
	return String(value || '')
		.toLowerCase()
		.replace(/<[^>]*>/g, ' ')
		.replace(/[^a-z0-9+\-#.\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

export function tokenize(value) {
	return normalizeText(value)
		.split(' ')
		.filter((token) => token.length >= 2);
}

export function unique(values) {
	return [...new Set(values.filter(Boolean))];
}

// Asymmetric on purpose: the first argument is the denominator, so
// overlapRatio(jobTokens, candidateTokens) reads as "how much of the job the
// candidate covers", not the reverse.
export function overlapRatio(a, b) {
	if (a.length === 0 || b.length === 0) return 0;
	const aSet = new Set(a);
	const bSet = new Set(b);
	let overlap = 0;
	for (const value of aSet) {
		if (bSet.has(value)) overlap += 1;
	}
	return overlap / Math.max(aSet.size, 1);
}

export function inferYearsFromWorkExperience(records) {
	if (!Array.isArray(records) || records.length === 0) return 0;
	const now = new Date();
	const ranges = records
		.map((record) => {
			const start = record?.startDate ? new Date(record.startDate) : null;
			const end = record?.isCurrent ? now : record?.endDate ? new Date(record.endDate) : now;
			if (!start || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
			if (end <= start) return null;
			return (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
		})
		.filter((years) => Number.isFinite(years) && years > 0);

	if (ranges.length === 0) return 0;
	return Math.min(30, ranges.reduce((sum, value) => sum + value, 0));
}

export function inferRequiredYears(jobOrder) {
	const text = `${jobOrder?.title || ''} ${jobOrder?.description || ''}`;
	const match = normalizeText(text).match(/(\d{1,2})\s*\+?\s*(years|yrs|year)/);
	if (!match) return 0;
	const years = Number.parseInt(match[1], 10);
	if (!Number.isFinite(years) || years <= 0) return 0;
	return Math.min(years, 20);
}

export function buildCandidateText(candidate) {
	const candidateSkillNames = Array.isArray(candidate?.candidateSkills)
		? candidate.candidateSkills.map((item) => item?.skill?.name)
		: [];
	const workTitles = Array.isArray(candidate?.candidateWorkExperiences)
		? candidate.candidateWorkExperiences.map((item) => item?.title)
		: [];

	return [
		candidate?.currentJobTitle,
		candidate?.currentEmployer,
		candidate?.summary,
		candidate?.skillSet,
		...candidateSkillNames,
		...workTitles
	]
		.filter(Boolean)
		.join(' ');
}

export function buildJobText(jobOrder) {
	return [
		jobOrder?.title,
		jobOrder?.description,
		jobOrder?.publicDescription,
		jobOrder?.employmentType,
		jobOrder?.location
	]
		.filter(Boolean)
		.join(' ');
}

export function findJobSkillIds(jobText, skills) {
	const normalizedJobText = normalizeText(jobText);
	const matched = [];
	for (const skill of skills) {
		const normalizedSkillName = normalizeText(skill.name);
		if (!normalizedSkillName) continue;
		if (normalizedJobText.includes(normalizedSkillName)) {
			matched.push(skill.id);
		}
	}
	return unique(matched);
}

export function locationScore(jobOrder, candidate) {
	const jobLocation = normalizeText(jobOrder?.location || '');
	if (!jobLocation) return 0.6;
	if (jobLocation.includes('remote')) return 1;
	if (jobLocation.includes('hybrid')) return 0.8;

	const candidateCity = normalizeText(candidate?.city || '');
	const candidateState = normalizeText(candidate?.state || '');
	if (!candidateCity && !candidateState) return 0.25;

	if (candidateCity && jobLocation.includes(candidateCity)) return 1;
	if (candidateState && jobLocation.includes(candidateState)) return 0.85;
	return 0.35;
}

export function toPercent(value) {
	return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

export function buildReasons({
	requiredSkillsMatched,
	requiredSkillsMissing,
	experienceYears,
	requiredYears,
	locationFit,
	titleOverlap
}) {
	const reasons = [];
	const risks = [];

	if (requiredSkillsMatched.length > 0) {
		reasons.push(`Matched skills: ${requiredSkillsMatched.join(', ')}`);
	}

	if (requiredSkillsMissing.length > 0) {
		risks.push(`Missing skills: ${requiredSkillsMissing.join(', ')}`);
	}

	if (requiredYears > 0) {
		if (experienceYears >= requiredYears) {
			reasons.push(`Experience fit: ${experienceYears.toFixed(1)} years vs ${requiredYears}+ target`);
		} else {
			risks.push(`Experience gap: ${experienceYears.toFixed(1)} years vs ${requiredYears}+ target`);
		}
	}

	if (titleOverlap >= 0.5) {
		reasons.push('Strong title alignment with job order');
	} else if (titleOverlap <= 0.1) {
		risks.push('Low title alignment');
	}

	if (locationFit < 0.4) {
		risks.push('Potential location mismatch');
	}

	return { reasons, risks };
}
