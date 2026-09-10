-- The weighted criteria template. Global and admin-editable, like
-- CustomFieldDefinition: a job order inherits this set unless it has
-- specialised its own copy into JobOrder.matchCriteria.
CREATE TABLE `MatchCriterion` (
	`id` INTEGER NOT NULL AUTO_INCREMENT,
	`recordId` VARCHAR(191) NOT NULL,
	`key` VARCHAR(191) NOT NULL,
	`label` VARCHAR(191) NOT NULL,
	`description` TEXT NULL,
	`evaluatorKey` VARCHAR(191) NOT NULL,
	`weight` INTEGER NOT NULL DEFAULT 20,
	`options` JSON NULL,
	`aiEnabled` BOOLEAN NOT NULL DEFAULT true,
	`isActive` BOOLEAN NOT NULL DEFAULT true,
	`sortOrder` INTEGER NOT NULL DEFAULT 0,
	`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updatedAt` DATETIME(3) NOT NULL,

	UNIQUE INDEX `MatchCriterion_recordId_key`(`recordId`),
	UNIQUE INDEX `MatchCriterion_key_key`(`key`),
	INDEX `MatchCriterion_isActive_sortOrder_idx`(`isActive`, `sortOrder`),
	PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The seeded default template, so a fresh deploy scores correctly before the
-- first request instead of writing on read. Weights are relative, not
-- percentages: the engine normalises them, so adding a criterion later does not
-- mean editing every other row.
--
-- recordId is written literally because the Prisma client extension that fills
-- it in only runs on create()/upsert(), never on raw SQL. The values use the
-- same alphabet as lib/record-id.js, which excludes I, O, 0 and 1.
--
-- big_company and university seed with empty reference lists on purpose. Until
-- an admin lists the employers or schools that matter to them, those criteria
-- report "not assessed" rather than inventing a number, and the score says how
-- much of the template it actually covered.
INSERT INTO `MatchCriterion`
	(`recordId`, `key`, `label`, `description`, `evaluatorKey`, `weight`, `options`, `aiEnabled`, `isActive`, `sortOrder`, `updatedAt`)
VALUES
	('MCR-SEEDJDCR', 'jd_criteria_match', 'JD Criteria Match', 'Skills, title and keyword alignment against the job description.', 'jd_criteria_match', 40, JSON_OBJECT(), true, true, 10, CURRENT_TIMESTAMP(3)),
	('MCR-SEEDLOCN', 'location', 'Location', 'How close the candidate is to where the job is based.', 'location', 20, JSON_OBJECT('maxDistanceMiles', 50), true, true, 20, CURRENT_TIMESTAMP(3)),
	('MCR-SEEDLOCX', 'local_experience', 'Local Experience', 'Has already worked in this market.', 'local_experience', 15, JSON_OBJECT(), true, true, 30, CURRENT_TIMESTAMP(3)),
	('MCR-SEEDBIGC', 'big_company', 'Big Company', 'Experience at a large or recognised employer.', 'big_company', 15, JSON_OBJECT('referenceValues', JSON_ARRAY()), true, true, 40, CURRENT_TIMESTAMP(3)),
	('MCR-SEEDUNIV', 'university', 'University', 'Education level and institution.', 'university', 10, JSON_OBJECT('referenceValues', JSON_ARRAY(), 'degreeLevels', JSON_ARRAY()), true, true, 50, CURRENT_TIMESTAMP(3));

-- Cached AI criterion scores for one candidate/job pair. criteriaSetHash is what
-- lets a template or per-job weight change read as stale without a background
-- job: it is the hash of the criteria set that produced the row.
CREATE TABLE `CandidateJobScore` (
	`id` INTEGER NOT NULL AUTO_INCREMENT,
	`recordId` VARCHAR(191) NOT NULL,
	`scorePercent` INTEGER NULL,
	`coveragePercent` INTEGER NULL,
	`criteriaResults` JSON NOT NULL,
	`criteriaSetHash` VARCHAR(191) NOT NULL,
	`candidateUpdatedAt` DATETIME(3) NULL,
	`jobOrderUpdatedAt` DATETIME(3) NULL,
	`modelName` VARCHAR(191) NULL,
	`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updatedAt` DATETIME(3) NOT NULL,
	`candidateId` INTEGER NOT NULL,
	`jobOrderId` INTEGER NOT NULL,
	`generatedByUserId` INTEGER NULL,

	UNIQUE INDEX `CandidateJobScore_recordId_key`(`recordId`),
	INDEX `CandidateJobScore_jobOrderId_scorePercent_idx`(`jobOrderId`, `scorePercent`),
	INDEX `CandidateJobScore_candidateId_idx`(`candidateId`),
	INDEX `CandidateJobScore_generatedByUserId_idx`(`generatedByUserId`),
	UNIQUE INDEX `CandidateJobScore_candidateId_jobOrderId_key`(`candidateId`, `jobOrderId`),
	PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CandidateJobScore`
	ADD CONSTRAINT `CandidateJobScore_candidateId_fkey`
	FOREIGN KEY (`candidateId`) REFERENCES `Candidate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `CandidateJobScore`
	ADD CONSTRAINT `CandidateJobScore_jobOrderId_fkey`
	FOREIGN KEY (`jobOrderId`) REFERENCES `JobOrder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `CandidateJobScore`
	ADD CONSTRAINT `CandidateJobScore_generatedByUserId_fkey`
	FOREIGN KEY (`generatedByUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- NULL means "inherit the live template". A job order only stops tracking
-- template edits once someone deliberately specialises it, at which point the
-- full effective set is written here.
ALTER TABLE `JobOrder` ADD COLUMN `matchCriteria` JSON NULL;

-- Optional second model, used only by candidate scoring. NULL means "use the
-- standard AI model", so no existing install starts paying for a reasoning
-- model without asking for one.
ALTER TABLE `SystemSetting` ADD COLUMN `aiReasoningModel` VARCHAR(191) NULL;
