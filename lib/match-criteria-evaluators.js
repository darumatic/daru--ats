import {
	buildCandidateText,
	buildJobText,
	inferRequiredYears,
	inferYearsFromWorkExperience,
	locationScore,
	normalizeText,
	overlapRatio,
	tokenize
} from '@/lib/match-scoring';
import { haversineMiles, toGeoPoint } from '@/lib/geo-distance';
import {
	buildCriterionHash,
	computeWeightedScore,
	summarizeCriteriaResults
} from '@/lib/match-criteria';

// The deterministic half of criteria scoring: one function per evaluator, cheap
// enough to run over the whole candidate pool on a list request.
//
// Every evaluator returns { score, assessed, basis }. `assessed: false` is a
// first-class answer, not a failure - a criterion nobody configured and no data
// supports contributes nothing to the total instead of a fabricated number, and
// the caller reports coverage so the gap is visible rather than hidden.
//
// Pure: plain objects in, plain objects out, no Prisma and no network.

function asText(value) {
	return String(value ?? '').trim();
}

function toScore(ratio) {
	return Math.round(Math.max(0, Math.min(1, ratio)) * 100);
}

function unassessed(basis) {
	return { score: null, assessed: false, basis };
}

function candidateEmployerNames(candidate) {
	const history = Array.isArray(candidate?.candidateWorkExperiences) ? candidate.candidateWorkExperiences : [];
	return {
		current: asText(candidate?.currentEmployer),
		past: history.map((row) => asText(row?.companyName)).filter(Boolean)
	};
}

// Reference lists are typed by hand, so matching is containment in either
// direction: "Google" should match a stored "Google Australia Pty Ltd", and a
// reference of "Commonwealth Bank" should match "Commonwealth Bank".
function matchesReference(value, referenceValues) {
	const normalized = normalizeText(value);
	if (!normalized) return false;
	return referenceValues.some((reference) => {
		const target = normalizeText(reference);
		if (!target) return false;
		return normalized.includes(target) || target.includes(normalized);
	});
}

function jobMarketTerms(jobOrder) {
	return [jobOrder?.city, jobOrder?.state, jobOrder?.location]
		.map((value) => normalizeText(value))
		.filter((value) => value.length >= 3);
}

function jdComponents(candidate, jobOrder, context) {
	const requiredSkillIds = Array.isArray(context?.requiredSkillIds) ? context.requiredSkillIds : [];
	const allSkills = Array.isArray(context?.skills) ? context.skills : [];
	const candidateSkillIds = new Set(
		(candidate?.candidateSkills || []).map((item) => item?.skill?.id).filter(Boolean)
	);

	const matched = requiredSkillIds.filter((skillId) => candidateSkillIds.has(skillId));
	const requiredSkillsMatched = matched
		.map((skillId) => allSkills.find((skill) => skill.id === skillId)?.name)
		.filter(Boolean);
	const requiredSkillsMissing = requiredSkillIds
		.filter((skillId) => !candidateSkillIds.has(skillId))
		.map((skillId) => allSkills.find((skill) => skill.id === skillId)?.name)
		.filter(Boolean);

	const hasExplicitRequiredSkills = requiredSkillIds.length > 0;
	const requiredSkillCoverage = hasExplicitRequiredSkills ? matched.length / requiredSkillIds.length : 0.6;
	const keywordOverlap = overlapRatio(tokenize(buildJobText(jobOrder)), tokenize(buildCandidateText(candidate)));
	const titleOverlap = overlapRatio(tokenize(jobOrder?.title), tokenize(candidate?.currentJobTitle));

	const inferredYears = inferYearsFromWorkExperience(candidate?.candidateWorkExperiences);
	const requiredYears = inferRequiredYears(jobOrder);
	const experienceFit =
		requiredYears > 0
			? Math.max(0, Math.min(1, inferredYears / requiredYears))
			: Math.min(1, inferredYears / 8 || 0.4);

	return {
		hasExplicitRequiredSkills,
		requiredSkillCoverage,
		keywordOverlap,
		titleOverlap,
		experienceFit,
		inferredYears,
		requiredYears,
		requiredSkillsMatched,
		requiredSkillsMissing
	};
}

