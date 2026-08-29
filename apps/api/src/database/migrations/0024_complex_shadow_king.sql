CREATE INDEX "note_shares_created_by_id_idx" ON "note_shares" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX "notes_workspace_title_idx" ON "notes" USING btree ("workspace_id","title") WHERE notes.is_deleted = false;--> statement-breakpoint
CREATE INDEX "notes_workspace_created_idx" ON "notes" USING btree ("workspace_id","created_at") WHERE notes.is_deleted = false;--> statement-breakpoint
CREATE INDEX "notes_board_column_id_idx" ON "notes" USING btree ("board_column_id");