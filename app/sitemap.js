import { listPublicCareerSitemapJobs } from '@/lib/careers-public';
import { getPublicAppBaseUrl } from '@/lib/site-url';
import { getSystemBranding } from '@/lib/system-settings';

// Reads system settings at request time. Statically generated, this would be
// baked from the build-time settings skip, which reads as "careers disabled" —
// permanently telling crawlers to ignore the careers site.
export const dynamic = 'force-dynamic';

export default async function sitemap() {
	const branding = await getSystemBranding();
	if (!branding?.careerSiteEnabled) {
		return [];
	}

	const baseUrl = getPublicAppBaseUrl();
	const jobs = await listPublicCareerSitemapJobs();
	const now = new Date();

	const careerEntries = [
		{
			url: `${baseUrl}/careers`,
			lastModified: now,
			changeFrequency: 'hourly',
			priority: 1
		}
	];

	const jobEntries = jobs.map((job) => ({
		url: `${baseUrl}/careers/jobs/${job.id}`,
		lastModified: job.lastModified ? new Date(job.lastModified) : now,
		changeFrequency: 'daily',
		priority: 0.9
	}));

	return [...careerEntries, ...jobEntries];
}