// The heuristic that used to be the whole match score, minus its location term
// (location is now a criterion in its own right) and renormalised over the
// remaining 0.95 so the surviving components keep their relative influence.
function evaluateJdCriteriaMatch({ candidate, jobOrder, context }) {
	if (!asText(jobOrder?.title) && !asText(jobOrder?.description) && !asText(jobOrder?.publicDescription)) {
		return unassessed('The job order has no title or description to match against.');
	}

	const parts = jdComponents(candidate, jobOrder, context);
	const blended = parts.hasExplicitRequiredSkills
		? (parts.requiredSkillCoverage * 0.45 +
				parts.titleOverlap * 0.2 +
				parts.keywordOverlap * 0.15 +
				parts.experienceFit * 0.15) /
			0.95
		: (parts.requiredSkillCoverage * 0.25 +
				parts.titleOverlap * 0.2 +
				parts.keywordOverlap * 0.3 +
				parts.experienceFit * 0.2) /
			0.95;

	return {
		score: toScore(blended),
		assessed: true,
		basis: parts.hasExplicitRequiredSkills
			? `Matched ${parts.requiredSkillsMatched.length} of ${parts.requiredSkillsMatched.length + parts.requiredSkillsMissing.length} required skills.`
			: 'No named skills found in the job text; scored on title and keyword overlap.',
		detail: {
			components: {
				requiredSkillCoverage: toScore(parts.requiredSkillCoverage),
				titleOverlap: toScore(parts.titleOverlap),
				keywordOverlap: toScore(parts.keywordOverlap),
				experienceFit: toScore(parts.experienceFit)
			},
			requiredSkillsMatched: parts.requiredSkillsMatched,
			requiredSkillsMissing: parts.requiredSkillsMissing
		}
	};
}

function evaluateLocation({ candidate, jobOrder, options }) {
	const jobLocationText = normalizeText(jobOrder?.location);

	if (jobLocationText.includes('remote')) {
		return { score: 100, assessed: true, basis: 'The job is remote, so location does not constrain it.' };
	}

	const jobPoint = toGeoPoint(jobOrder?.locationLatitude, jobOrder?.locationLongitude);
	const candidatePoint = toGeoPoint(candidate?.addressLatitude, candidate?.addressLongitude);
	const maxDistanceMiles = Number(options?.maxDistanceMiles) > 0 ? Number(options.maxDistanceMiles) : 50;

	if (jobPoint && candidatePoint) {
		const miles = haversineMiles(jobPoint, candidatePoint);
		return {
			score: toScore(1 - miles / maxDistanceMiles),
			assessed: true,
			basis: `${Math.round(miles)} miles from the job location (scored against a ${maxDistanceMiles} mile radius).`,
			detail: { distanceMiles: Math.round(miles), maxDistanceMiles }
		};
	}

	const hasCandidateText = Boolean(asText(candidate?.city) || asText(candidate?.state));
	if (jobLocationText && hasCandidateText) {
		return {
			score: toScore(locationScore(jobOrder, candidate)),
			assessed: true,
			basis: 'Compared on city and state text; no coordinates on file for both sides.'
		};
	}

	return unassessed(
		jobLocationText
			? 'The candidate has no city, state or coordinates on file.'
			: 'The job order has no location on file.'
	);
}

function evaluateLocalExperience({ candidate, jobOrder }) {
	const terms = jobMarketTerms(jobOrder);
	if (terms.length === 0) {
		return unassessed('The job order has no location to compare work history against.');
	}

	const history = Array.isArray(candidate?.candidateWorkExperiences) ? candidate.candidateWorkExperiences : [];
	const located = history.filter((row) => asText(row?.location));
	if (located.length === 0) {
		return unassessed('No role on the candidate’s work history records a location.');
	}

	const local = located.filter((row) => {
		const rowLocation = normalizeText(row.location);
		return terms.some((term) => rowLocation.includes(term) || term.includes(rowLocation));
	});

	return {
		score: toScore(local.length / located.length),
		assessed: true,
		basis: `${local.length} of ${located.length} located roles were in this market.`,
		detail: { localRoles: local.length, locatedRoles: located.length }
	};
}

