ALTER TABLE "model_provider_connections" ADD COLUMN "api_key_ciphertext" text;--> statement-breakpoint
ALTER TABLE "model_provider_connections" ADD COLUMN "api_key_iv" text;--> statement-breakpoint
ALTER TABLE "model_provider_connections" ADD COLUMN "api_key_auth_tag" text;--> statement-breakpoint
DO $migration$
DECLARE
	settings_row record;
	connection_id text;
BEGIN
	FOR settings_row IN
		SELECT *
		FROM "workspace_settings"
		WHERE "model_key_ciphertext" IS NOT NULL
			AND "model_key_iv" IS NOT NULL
			AND "model_key_auth_tag" IS NOT NULL
		FOR UPDATE
	LOOP
		-- Mint the same 12-lowercase-letter shape as app/lib/id.ts, retrying on any collision.
		LOOP
			SELECT string_agg(chr(97 + floor(random() * 26)::integer), '' ORDER BY n)
			INTO connection_id
			FROM generate_series(1, 12) AS chars(n);
			EXIT WHEN NOT EXISTS (
				SELECT 1 FROM "model_provider_connections" WHERE "id" = connection_id
			);
		END LOOP;

		INSERT INTO "model_provider_connections" (
			"id",
			"org_id",
			"provider",
			"label",
			"api_key_ciphertext",
			"api_key_iv",
			"api_key_auth_tag",
			"status"
		) VALUES (
			connection_id,
			settings_row."org_id",
			'openrouter',
			'OpenRouter',
			settings_row."model_key_ciphertext",
			settings_row."model_key_iv",
			settings_row."model_key_auth_tag",
			'active'
		);

		-- Phase 1 could already have selected an owned Codex model; keep that exact reference.
		IF settings_row."assistant_model" ~ '^codex/[a-z]{12}/.+$' AND EXISTS (
			SELECT 1
			FROM "model_provider_connections" AS codex_connection
			WHERE codex_connection."id" = split_part(settings_row."assistant_model", '/', 2)
				AND codex_connection."org_id" = settings_row."org_id"
				AND codex_connection."provider" = 'codex'
				AND codex_connection."status" = 'active'
		) THEN
			NULL;
		ELSIF settings_row."assistant_model" IS NULL THEN
			UPDATE "workspace_settings"
			SET "assistant_model" = 'openrouter/' || connection_id || '/z-ai/glm-5.2',
				"updated_at" = now()
			WHERE "org_id" = settings_row."org_id";
		ELSIF settings_row."assistant_model" ~ '^codex/[a-z]{12}/.+$' THEN
			-- A strict Codex-shaped reference that was not preserved above is forged or stale.
			UPDATE "workspace_settings"
			SET "assistant_model" = NULL,
				"updated_at" = now()
			WHERE "org_id" = settings_row."org_id";
		ELSE
			UPDATE "workspace_settings"
			SET "assistant_model" = 'openrouter/' || connection_id || '/' || settings_row."assistant_model",
				"updated_at" = now()
			WHERE "org_id" = settings_row."org_id";
		END IF;

		-- Playground overrides are persisted separately from the workspace default. Qualify every
		-- legacy bare OpenRouter id with the same migrated connection; preserve only an active,
		-- workspace-owned Codex reference and clear any other pre-qualified/forged value.
		UPDATE "playground_sessions" AS session
		SET "model_id" = CASE
				WHEN session."model_id" ~ '^codex/[a-z]{12}/.+$' AND EXISTS (
					SELECT 1
					FROM "model_provider_connections" AS codex_connection
					WHERE codex_connection."id" = split_part(session."model_id", '/', 2)
						AND codex_connection."org_id" = settings_row."org_id"
						AND codex_connection."provider" = 'codex'
						AND codex_connection."status" = 'active'
				) THEN session."model_id"
				WHEN session."model_id" ~ '^codex/[a-z]{12}/.+$' THEN NULL
				ELSE 'openrouter/' || connection_id || '/' || session."model_id"
			END,
			"updated_at" = now()
		FROM "projects" AS project
		WHERE session."project_id" = project."id"
			AND project."org_id" = settings_row."org_id"
			AND session."model_id" IS NOT NULL;
	END LOOP;

	-- A legacy bare/default reference has no credential owner when no complete key was migrated.
	UPDATE "workspace_settings" AS settings
	SET "assistant_model" = NULL,
		"updated_at" = now()
	WHERE NOT (
		settings."model_key_ciphertext" IS NOT NULL
		AND settings."model_key_iv" IS NOT NULL
		AND settings."model_key_auth_tag" IS NOT NULL
	)
		AND settings."assistant_model" IS NOT NULL
		AND NOT (
			settings."assistant_model" ~ '^codex/[a-z]{12}/.+$'
			AND EXISTS (
				SELECT 1
				FROM "model_provider_connections" AS codex_connection
				WHERE codex_connection."id" = split_part(settings."assistant_model", '/', 2)
					AND codex_connection."org_id" = settings."org_id"
					AND codex_connection."provider" = 'codex'
					AND codex_connection."status" = 'active'
			)
		);

	-- Clear any playground model that was not qualified above and is not backed by an active
	-- connection owned by the session's project workspace (including orgs with no settings row).
	UPDATE "playground_sessions" AS session
	SET "model_id" = NULL,
		"updated_at" = now()
	FROM "projects" AS project
	WHERE session."project_id" = project."id"
		AND session."model_id" IS NOT NULL
		AND NOT (
			session."model_id" ~ '^(openrouter|anthropic|openai|codex)/[a-z]{12}/.+$'
			AND EXISTS (
				SELECT 1
				FROM "model_provider_connections" AS connection
				WHERE connection."id" = split_part(session."model_id", '/', 2)
					AND connection."org_id" = project."org_id"
					AND connection."provider" = split_part(session."model_id", '/', 1)
					AND connection."status" = 'active'
			)
		);
END
$migration$;--> statement-breakpoint
ALTER TABLE "workspace_settings" DROP COLUMN "model_key_ciphertext";--> statement-breakpoint
ALTER TABLE "workspace_settings" DROP COLUMN "model_key_iv";--> statement-breakpoint
ALTER TABLE "workspace_settings" DROP COLUMN "model_key_auth_tag";
