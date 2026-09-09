-- Provider selection for the AI features. The API key column is unchanged and
-- keeps its original name (mapped to `aiApiKey` in the Prisma schema), so
-- existing keys survive. A NULL `aiProvider` is read as OpenAI, which is how
-- every row behaved before this migration.
ALTER TABLE `SystemSetting`
	ADD COLUMN `aiProvider` VARCHAR(191) NULL,
	ADD COLUMN `aiModel` VARCHAR(191) NULL;
