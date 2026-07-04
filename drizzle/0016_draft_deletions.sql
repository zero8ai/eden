-- Deletion drafts: content NULL means "stage this path for deletion" so deletes stack in
-- the same staged change-set as edits (one publish/ship = one change request).
ALTER TABLE "draft_changes" ALTER COLUMN "content" DROP NOT NULL;