function evaluateBigCompany({ candidate, options }) {
	const referenceValues = Array.isArray(options?.referenceValues) ? options.referenceValues.filter(Boolean) : [];
	if (referenceValues.length === 0) {
		return unassessed('No employer list configured for this criterion, so only AI can judge it.');
	}

	const { current, past } = candidateEmployerNames(candidate);
	if (!current && past.length === 0) {
		return unassessed('The candidate has no current or past employer on file.');
	}

	if (current && matchesReference(current, referenceValues)) {
		return { score: 100, assessed: true, basis: `Currently at ${current}, which is on the list.` };
	}

	const pastMatch = past.find((name) => matchesReference(name, referenceValues));
	if (pastMatch) {
		return { score: 75, assessed: true, basis: `Previously at ${pastMatch}, which is on the list.` };
	}

	return { score: 0, assessed: true, basis: 'No employer on file appears on the list.' };
}

const DEGREE_LEVEL_PATTERNS = {
	associate: /\bassociate|\ba\.?a\.?\b|\bdiploma\b/i,
	bachelor: /\bbachelor|\bb\.?(s|a|sc|eng|com)\b|\bundergraduate\b/i,
	master: /\bmaster|\bm\.?(s|a|sc|ba|eng)\b|\bmba\b|\bpostgraduate\b/i,
	doctorate: /\bdoctor|\bph\.?d\b|\bdphil\b/i
};

function evaluateUniversity({ candidate, options }) {
	const referenceValues = Array.isArray(options?.referenceValues) ? options.referenceValues.filter(Boolean) : [];
	const degreeLevels = Array.isArray(options?.degreeLevels) ? options.degreeLevels.filter(Boolean) : [];

	if (referenceValues.length === 0 && degreeLevels.length === 0) {
		return unassessed('No school list or degree level configured, so only AI can judge it.');
	}

	const educations = Array.isArray(candidate?.candidateEducations) ? candidate.candidateEducations : [];
	if (educations.length === 0) {
		return unassessed('The candidate has no education history on file.');
	}

	const checks = [];
	const reasons = [];

	if (referenceValues.length > 0) {
		const school = educations.find((row) => matchesReference(row?.schoolName, referenceValues));
		checks.push(school ? 1 : 0);
		reasons.push(school ? `Studied at ${asText(school.schoolName)}.` : 'No listed school on file.');
	}

	if (degreeLevels.length > 0) {
		const degreeText = educations.map((row) => `${asText(row?.degree)} ${asText(row?.fieldOfStudy)}`).join(' ');
		const met = degreeLevels.find((level) => DEGREE_LEVEL_PATTERNS[level]?.test(degreeText));
		checks.push(met ? 1 : 0);
		reasons.push(met ? `Holds a ${met} level qualification.` : 'No qualification at the required level.');
	}

	return {
		score: toScore(checks.reduce((sum, value) => sum + value, 0) / checks.length),
		assessed: true,
		basis: reasons.join(' ')
	};
}

function evaluateExperienceYears({ candidate, jobOrder }) {
	const stated = Number(candidate?.experienceYears);
	const years = Number.isFinite(stated) && stated > 0
		? stated
		: inferYearsFromWorkExperience(candidate?.candidateWorkExperiences);

	if (!(years > 0)) {
		return unassessed('The candidate has no stated years of experience and no dated work history.');
	}

	const requiredYears = inferRequiredYears(jobOrder);
	if (requiredYears <= 0) {
		return {
			score: toScore(Math.min(1, years / 8)),
			assessed: true,
			basis: `${years.toFixed(1)} years of experience; the job states no target.`
		};
	}

	return {
		score: toScore(years / requiredYears),
		assessed: true,
		basis: `${years.toFixed(1)} years against a ${requiredYears}+ year target.`,
		detail: { years: Number(years.toFixed(1)), requiredYears }
	};
}

