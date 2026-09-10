/**
 * Shared Prisma error predicates for the maintenance scripts.
 *
 * Kept deliberately narrow. A previous version of this check matched any error
 * whose message merely mentioned "SystemSetting", which also swallowed
 * missing-COLUMN errors from schema drift - so a settings snapshot silently came
 * back empty and the reset that followed destroyed the settings it had failed to
 * read. Only a genuinely absent table may be treated as "nothing to snapshot".
 */

// P2021: "The table does not exist in the current database."
const PRISMA_TABLE_NOT_FOUND = 'P2021';

function isMissingTableError(error) {
	return Boolean(error) && error.code === PRISMA_TABLE_NOT_FOUND;
}

module.exports = { isMissingTableError, PRISMA_TABLE_NOT_FOUND };
