import { prisma } from '@/lib/prisma';
import { getArchivedEntityIdSet } from '@/lib/archive-entities';
import { getSystemBranding } from '@/lib/system-settings';
import { sanitizeRichTextHtml } from '@/lib/rich-text';
import { isPlaceholderClient } from '@/lib/default-client';

function isPositiveInteger(value) {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0;
}

function toIsoDateTime(value) {
	if (!value) return null;
	const parsed = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(parsed.getTime())) return null;
	return parsed.toISOString();
}

function buildCareerLocation(job) {
	const city = String(job?.city || '').trim();
	const state = String(job?.state || '').trim();
	const zipCode = String(job?.zipCode || '').trim();
	if (city && state && zipCode) {
		return `${city}, ${state} ${zipCode}`;
	}
	if (city && state) {
		return `${city}, ${state}`;
	}
	if (city && zipCode) {
		return `${city} ${zipCode}`;
	}
	if (state && zipCode) {
		return `${state} ${zipCode}`;
	}
	if (city) return city;
	if (state) return state;
	if (zipCode) return zipCode;
	return job?.location || '';
}

export function stripHtmlToText(value) {
	return String(value || '')
		.replace(/<[^>]*>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

export function toTeaser(value, max = 220) {
	const plain = stripHtmlToText(value);
	if (!plain) return '';
	if (plain.length <= max) return plain;
	return `${plain.slice(0, max - 1)}…`;
}

// The per-division "Unassigned" placeholder client must never be shown
// publicly; the careers pages fall back to their own "no client" labels.
function toPublicClient(client, fields) {
	if (!client || isPlaceholderClient(client)) return null;
	return Object.fromEntries(fields.map((field) => [field, client[field]]));
}

export function normalizeListJob(job) {
	return {
		id: job.id,
		title: job.title,
		location: buildCareerLocation(job),
		employmentType: job.employmentType,
		teaser: toTeaser(job.publicDescription),
		publishedAt: toIsoDateTime(job.publishedAt),
		openedAt: toIsoDateTime(job.openedAt),
		client: toPublicClient(job.client, ['name', 'industry'])
	};
}

export function normalizeDetailJob(job) {
	return {
		id: job.id,
		title: job.title,
		location: buildCareerLocation(job),
		employmentType: job.employmentType,
		publicDescription: sanitizeRichTextHtml(job.publicDescription) ?? '',
		teaser: toTeaser(job.publicDescription),
		publishedAt: toIsoDateTime(job.publishedAt),
		openedAt: toIsoDateTime(job.openedAt),
		client: toPublicClient(job.client, ['name', 'industry', 'website']),
		applicationQuestions: Array.isArray(job.applicationQuestions) ? job.applicationQuestions : []
	};
}

async function isCareerSitePublicEnabled() {
	const branding = await getSystemBranding();
	return Boolean(branding?.careerSiteEnabled);
}

export async function listPublicCareerJobs() {
	if (!(await isCareerSitePublicEnabled())) {
		return [];
	}

	try {
		const archivedJobOrderIds = await getArchivedEntityIdSet('JOB_ORDER');
		const jobs = await prisma.jobOrder.findMany({
			where: {
				publishToCareerSite: true,
				status: 'open',
				...(archivedJobOrderIds.size > 0 ? { id: { notIn: [...archivedJobOrderIds] } } : {})
			},
			orderBy: [{ publishedAt: 'desc' }, { updatedAt: 'desc' }],
			select: {
				id: true,
				title: true,
				location: true,
				city: true,
				state: true,
				zipCode: true,
				employmentType: true,
				publicDescription: true,
				publishedAt: true,
				openedAt: true,
				client: {
					select: {
						name: true,
						industry: true
					}
				}
			}
		});

		return jobs.map(normalizeListJob);
	} catch {
		return [];
	}
}

export async function getPublicCareerJobById(id) {
	if (!isPositiveInteger(id)) return null;
	if (!(await isCareerSitePublicEnabled())) return null;

	try {
		const archivedJobOrderIds = await getArchivedEntityIdSet('JOB_ORDER');
		if (archivedJobOrderIds.has(Number(id))) {
			return null;
		}

		const job = await prisma.jobOrder.findFirst({
			where: {
				id: Number(id),
				publishToCareerSite: true,
				status: 'open'
			},
			select: {
				id: true,
				title: true,
				location: true,
				city: true,
				state: true,
				zipCode: true,
				employmentType: true,
				publicDescription: true,
				applicationQuestions: true,
				publishedAt: true,
				openedAt: true,
				client: {
					select: {
						name: true,
						industry: true,
						website: true
					}
				}
			}
		});

		if (!job) return null;
		return normalizeDetailJob(job);
	} catch {
		return null;
	}
}

export async function listPublicCareerSitemapJobs() {
	if (!(await isCareerSitePublicEnabled())) {
		return [];
	}

	try {
		const archivedJobOrderIds = await getArchivedEntityIdSet('JOB_ORDER');
		const jobs = await prisma.jobOrder.findMany({
			where: {
				publishToCareerSite: true,
				status: 'open',
				...(archivedJobOrderIds.size > 0 ? { id: { notIn: [...archivedJobOrderIds] } } : {})
			},
			orderBy: [{ publishedAt: 'desc' }, { updatedAt: 'desc' }],
			select: {
				id: true,
				updatedAt: true,
				publishedAt: true,
				openedAt: true
			}
		});

		return jobs.map((job) => ({
			id: job.id,
			lastModified: toIsoDateTime(job.updatedAt || job.publishedAt || job.openedAt)
		}));
	} catch {
		return [];
	}
}