function evaluateSkillsCoverage({ candidate, jobOrder, context }) {
	const requiredSkillIds = Array.isArray(context?.requiredSkillIds) ? context.requiredSkillIds : [];
	if (requiredSkillIds.length === 0) {
		return unassessed('No known skills were named in the job text.');
	}

	const parts = jdComponents(candidate, jobOrder, context);
	return {
		score: toScore(parts.requiredSkillCoverage),
		assessed: true,
		basis: `Has ${parts.requiredSkillsMatched.length} of ${requiredSkillIds.length} required skills.`,
		detail: {
			requiredSkillsMatched: parts.requiredSkillsMatched,
			requiredSkillsMissing: parts.requiredSkillsMissing
		}
	};
}

export const MATCH_EVALUATORS = Object.freeze({
	jd_criteria_match: evaluateJdCriteriaMatch,
	location: evaluateLocation,
	local_experience: evaluateLocalExperience,
	big_company: evaluateBigCompany,
	university: evaluateUniversity,
	experience_years: evaluateExperienceYears,
	skills_coverage: evaluateSkillsCoverage
});

/**
 * Scores one candidate against one job order for every criterion in the set.
 *
 * A criterion naming an evaluator this build does not have is reported as
 * unassessed rather than skipped, so a row written by a newer version stays
 * visible in the breakdown instead of quietly changing the denominator.
 */
export function evaluateCriteria({ criteria, candidate, jobOrder, skills, requiredSkillIds }) {
	const context = { skills, requiredSkillIds };

	return (Array.isArray(criteria) ? criteria : []).map((criterion) => {
		const evaluator = MATCH_EVALUATORS[criterion?.evaluatorKey];
		const outcome = evaluator
			? evaluator({ candidate, jobOrder, context, options: criterion?.options || {} })
			: unassessed(`No evaluator named "${criterion?.evaluatorKey}" in this build.`);

		return {
			key: criterion?.key,
			label: criterion?.label,
			weight: criterion?.weight,
			source: outcome.assessed ? 'rule' : 'none',
			...outcome
		};
	});
}

/**
 * Lays a cached AI judgement over the deterministic result, criterion by
 * criterion.
 *
 * A stored judgement is reused only while the criterion still means what it
 * meant when the judgement was made, which is what the per-criterion hash
 * records. Because weight is not part of that hash, re-weighting a criterion
 * keeps every AI judgement and only changes the arithmetic - nobody pays twice
 * to score the same thing.
 */
export function mergeCriteriaResults({ deterministic, overlay, criteria }) {
	const stored = new Map(
		(Array.isArray(overlay?.criteriaResults) ? overlay.criteriaResults : []).map((row) => [row?.key, row])
	);
	const criterionByKey = new Map((Array.isArray(criteria) ? criteria : []).map((row) => [row?.key, row]));

	let usedAi = false;
	const results = (Array.isArray(deterministic) ? deterministic : []).map((row) => {
		const criterion = criterionByKey.get(row.key);
		const cached = stored.get(row.key);
		if (!criterion || !cached || cached.criterionHash !== buildCriterionHash(criterion)) return row;
		if (!cached.assessed || !Number.isFinite(Number(cached.score))) return row;

		usedAi = true;
		return {
			...row,
			score: Math.max(0, Math.min(100, Math.round(Number(cached.score)))),
			assessed: true,
			source: 'ai',
			basis: cached.rationale || row.basis
		};
	});

	return { results, usedAi };
}

/**
 * The whole score for one candidate against one job order.
 *
 * Both match routes call this, which is what keeps the two directions of the
 * question answering it identically.
 */
export function scoreCandidateForJobOrder({
	candidate,
	jobOrder,
	criteria,
	skills,
	requiredSkillIds,
	overlay = null
}) {
	const deterministic = evaluateCriteria({ criteria, candidate, jobOrder, skills, requiredSkillIds });
	const { results, usedAi } = mergeCriteriaResults({ deterministic, overlay, criteria });
	const totals = computeWeightedScore(results);
	const { reasons, risks } = summarizeCriteriaResults(results);

	return {
		scorePercent: totals.scorePercent,
		coveragePercent: totals.coveragePercent,
		criteriaResults: results,
		hasAiScore: usedAi,
		reasons,
		risks
	};
}
