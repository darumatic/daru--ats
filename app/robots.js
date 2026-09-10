import { getPublicAppBaseUrl } from '@/lib/site-url';
import { readSystemSettingRecord, serializeSystemBranding } from '@/lib/system-settings';

// Reads system settings at request time. Statically generated, this would be
// baked from the build-time settings skip, which reads as "careers disabled" —
// permanently telling crawlers to ignore the careers site.
export const dynamic = 'force-dynamic';

export default async function robots() {
	const baseUrl = getPublicAppBaseUrl();
	const settingsRead = await readSystemSettingRecord();
	const branding = serializeSystemBranding(settingsRead.setting);
	const careerSiteEnabled = Boolean(branding?.careerSiteEnabled);

	// If the settings could not be READ, the career site's state is unknown - and
	// publishing a de-indexing directive on a guess is not recoverable on the
	// same timescale as the fault. Dropping out of a search index takes days to
	// weeks to undo, so an unknown state omits the disallow rather than asserting
	// one. An enabled site is still only advertised when we positively know it.
	const settingsUnknown = !settingsRead.ok;

	return {
		rules: [
			{
				userAgent: '*',
				allow: careerSiteEnabled ? ['/careers', '/careers/jobs/'] : ['/'],
				disallow: [
					'/api/',
					'/admin/',
					'/login',
					'/forgot-password',
					'/reset-password',
					'/account/',
					...(careerSiteEnabled || settingsUnknown ? [] : ['/careers', '/careers/'])
				]
			}
		],
		sitemap: `${baseUrl}/sitemap.xml`
	};
}
